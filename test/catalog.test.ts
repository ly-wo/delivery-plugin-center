import test from 'node:test';
import assert from 'node:assert/strict';
import { categories, groupReleases, matchesRelease, permissionChanges, previewInput, selectRelease, versionCompatibility, catalogError } from '../src/api';

const protocol = { protocol: 1, sdk: '2.2.1', hostApi: [1, 2], mode: 'local' as const };
function release(version: string, sdk = '2.2.1', sha256 = version) {
  return { id: 'sample', version, sha256, manifest: { id: 'sample', version, hostApi: 2, compatibility: { protocol: 1, sdk } } };
}

test('one card groups versions in semantic order without losing the selected source or digest', () => {
  const rows = groupReleases([
    { id: 'a', location: 'Source A', releases: [release('1.9.0'), release('1.10.0'), release('1.9.0')] },
    { id: 'b', location: 'Source B', releases: [release('1.9.0', '2.2.1', 'different')] },
    { id: 'broken', error: 'offline', releases: [release('1.99.0')] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].versions.map(value => value.version), ['1.10.0', '1.9.0', '1.9.0']);
  assert.deepEqual(previewInput(rows[0].versions[2]), { id: 'sample', version: '1.9.0', catalogId: 'b', sha256: 'different' });
  assert.deepEqual(Object.keys(categories), ['capability', 'tool', 'application', 'uncategorized']);
});

test('recommend an applicable older version and require review when compatibility is unknown', () => {
  const [row] = groupReleases([{ id: 'a', releases: [release('1.10.0', '2.4.0'), release('1.9.0')] }]);
  assert.match(versionCompatibility(row.versions[0].manifest, protocol).reason!, /2\.4\.0.*2\.2\.1/);
  assert.equal(selectRelease(row.versions, protocol)?.version, '1.9.0');
  assert.equal(selectRelease(row.versions, protocol, '1.9.0'), undefined);
  assert.equal(versionCompatibility(row.versions[0].manifest, {}).state, 'unknown');
  assert.equal(versionCompatibility({ ...row.versions[1].manifest, dependencies: ['Agent'] }, protocol).state, 'unknown');
});

test('search includes tags; permission differences are compared with the installed manifest', () => {
  assert.equal(matchesRelease({ name: 'Jenkins', category: 'tool', tags: ['CI'] }, ' ci ', 'tool'), true);
  assert.equal(matchesRelease({ name: 'Jenkins', category: 'tool', tags: ['CI'] }, 'ci', 'application'), false);
  const previous = { capabilities: [{ id: 'a', scope: 'self', required: false }, { id: 'b', scope: 'self', required: false }] };
  const next = { capabilities: [{ id: 'a', scope: 'all', required: false }, { id: 'b', scope: 'self', required: false }, { id: 'c', scope: 'self', required: true }] };
  assert.deepEqual({ ...permissionChanges(previous, next) }, { a: '已变化', c: '新增' });
  assert.match(catalogError('[{"path":["releases",0,"manifest","compatibility","sdk"]}]', protocol), /宿主拒绝了此来源.*2\.2\.1/);
});
