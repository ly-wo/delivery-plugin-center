<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { request, categories, groupReleases } from './api';
import { createThemeChannel, type PluginTheme } from '@delivery/plugin-sdk/theme';
const tab = ref('market'), query = ref(''), category = ref(''), error = ref(''), notice = ref(''), busy = ref(false);
const installed = ref<any[]>([]), sources = ref<any[]>([]), catalogLoading = ref(false);
let catalogRequest = 0;
const localPath = ref(''), versions = ref<Record<string, string>>({}), detail = ref<any>(), preview = ref<any>(), grants = ref<string[]>([]), trust = ref(false), showMenu = ref(false);
const config = ref<any>(), fields = ref<Record<string, string>>({}), clearSecrets = ref<string[]>([]), permissions = ref<any>();
const taskId = ref(sessionStorage.getItem('plugin-center-task') || ''), task = ref<any>();
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const theme = createThemeChannel({ id: 'default', mode: 'light', instance: token, version: 0, tokens: { background: '#f4f6fa', surface: '#fff', text: '#172033', muted: '#667085', border: '#d8deea', accent: '#2457df' } });
const unsubscribe = theme.subscribe(value => { document.documentElement.style.colorScheme = value.mode; for (const [name, color] of Object.entries(value.tokens)) document.documentElement.style.setProperty('--' + name, color); });
function parent(method: string, input?: unknown) { window.parent.postMessage({ type: 'plugin-center', token, method, input }, location.origin); }
function receive(event: MessageEvent) {
  if (event.source !== window.parent || event.origin !== location.origin || event.data?.token !== token) return;
  if (event.data.type === 'plugin-center-theme' && theme.accept(event.data.theme as PluginTheme)) {
    for (const key of ['raised','divider','secondary','success','success-bg','warning','warning-bg','danger','danger-bg','radius','font-family','font-mono']) {
      const value = event.data.appearance?.[key];
      if (typeof value === 'string' && value.length < 500) document.documentElement.style.setProperty('--'+key,value);
    }
  }
  if (event.data.type === 'plugin-center-catalog-changed') void loadCatalogs();
  if (event.data.type === 'plugin-center-menu-changed') void run(loadInstalled);
}
const market = computed(() => groupReleases(sources.value).map(row => row.versions.find((v: any) => v.version === versions.value[row.id]) || row.versions[0]));
const rows = computed(() => (tab.value === 'market' ? market.value : installed.value).filter(row => {
  const m = row.manifest;
  return (!category.value || (m.category || 'uncategorized') === category.value) && `${m.name} ${m.id} ${m.description} ${(m.tags || []).join(' ')}`.toLowerCase().includes(query.value.toLowerCase());
}));
const capabilities = (manifest: any) => manifest.capabilities || manifest.permissions.map((id:string) => ({ id, required: false, purpose: '旧版插件未声明详细用途', scope: '沿用已有宿主权限定义' }));
const installAllowed = computed(() => preview.value && capabilities(preview.value.manifest).every((c:any) => !c.required || grants.value.includes(c.id)) && (!preview.value.manifest.application || trust.value));
async function run(work: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch(e:any) { error.value = e.message; } finally { busy.value = false; } }
async function loadInstalled() { const value = await request(); installed.value = value.plugins; parent('changed'); }
async function loadCatalogs() {
  const current = ++catalogRequest; catalogLoading.value = true;
  try { const value = await request('catalogs'); if (current === catalogRequest) sources.value = value.sources; }
  catch(e:any) { if (current === catalogRequest) sources.value = [{id:'unavailable',name:'市场目录',error:e.message,releases:[]}]; }
  finally { if (current === catalogRequest) catalogLoading.value = false; }
}
async function reload() { await loadInstalled(); void loadCatalogs(); }
function selectedVersions(id:string) { return groupReleases(sources.value).find(row => row.id === id)?.versions || []; }
function existing(id:string) { return installed.value.find(p => p.manifest.id === id); }
async function inspect(input: unknown) { await run(async () => {
  const checked = await request('installation/preview', input); preview.value = checked; detail.value = undefined;
  grants.value = (checked.currentGrants || []).filter((g:string) => checked.manifest.permissions.includes(g)); trust.value = false; showMenu.value = false;
  taskId.value = checked.id; sessionStorage.setItem('plugin-center-task', checked.id); task.value = checked;
}); }
async function cancelPreview() { await run(async () => { task.value = await request('installation/cancel', {id:preview.value.id}); preview.value = undefined; }); }
async function install() { if (!installAllowed.value) return; await run(async () => {
  const p = preview.value;
  task.value = await request('installation/confirm', { id:p.id, token:p.token, digest:p.digest, permissionsDigest:p.permissionsDigest, grants:grants.value, trustedLocalCode:trust.value, showInMenu:showMenu.value, confirmed:true });
  preview.value = undefined; await loadInstalled(); tab.value = 'installed'; notice.value = '安装完成。待配置的插件不会自动启用；业务写入仍需单独确认。';
}); }
async function checkTask() { await run(async () => { task.value = await request('install-tasks/' + taskId.value); await loadInstalled(); }); }
async function change(row:any, input:any) { await run(async () => { await request(row.manifest.id + '/change', input); await loadInstalled(); }); }
const removing = ref<any>();
async function remove() { const row=removing.value; await change(row,{remove:true}); if(!error.value) removing.value=undefined; }
async function editConfiguration(row:any) { await run(async () => { const value=await request(row.manifest.id+'/configuration'); config.value={row,...value}; fields.value={...value.values}; clearSecrets.value=[]; }); }
async function saveConfiguration() { await run(async () => { await request(config.value.row.manifest.id+'/configure',{values:fields.value,revision:config.value.revision,clearSecrets:clearSecrets.value}); config.value=undefined; fields.value={}; notice.value='配置已保存，可手动启用插件。'; await loadInstalled(); }); }
function editPermissions(row:any) { permissions.value=row; grants.value=[...row.grants]; trust.value=false; }
async function savePermissions() { await run(async () => {
  const addedLocal=grants.value.includes('application.local')&&!permissions.value.grants.includes('application.local');
  if(addedLocal&&!trust.value) throw new Error('请单独确认本机代码信任');
  await request(permissions.value.manifest.id+'/change',{grants:grants.value,...(addedLocal?{trustedLocalCode:true}:{})}); permissions.value=undefined; await loadInstalled();
}); }
onMounted(async () => { window.addEventListener('message',receive); parent('ready'); await run(reload); });
onBeforeUnmount(()=>{unsubscribe();theme.close();window.removeEventListener('message',receive);fields.value={};});
</script>

