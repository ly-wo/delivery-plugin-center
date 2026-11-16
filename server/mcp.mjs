import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchSchema, selectionSchema, MarketError } from './catalog.mjs';

export function createMarketMcp(catalog, publicUrl) {
  const server = new McpServer({ name: 'delivery-plugin-market', version: '1.0.0' });
  const wrap = fn => async input => {
    try {
      const value = await fn(input);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof MarketError ? error.message : '市场请求无效' }] };
    }
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('market_search', { description: '按名称、描述、标签和分类搜索插件；每个插件返回最新版本。', inputSchema: searchSchema, annotations }, wrap(input => catalog.search(input)));
  server.registerTool('market_detail', { description: '读取指定插件声明、权限和版本详情；不安装或执行插件。', inputSchema: selectionSchema, annotations }, wrap(input => catalog.detail(input)));
  server.registerTool('market_versions', { description: '列出插件可用版本。', inputSchema: z.object({ id: z.string().min(1).max(100) }).strict(), annotations }, wrap(input => catalog.versions(input.id)));
  server.registerTool('market_package', { description: '返回经摘要校验的包信息与资源地址；安装仍需工作台授权。', inputSchema: selectionSchema, annotations }, wrap(async input => {
    const release = await catalog.detail(input);
    const { bytes } = await catalog.packageBytes(release.package);
    return { id: release.id, version: release.version, sha256: release.sha256, size: bytes.length,
      resourceUri: `plugin-market://packages/${release.package}`,
      ...(publicUrl ? { downloadUrl: new URL(release.package, publicUrl + '/').href } : {}) };
  }));
  server.registerResource('catalog', 'plugin-market://catalog', { mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await catalog.catalog()) }] }));
  server.registerResource('package', new ResourceTemplate('plugin-market://packages/{name}', { list: undefined }), { mimeType: 'application/octet-stream' }, async (uri, { name }) => {
    const { bytes } = await catalog.packageBytes(name);
    return { contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: bytes.toString('base64') }] };
  });
  return server;
}
