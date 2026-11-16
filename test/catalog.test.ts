import test from 'node:test';
import assert from 'node:assert/strict';
import {groupReleases,categories} from '../src/api';
test('one entity per plugin across sources with descending semantic versions',()=>{
 const rows=groupReleases([{id:'a',releases:[{id:'sample',version:'1.9.0'},{id:'sample',version:'1.10.0'}]},{id:'b',releases:[{id:'sample',version:'1.9.0'}]}]);
 assert.equal(rows.length,1);assert.deepEqual(rows[0].versions.map((v:any)=>v.version),['1.10.0','1.9.0']);
 assert.deepEqual(Object.keys(categories),['capability','tool','application','uncategorized']);
});
