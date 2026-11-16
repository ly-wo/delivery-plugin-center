import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCatalog } from './catalog.mjs';
import { createMarketMcp } from './mcp.mjs';
import { createMarketHttp } from './http.mjs';

const { values } = parseArgs({ args: process.argv.slice(2).filter(value => value !== '--'), options: { transport: { type: 'string', default: 'http' }, port: { type: 'string' }, host: { type: 'string' }, 'releases-dir': { type: 'string' }, 'public-url': { type: 'string' } } });
const transport = values.transport;
if (!['http', 'mcp', 'stdio'].includes(transport)) throw new Error('transport 必须为 http 或 mcp（stdio）');
const releases = values['releases-dir'] || process.env.PLUGIN_MARKET_RELEASES_DIR || fileURLToPath(new URL('../releases', import.meta.url));
const publicUrl = values['public-url'] || process.env.PLUGIN_MARKET_PUBLIC_URL;
if (publicUrl) {
  const url = new URL(publicUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('public-url 必须为无凭据、无路径的 HTTP(S) 来源地址');
}
const normalizedUrl = publicUrl ? new URL(publicUrl).origin : undefined;
const catalog = createCatalog(path.resolve(releases));
// Fail startup on broken metadata. Neither transport installs or executes packages.
await catalog.catalog();
if (transport === 'http') {
  const port = Number(values.port || process.env.PLUGIN_MARKET_PORT || 5499);
  const host = values.host || process.env.PLUGIN_MARKET_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  if (!['127.0.0.1', 'localhost'].includes(host) && !normalizedUrl) throw new Error('非回环监听必须配置 public-url');
  const server = createMarketHttp(catalog, { publicUrl: normalizedUrl });
  server.listen(port, host, () => console.error(`插件市场 HTTP：http://${host}:${server.address().port}；MCP：/mcp`));
  const stop = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000); timeout.unref(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} else {
  const server = createMarketMcp(catalog, normalizedUrl);
  await server.connect(new StdioServerTransport());
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.stdin.once('end', stop);
}
