import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCatalog } from '../server/catalog.mjs';
import { createMarketHttp } from '../server/http.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-market-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seed = JSON.parse(await fs.readFile(new URL('../releases/catalog.json', import.meta.url), 'utf8')).releases[0];
  const bytes = Buffer.from('test package bytes');
  const release = { ...seed, sha256: createHash('sha256').update(bytes).digest('hex') };
  const older = { ...release, version: '0.0.1', manifest: { ...release.manifest, version: '0.0.1' }, package: 'older.dwp' };
  await fs.writeFile(path.join(root, release.package), bytes);
  await fs.writeFile(path.join(root, older.package), bytes);
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ protocol: 1, releases: [older, release] }));
  const catalog = createCatalog(root), server = createMarketHttp(catalog);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { root, release, bytes, catalog, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP search groups versions, details and catalog/download keep manifest and digest consistent', async t => {
  const f = await fixture(t);
  const search = await (await fetch(f.base + '/api/plugins?query=' + encodeURIComponent(f.release.manifest.name))).json();
  assert.equal(search.total, 1); assert.equal(search.items[0].version, f.release.version);
  const versions = await (await fetch(f.base + `/api/plugins/${f.release.id}/versions`)).json();
  assert.deepEqual(versions.releases.map(r => r.version), [f.release.version, '0.0.1']);
  const detail = await (await fetch(f.base + `/api/plugins/${f.release.id}?version=0.0.1`)).json();
  assert.equal(detail.version, '0.0.1');
  const catalog = await (await fetch(f.base + '/catalog.json')).json(); assert.equal(catalog.releases.length, 2);
  const download = await fetch(f.base + '/' + f.release.package);
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), f.bytes);
  const head = await fetch(f.base + '/' + f.release.package, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(f.bytes.length)); assert.equal(await head.text(), '');
});

test('HTTP refuses invalid input, foreign hosts/origins, mutations, symlinks and corrupt packages', async t => {
  const f = await fixture(t);
  for (const route of ['/api/plugins?limit=0', '/api/plugins?category=bad', '/api/plugins?query=a&query=b']) assert.equal((await fetch(f.base + route)).status, 400);
  assert.equal((await fetch(f.base + '/api/plugins/missing')).status, 404);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(f.base + '/', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(f.base + '/', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await fetch(f.base + '/api/plugins', { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  await fs.writeFile(path.join(f.root, f.release.package), 'tampered');
  assert.equal((await fetch(f.base + '/' + f.release.package)).status, 503);
  await fs.unlink(path.join(f.root, f.release.package)); await fs.symlink(path.join(f.root, 'older.dwp'), path.join(f.root, f.release.package));
  assert.equal((await fetch(f.base + '/' + f.release.package)).status, 503);
  await fs.writeFile(path.join(f.root, 'catalog.json'), '{}');
  assert.equal((await fetch(f.base + '/catalog.json')).status, 503);
});

async function exerciseClient(client, f) {
  const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
  assert.ok(tools.tools.every(tool => tool.annotations.readOnlyHint));
  const search = await client.callTool({ name: 'market_search', arguments: {} });
  assert.deepEqual(search.structuredContent, await f.catalog.search());
  const detail = await client.callTool({ name: 'market_detail', arguments: { id: f.release.id } });
  assert.equal(detail.structuredContent.version, f.release.version);
  const versions = await client.callTool({ name: 'market_versions', arguments: { id: f.release.id } });
  assert.equal(versions.structuredContent.releases.length, 2);
  const missing = await client.callTool({ name: 'market_detail', arguments: { id: 'missing' } }); assert.equal(missing.isError, true);
  const pkg = await client.callTool({ name: 'market_package', arguments: { id: f.release.id } });
  assert.equal(pkg.structuredContent.sha256, f.release.sha256);
  const data = await client.readResource({ uri: pkg.structuredContent.resourceUri });
  assert.deepEqual(Buffer.from(data.contents[0].blob, 'base64'), f.bytes);
  const catalog = await client.readResource({ uri: 'plugin-market://catalog' });
  assert.equal(JSON.parse(catalog.contents[0].text).releases.length, 2);
}

test('official MCP client initializes and reads identical market data through Streamable HTTP', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'market-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp')));
  await exerciseClient(client, f);
});

test('official MCP client initializes and downloads packages through stdio without HTTP service', async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../server/index.mjs', import.meta.url).pathname, '--transport', 'mcp', '--releases-dir', f.root], stderr: 'pipe' });
  const client = new Client({ name: 'market-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(transport); await exerciseClient(client, f);
});

test('CLI defaults to HTTP, honors port and exits cleanly on SIGTERM', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname, '--port', '0', '--releases-dir', f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let logs = '';
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
    child.stderr.on('data', chunk => { logs += chunk; const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('early exit: ' + logs)); });
  });
  assert.equal((await (await fetch(address + '/health')).json()).transport, 'http');
  const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
});