<template>
  <main>
    <nav class="center-tabs" aria-label="插件中心"><div class="tab-options"><button :class="{active:tab==='market'}" :aria-pressed="tab==='market'" @click="tab='market'">插件市场</button><button :class="{active:tab==='installed'}" :aria-pressed="tab==='installed'" @click="tab='installed'">已安装 <span>{{installed.length}}</span></button></div><div class="tab-options"><button @click="parent('connection.edit')">市场连接</button><button :disabled="busy" @click="run(reload)">刷新</button></div></nav>
    <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
    <section class="toolbar registry-toolbar"><label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input v-model="query" placeholder="搜索名称、描述或标签" aria-label="搜索插件"></label><span class="category-select"><select v-model="category" aria-label="插件分类"><option value="">全部分类</option><option v-for="(label,key) in categories" :value="key">{{label}}</option></select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span><button :disabled="busy" @click="parent('menu.edit')">菜单外观与顺序</button></section>
    <details class="import"><summary>从本机导入</summary><p>选择已构建的 .dwp 发布包或插件目录；检查阶段不会运行插件。</p><div class="toolbar"><input v-model="localPath" placeholder="发布包或目录的绝对路径" aria-label="本机包路径"><button :disabled="busy||!localPath" @click="inspect({localPath})">检查并预览授权</button></div></details>
    <template v-if="tab==='market'"><div v-for="source in sources.filter(s=>s.error)" class="warning" role="alert"><p>{{source.name}}：{{source.error}}。已安装管理和本机导入仍可使用。</p><button @click="parent('connection.edit')">配置市场连接</button> <button :disabled="catalogLoading" @click="loadCatalogs">重试</button></div></template>
    <p v-if="tab==='market' && catalogLoading" role="status">正在读取市场目录…</p>
    <div class="grid">
      <article v-for="row in rows" :key="row.manifest.id" class="card">
        <span class="plugin-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><template v-if="row.manifest.category==='capability'"><path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5"/></template><template v-else-if="row.manifest.category==='tool'"><path d="M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 2-3-3 3-3Z"/></template><template v-else><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></template></svg></span>
        <div class="plugin-info">
          <div class="card-title"><h2>{{row.manifest.name}}</h2><span v-if="tab==='installed'" class="status-pill" :class="row.enabled?'success':row.state==='disabled'?'neutral':'pending'"><i></i>{{({'pending-configuration':'待配置','pending-authorization':'待授权',enabled:'已启用',disabled:'已停用','configuration-error':'配置异常'} as any)[row.state] || (row.enabled?'已启用':'已停用')}}</span><span v-else-if="existing(row.manifest.id)" class="status-pill neutral"><i></i>已安装</span></div>
          <p>{{row.manifest.description}}</p>
          <div class="tags"><span>{{categories[row.manifest.category||'uncategorized']}}</span><span v-for="tag in row.manifest.tags" :key="tag">{{tag}}</span></div>
          <div v-if="tab==='market'" class="version-row"><label>版本 <select v-model="versions[row.manifest.id]" :aria-label="row.manifest.name+'版本'"><option :value="undefined">最新 {{selectedVersions(row.manifest.id)[0]?.version}}</option><option v-for="release in selectedVersions(row.manifest.id)" :value="release.version">{{release.version}}</option></select></label><small v-if="existing(row.manifest.id)">已安装 v{{existing(row.manifest.id).manifest.version}}</small></div>
          <p v-else class="plugin-meta">v{{row.manifest.version}} · {{row.showInMenu?'菜单已显示':'菜单已隐藏'}}</p>
          <p v-if="row.error" class="error">{{row.error}}</p>
        </div>
        <footer><button @click="detail=row">详情</button><template v-if="tab==='market'"><button class="primary" :disabled="busy" @click="inspect({catalogId:row.catalogId,id:row.id,version:row.version,sha256:row.sha256})">{{existing(row.id)?'检查更新 / 授权':'安装'}}</button></template><template v-else><button :disabled="!row.enabled" @click="parent('open',{id:row.manifest.id})">打开</button><button v-if="row.manifest.configuration" @click="editConfiguration(row)">配置</button><button @click="editPermissions(row)">权限</button><button :disabled="busy" @click="change(row,{enabled:!row.enabled})">{{row.enabled?'停用':'启用'}}</button><button @click="change(row,{showInMenu:!row.showInMenu})">{{row.showInMenu?'隐藏菜单':'显示菜单'}}</button><button @click="tab='market';query=row.manifest.name">更新</button><button class="danger" @click="removing=row">移除</button></template></footer>
      </article>
    </div>
    <p v-if="!rows.length&&!busy&&(tab!=='market'||!catalogLoading)" class="empty">没有匹配的插件。可以调整筛选或从本机导入。</p>
    <aside v-if="taskId" class="task"><span>最近安装任务：{{task ? ({'awaiting-confirmation':'待确认',installing:'正在安装',installed:'已安装',failed:'安装失败',cancelled:'已取消'} as any)[task.status] : '可查询上次安装结果'}} {{task?.message}}</span><button :disabled="busy" @click="checkTask">核对结果</button></aside>

    <div v-if="detail" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="插件详情"><header><h2>{{detail.manifest.name}}</h2><button @click="detail=undefined">关闭</button></header><dl><dt>身份 / 版本</dt><dd>{{detail.manifest.id}} · {{detail.manifest.version}}</dd><dt>作者</dt><dd>{{detail.manifest.author||'未声明'}}</dd><dt>来源</dt><dd>{{detail.source}} <p>摘要证明包内容一致，不证明发布者身份。</p></dd><dt>分类 / 主题</dt><dd>{{categories[detail.manifest.category||'uncategorized']}} · {{detail.manifest.theme||'旧版变量兼容'}}</dd><dt>公开 / 使用能力</dt><dd><p v-for="c in detail.manifest.provides">提供 {{c.name}}@{{c.version}} · {{c.methods.join(', ')}}</p><p v-for="c in detail.manifest.consumes">使用 {{c.name}}@{{c.version}} · {{c.methods.join(', ')}}</p></dd><dt>兼容要求</dt><dd>hostApi {{detail.manifest.hostApi}} · {{detail.manifest.compatibility||'旧版协议'}}</dd><dt>更新说明</dt><dd>{{detail.manifest.releaseNotes||'未提供'}}</dd><dt>外部依赖</dt><dd>{{(detail.manifest.dependencies||[]).join('；')||'未声明'}}</dd><dt>配置要求</dt><dd><p v-for="field in detail.manifest.configuration?.fields">{{field.label}}（{{field.required?'必填':'选填'}}）{{field.description}}</p><span v-if="!detail.manifest.configuration">无</span></dd></dl><h3>能力与作用范围</h3><div v-for="c in capabilities(detail.manifest)" class="capability"><strong>{{c.id}} · {{c.required?'必需':'可选'}}</strong><p>{{c.purpose}}</p><small>{{c.scope}}</small></div><p v-if="detail.manifest.application" class="warning">包含本机代码，以当前用户权限运行。宿主 API 授权不能约束任意本机文件或网络访问；独立进程不是操作系统安全沙箱。</p><button v-if="tab==='market'" class="primary" @click="inspect({catalogId:detail.catalogId,id:detail.id,version:detail.version,sha256:detail.sha256})">检查此版本</button></section></div>
    <div v-if="preview" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="安装授权"><h2>{{preview.replaceDigest?'更新':'安装'}} {{preview.manifest.name}} · {{preview.manifest.version}}</h2><p>来源：{{preview.source}}</p><p class="digest">包摘要 {{preview.digest}}</p><p>以下为宿主重新检查后的实际能力清单。拒绝必需能力不会安装。</p><label v-for="c in capabilities(preview.manifest)" class="capability"><input v-model="grants" type="checkbox" :value="c.id"> <strong>{{c.id}} · {{c.required?'必需':'可选'}}</strong><p>{{c.purpose}} · {{c.scope}}</p></label><label v-if="preview.manifest.application" class="warning check"><input v-model="trust" type="checkbox">我信任此版本的本机代码。它可访问当前用户文件与网络，不是操作系统安全沙箱。</label><label v-if="!preview.replaceDigest" class="check"><input v-model="showMenu" type="checkbox">安装后在菜单显示</label><p v-else>保留原配置、数据、菜单图标与顺序；新增可选能力不会自动勾选。</p><p v-if="error" class="error" role="alert">{{error}}</p><footer><button :disabled="busy" @click="cancelPreview">取消安装</button><button class="primary" :disabled="busy||!installAllowed" @click="install">同意授权并安装</button></footer></section></div>
    <div v-if="config" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="插件配置"><h2>{{config.row.manifest.name}} · 配置</h2><label v-for="f in config.row.manifest.configuration.fields" class="field">{{f.label}} {{f.required?'*':''}}<input v-model="fields[f.key]" :type="f.type==='password'?'password':'text'" autocomplete="off" :placeholder="f.type==='password'&&config.secrets[f.key]?'已设置，留空保留':''"><small>{{f.description}}</small><label v-if="f.type==='password'&&!f.required" class="check"><input v-model="clearSecrets" type="checkbox" :value="f.key">清除已保存值</label></label><p v-if="error" class="error">{{error}}</p><footer><button @click="config=undefined;fields={};error=''">取消</button><button class="primary" :disabled="busy" @click="saveConfiguration">保存配置</button></footer></section></div>
    <div v-if="permissions" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="插件权限"><h2>{{permissions.manifest.name}} · 权限</h2><p>撤权立即阻止相关新调用和排队操作；已发送的外部请求需核对结果。</p><label v-for="c in capabilities(permissions.manifest)" class="capability"><input v-model="grants" type="checkbox" :value="c.id">{{c.id}} · {{c.required?'必需':'可选'}}<p>{{c.purpose}} · {{c.scope}}</p></label><label v-if="grants.includes('application.local')&&!permissions.grants.includes('application.local')" class="check warning"><input v-model="trust" type="checkbox">信任本机代码，以当前用户权限访问文件和网络</label><p v-if="error" class="error">{{error}}</p><footer><button @click="permissions=undefined;error=''">取消</button><button :disabled="busy" @click="savePermissions">保存权限</button></footer></section></div>
    <div v-if="removing" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="移除插件"><h2>移除 {{removing.manifest.name}}？</h2><p>停止此插件并移除入口，保留其配置、业务数据和历史引用。不停止插件之外的服务。</p><footer><button @click="removing=undefined">取消</button><button class="danger" :disabled="busy" @click="remove">确认移除并保留数据</button></footer></section></div>

  </main>
</template>
