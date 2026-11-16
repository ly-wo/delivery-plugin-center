import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createMarketMcp } from './mcp.mjs';
import { MarketError } from './catalog.mjs';

export function createMarketHttp(catalog, { publicUrl } = {}) {
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address().port;
      const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicUrl ? [new URL(publicUrl).host] : [])]);
      if (!authorities.has(req.headers.host)) return json(res, 403, { message: 'Host 不在允许范围' });
      const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicUrl ? [new URL(publicUrl).origin] : [])]);
      if (req.headers.origin && !origins.has(req.headers.origin)) return json(res, 403, { message: 'Origin 不在允许范围' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { message: '无状态 MCP 仅接受 POST' }); }
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { message: '请发送 JSON' });
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 64_000) return json(res, 413, { message: '请求体超过上限' }); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { message: 'JSON 无效' }); }
        const mcp = createMarketMcp(catalog, publicUrl || `http://127.0.0.1:${port}`);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once('close', () => { void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return json(res, 405, { message: '市场仅提供只读接口' }); }
      if (url.pathname === '/' || url.pathname === '/health') return json(res, 200, { service: 'delivery-plugin-market', protocol: 1, transport: 'http', mcp: '/mcp', catalog: '/catalog.json' });
      if (url.pathname === '/catalog.json') return json(res, 200, await catalog.catalog());
      if (url.pathname === '/api/plugins') {
        const allowed = new Set(['query', 'category', 'offset', 'limit']);
        if ([...url.searchParams.keys()].some(k => !allowed.has(k) || url.searchParams.getAll(k).length !== 1)) throw new MarketError(400, '查询参数无效');
        const input = Object.fromEntries(url.searchParams);
        for (const key of ['offset', 'limit']) if (key in input) input[key] = Number(input[key]);
        return json(res, 200, await catalog.search(input));
      }
      const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
      if (parts[0] === 'api' && parts[1] === 'plugins' && parts[2]) {
        if (parts.length === 4 && parts[3] === 'versions') return json(res, 200, await catalog.versions(parts[2]));
        if (parts.length === 3) return json(res, 200, await catalog.detail({ id: parts[2], ...(url.searchParams.has('version') ? { version: url.searchParams.get('version') } : {}) }));
      }
      if (parts.length === 1 && parts[0].endsWith('.dwp')) {
        const { bytes, release } = await catalog.packageBytes(parts[0]);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${release.package}"`, 'X-Content-Type-Options': 'nosniff', ETag: `"${release.sha256}"`, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      json(res, 404, { message: '市场接口不存在' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof MarketError ? error.status : error instanceof z.ZodError || error instanceof URIError ? 400 : 500;
      json(res, status, { message: error instanceof MarketError ? error.message : status === 400 ? '请求参数无效' : '市场服务错误' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
