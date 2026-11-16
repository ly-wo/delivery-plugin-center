import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pluginManifestSchema} from '@delivery/plugin-sdk/manifest';
const input=process.argv.slice(2).filter(v=>v!=='--')[0];
if(!input)throw new Error('请提供发布制品目录');
const catalog=JSON.parse(await fs.readFile(path.join(input,'catalog.json'),'utf8'));
if(catalog.protocol!==1||!Array.isArray(catalog.releases))throw new Error('不兼容目录');
const packages=[];
for(const release of catalog.releases){
 const manifest=pluginManifestSchema.parse(release.manifest);
 if(manifest.id!==release.id||manifest.version!==release.version||!/^[a-z0-9][a-z0-9.-]*\.dwp$/.test(release.package))throw new Error('版本元数据无效');
 const file=path.join(input,release.package),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>41000000)throw new Error('非法发布文件');
 const bytes=await fs.readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw new Error('发布摘要不匹配');packages.push([release.package,bytes]);
}
await fs.mkdir('releases',{recursive:true});
for(const [name,bytes] of packages)await fs.writeFile(path.join('releases',name),bytes);
await fs.writeFile('releases/catalog.json',JSON.stringify(catalog,null,2)+'\n');
console.log(`已导入 ${packages.length} 个分发包；没有导入插件源码。`);
