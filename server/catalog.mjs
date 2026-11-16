import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pluginManifestSchema } from '@delivery/plugin-sdk/manifest';

export class MarketError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const releaseSchema = z.object({
  id: z.string(), version: z.string(), manifest: pluginManifestSchema,
  package: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.dwp$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const catalogSchema = z.object({ protocol: z.literal(1), releases: z.array(releaseSchema).max(500) }).strict();
export const searchSchema = z.object({
  query: z.string().max(200).optional(),
  category: z.enum(['capability', 'tool', 'application', 'uncategorized']).optional(),
  offset: z.number().int().min(0).max(500).default(0),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
export const selectionSchema = z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(100).optional() }).strict();

async function readBounded(file, limit) {
  // Open without following a final-component symlink; inspect the opened file, not a raced path.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid file');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size || size > limit) throw new Error('file changed');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
const descending = (a, b) => {
  const av = a.version.split('.').map(Number), bv = b.version.split('.').map(Number);
  return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
};

export function createCatalog(directory) {
  const root = path.resolve(directory);
  async function catalog() {
    try {
      const value = catalogSchema.parse(JSON.parse((await readBounded(path.join(root, 'catalog.json'), 2_000_000)).toString('utf8')));
      const identities = new Set(), files = new Set();
      for (const release of value.releases) {
        const identity = `${release.id}@${release.version}`;
        if (release.manifest.id !== release.id || release.manifest.version !== release.version || identities.has(identity) || files.has(release.package)) throw new Error('invalid identity');
        identities.add(identity); files.add(release.package);
      }
      return value;
    } catch { throw new MarketError(503, '市场目录不可用或校验失败'); }
  }
  async function versions(id) {
    const releases = (await catalog()).releases.filter(r => r.id === id).sort(descending);
    if (!releases.length) throw new MarketError(404, '插件不存在');
    return { id, releases };
  }
  async function detail(input) {
    const { id, version } = selectionSchema.parse(input);
    const release = (await versions(id)).releases.find(r => !version || r.version === version);
    if (!release) throw new MarketError(404, '插件版本不存在');
    return release;
  }
  async function packageBytes(name) {
    const release = (await catalog()).releases.find(r => r.package === name);
    if (!release) throw new MarketError(404, '发布包不存在');
    try {
      const bytes = await readBounded(path.join(root, release.package), 41_000_000);
      if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('digest mismatch');
      return { release, bytes };
    } catch { throw new MarketError(503, '发布包不可用或摘要校验失败'); }
  }
  return {
    catalog, versions, detail, packageBytes,
    async search(input = {}) {
      const { query = '', category, offset, limit } = searchSchema.parse(input);
      const latest = new Map();
      for (const release of (await catalog()).releases.sort(descending)) if (!latest.has(release.id)) latest.set(release.id, release);
      const matches = [...latest.values()].filter(({ manifest: m }) =>
        (!category || (m.category || 'uncategorized') === category) &&
        `${m.name} ${m.id} ${m.description} ${(m.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
      return { total: matches.length, offset, limit, items: matches.slice(offset, offset + limit) };
    },
  };
}
