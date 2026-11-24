export async function request(path = '', body?: unknown) {
  const response = await fetch('/api/custom-plugins' + (path ? '/' + path : ''), body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `HTTP ${response.status}`);
  return value;
}
export const categories: Record<string, string> = { capability: '能力插件', tool: '工具插件', application: '应用插件', uncategorized: '未分类' };
export type MarketProtocol = { protocol?: number; sdk?: string; hostApi?: number[]; mode?: 'local' | 'server' };
export type MarketRelease = {
  id: string; version: string; sha256: string; manifest: any; catalogId: string; source: string; sourceName: string; key: string;
};
export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || (left[2] || 0) - (right[2] || 0);
}
export function groupReleases(sources: any[]) {
  const map = new Map<string, { id: string; versions: MarketRelease[] }>();
  for (const source of sources) {
    if (source.error) continue;
    for (const release of source.releases || []) {
      const key = JSON.stringify([source.id, release.version, release.sha256]);
      const row = map.get(release.id) ?? { id: release.id, versions: [] as MarketRelease[] };
      if (!row.versions.some(version => version.key === key)) {
        row.versions.push({ ...release, catalogId: source.id, source: source.location || source.name, sourceName: source.name || source.id, key });
      }
      map.set(row.id, row);
    }
  }
  for (const row of map.values()) row.versions.sort((a, b) => compareVersions(b.version, a.version));
  return [...map.values()];
}

export function versionCompatibility(manifest: any, protocol: MarketProtocol): { state: 'compatible' | 'incompatible' | 'unknown'; reason?: string } {
  const incompatible = (reason: string) => ({ state: 'incompatible' as const, reason });
  if (protocol.mode === 'server' && manifest.application && manifest.deployment?.dataScope !== 'user') {
    return incompatible('此版本未适配服务端个人空间');
  }
  if (protocol.protocol === undefined) return { state: 'unknown', reason: '需由宿主检查兼容性' };
  const mode = protocol.mode ?? 'local';
  if (manifest.deployment?.environments && !manifest.deployment.environments.includes(mode)) {
    return incompatible(mode === 'local' ? '此版本未适配本机工作台' : '此版本未适配服务端工作台');
  }
  if (protocol.hostApi?.length && !protocol.hostApi.includes(manifest.hostApi)) {
    return incompatible(`此版本需要 Host API ${manifest.hostApi}，当前工作台支持 ${protocol.hostApi.join('、')}`);
  }
  const required = manifest.compatibility;
  if (required?.protocol !== undefined && required.protocol !== protocol.protocol) {
    return incompatible(`此版本需要插件管理协议 ${required.protocol}，当前为 ${protocol.protocol}`);
  }
  const numeric = /^\d+\.\d+\.\d+$/;
  if (numeric.test(required?.sdk ?? '') && numeric.test(protocol.sdk ?? '')
    && compareVersions(required.sdk, protocol.sdk!) > 0) {
    return incompatible(`此版本需要 SDK ${required.sdk}，当前工作台为 ${protocol.sdk}`);
  }
  if (!protocol.hostApi?.length || (required && (!numeric.test(protocol.sdk ?? '') || !numeric.test(required.sdk ?? '')))
    || manifest.dependencies?.length) {
    return { state: 'unknown', reason: '需由宿主检查兼容性和适配要求' };
  }
  return { state: 'compatible' };
}

export function selectRelease(versions: MarketRelease[], protocol: MarketProtocol, after?: string) {
  const candidates = after ? versions.filter(release => compareVersions(release.version, after) > 0) : versions;
  return candidates.find(release => versionCompatibility(release.manifest, protocol).state === 'compatible')
    ?? candidates.find(release => versionCompatibility(release.manifest, protocol).state === 'unknown')
    ?? (after ? undefined : candidates[0]);
}

export function previewInput(release: MarketRelease) {
  const {catalogId, id, version, sha256} = release;
  return {catalogId, id, version, sha256};
}

export function matchesRelease(manifest: any, query: string, category: string) {
  const search = query.trim().toLowerCase();
  return (!category || (manifest.category || 'uncategorized') === category)
    && [manifest.name, manifest.id, manifest.description, ...(manifest.tags || [])].join(' ').toLowerCase().includes(search);
}

export function catalogError(message: string, protocol: MarketProtocol) {
  try {
    const issues = JSON.parse(message);
    if (Array.isArray(issues)) {
      if (issues.some(issue => issue?.path?.at?.(-1) === 'sdk')) {
        return `宿主拒绝了此来源的版本目录，目录包含当前工作台不支持的 SDK 版本${protocol.sdk ? '（当前 SDK ' + protocol.sdk + '）' : ''}。`;
      }
      return '宿主拒绝了此来源的版本目录，请核对目录格式和版本声明。';
    }
  } catch { /* Server errors may already be written for display. */ }
  return message.trim().slice(0, 300);
}

export const capabilities = (manifest: any) => manifest.capabilities || manifest.permissions.map((id: string) => ({
  id, required: false, purpose: '旧版插件未声明详细用途', scope: '沿用已有宿主权限定义',
}));
export function permissionChanges(previous: any, next: any) {
  const before = new Map<string, any>(capabilities(previous).map((entry: any) => [entry.id, entry]));
  const changes: Record<string, string> = Object.create(null);
  for (const entry of capabilities(next)) {
    const old = before.get(entry.id);
    if (!old) changes[entry.id] = '新增';
    else if (old.scope !== entry.scope || old.required !== entry.required || old.purpose !== entry.purpose) changes[entry.id] = '已变化';
  }
  return changes;
}
