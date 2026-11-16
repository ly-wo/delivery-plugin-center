export async function request(path = '', body?: unknown) {
  const response = await fetch('/api/custom-plugins' + (path ? '/' + path : ''), body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `HTTP ${response.status}`);
  return value;
}
export const categories: Record<string, string> = { capability: '能力插件', tool: '工具插件', application: '应用插件', uncategorized: '未分类' };
export function groupReleases(sources: any[]) {
  const map = new Map<string, any>();
  for (const source of sources) for (const release of source.releases || []) {
    const r = { ...release, catalogId: source.id, source: source.location || source.name };
    const row = map.get(r.id) || { id: r.id, versions: [] };
    if (!row.versions.some((v: any) => v.version === r.version)) row.versions.push(r);
    map.set(r.id, row);
  }
  for (const row of map.values()) row.versions.sort((a: any, b: any) => {
    const av = a.version.split('.').map(Number), bv = b.version.split('.').map(Number);
    return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
  });
  return [...map.values()];
}
