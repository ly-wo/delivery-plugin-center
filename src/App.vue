<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { request, categories, groupReleases,
  versionCompatibility, selectRelease, compareVersions, previewInput, matchesRelease, catalogError,
  capabilities, permissionChanges, type MarketRelease, type MarketProtocol } from './api';
import CenterDialog from './CenterDialog.vue';
import { createThemeChannel, type PluginTheme } from '@delivery/plugin-sdk/theme';
const tab = ref('market'), query = ref(''), category = ref(''), error = ref(''), notice = ref(''), busy = ref(false);
const installed = ref<any[]>([]), sources = ref<any[]>([]), catalogLoading = ref(false);
let catalogRequest = 0;
const localPath = ref(''), versions = ref<Record<string, string>>({}), detail = ref<any>(), preview = ref<any>(), grants = ref<string[]>([]), trust = ref(false), showMenu = ref(false);
const config = ref<any>(), fields = ref<Record<string, string>>({}), clearSecrets = ref<string[]>([]), permissions = ref<any>();
const protocol = ref<MarketProtocol>({});
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
const groups = computed(() => groupReleases(sources.value));
const market = computed(() => groups.value.map(group => {
  const current = existing(group.id);
  return group.versions.find(release => release.key === versions.value[group.id])
    ?? (current && selectRelease(group.versions, protocol.value, current.manifest.version))
    ?? selectRelease(group.versions, protocol.value)!;
}));
const rows = computed(() => (tab.value === 'market' ? market.value : installed.value).filter(row =>
  matchesRelease(row.manifest, query.value, category.value) || tab.value === 'market'
  && selectedVersions(row.manifest.id).some(release => matchesRelease(release.manifest, query.value, category.value))));
const sourceErrors = computed(() => sources.value.filter(source => source.error));
const emptyMessage = computed(() => {
  if (tab.value === 'installed') return installed.value.length ? '没有匹配的已安装插件。' : '当前还没有安装插件。';
  if (market.value.length) return '没有匹配的插件，可以调整搜索或分类。';
  return sourceErrors.value.length ? '当前没有可浏览的目录结果。' : '市场目录暂未收录插件。';
});
const stateLabels: Record<string, string> = {
  'pending-configuration': '待配置', 'pending-authorization': '待授权', enabled: '已启用',
  disabled: '已停用', 'configuration-error': '配置异常',
};
const taskLabels: Record<string, string> = {
  'awaiting-confirmation': '待确认', installing: '正在安装', installed: '已安装', failed: '安装失败', cancelled: '已取消',
};
function installedState(row: any) { return row.state || (row.enabled ? 'enabled' : 'disabled'); }
function updateFor(row: any) { return selectRelease(selectedVersions(row.manifest.id), protocol.value, row.manifest.version); }
function compatibility(row: MarketRelease) { return versionCompatibility(row.manifest, protocol.value); }
function openDetail(row: any) { error.value = ''; detail.value = row; }
function changeVersion(id: string, event: Event) {
  const selected = selectedVersions(id).find(release => release.key === (event.target as HTMLSelectElement).value);
  if (selected) { versions.value[id] = selected.key; detail.value = selected; }
}
function installedAction(row: any) {
  switch (installedState(row)) {
    case 'pending-configuration': case 'configuration-error': return '配置';
    case 'pending-authorization': return '授权';
    case 'enabled': return '打开';
    default: return '启用';
  }
}
function openInstalled(row: any) {
  switch (installedAction(row)) {
    case '配置': return editConfiguration(row);
    case '授权': return editPermissions(row);
    case '打开': return parent('open', { id: row.manifest.id });
    default: return change(row, { enabled: true });
  }
}
function marketAction(release: MarketRelease) {
  if (compatibility(release).state === 'incompatible') return '查看兼容性';
  const current = existing(release.id);
  if (!current) return '安装';
  const order = compareVersions(release.version, current.manifest.version);
  return order > 0 ? '更新' : order === 0 ? installedAction(current) : '选择版本';
}
function openMarket(release: MarketRelease) {
  const action = marketAction(release);
  if (action === '查看兼容性' || action === '选择版本') return openDetail(release);
  if (action === '安装' || action === '更新') return inspect(previewInput(release));
  return openInstalled(existing(release.id));
}
const deltas = computed(() => {
  const previous = preview.value?.replaceDigest && existing(preview.value.manifest.id);
  return previous ? permissionChanges(previous.manifest, preview.value.manifest) : {};
});
const dialogLabel = computed(() => preview.value ? '安装授权' : detail.value ? '插件详情'
  : config.value ? '插件配置' : permissions.value ? '插件权限' : removing.value ? '移除插件' : '');
function closeDialog() {
  if (busy.value) return;
  if (preview.value) { void cancelPreview(); return; }
  detail.value = config.value = permissions.value = removing.value = undefined;
  fields.value = {}; error.value = '';
}
const installAllowed = computed(() => preview.value && capabilities(preview.value.manifest).every((c:any) => !c.required || grants.value.includes(c.id)) && (!preview.value.manifest.application || trust.value));
async function run(work: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch(e:any) { error.value = e.message; } finally { busy.value = false; } }
async function loadInstalled() { const value = await request(); installed.value = value.plugins; parent('changed'); }
async function loadCatalogs() {
  const current = ++catalogRequest; catalogLoading.value = true;
  try { const value = await request('catalogs'); if (current === catalogRequest) sources.value = value.sources; }
  catch(e:any) { if (current === catalogRequest) sources.value = [{id:'unavailable',name:'市场目录',error:e.message,releases:[]}]; }
  finally { if (current === catalogRequest) catalogLoading.value = false; }
}
async function reload() { protocol.value = await request('protocol'); await loadInstalled(); void loadCatalogs(); }
function selectedVersions(id:string) { return groups.value.find(row => row.id === id)?.versions || []; }
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
  preview.value = undefined;
  await loadInstalled();
  const record = existing(p.manifest.id);
  if (task.value?.status === 'installed' && record?.manifest.version === p.manifest.version && record.digest === p.digest) {
    tab.value = 'installed'; query.value = ''; category.value = '';
    notice.value = p.replaceDigest ? '升级完成。' : '安装完成。';
  } else {
    notice.value = '安装结果需要核对，请查看最近安装任务。';
  }
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
    <nav class="center-tabs" aria-label="插件中心">
      <div class="tab-options">
        <button type="button" :class="{active:tab==='market'}" :aria-pressed="tab==='market'" @click="tab='market'">插件市场</button>
        <button type="button" :class="{active:tab==='installed'}" :aria-pressed="tab==='installed'" @click="tab='installed'">已安装 <span>{{installed.length}}</span></button>
      </div>
      <div class="tab-options">
        <button v-if="tab==='market'" @click="parent('connection.edit')">市场连接</button>
        <button v-if="tab==='installed'" @click="parent('menu.edit')">菜单外观与顺序</button>
      </div>
    </nav>

    <div v-if="error && !dialogLabel" role="alert" class="error">{{error}}</div>
    <p v-if="notice" role="status" class="notice">{{notice}}</p>
    <section class="registry-toolbar" aria-label="浏览插件">
      <label class="search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
        <input v-model="query" placeholder="搜索名称、描述或标签" aria-label="搜索插件" data-market-focus>
      </label>
      <span class="category-select">
        <select v-model="category" aria-label="插件分类">
          <option value="">全部分类</option><option v-for="(label,key) in categories" :key="key" :value="key">{{label}}</option>
        </select>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
      </span>
      <button :disabled="busy || catalogLoading" @click="run(reload)">刷新</button>
    </section>
    <details class="import">
      <summary>从本机导入</summary>
      <p>可检查 .dwp 发布包或插件目录。</p>
      <div class="toolbar"><input v-model="localPath" placeholder="发布包或目录的绝对路径" aria-label="本机包路径"><button :disabled="busy || !localPath.trim()" @click="inspect({localPath:localPath.trim()})">检查并预览授权</button></div>
    </details>

    <div v-if="tab==='market' && sourceErrors.length" class="source-errors">
      <div class="warning" role="alert">
        <p v-for="source in sourceErrors" :key="source.id"><strong>{{source.name}}</strong> · {{catalogError(source.error, protocol)}}</p>
        <button :disabled="catalogLoading" @click="loadCatalogs">重试读取市场</button>
      </div>
    </div>
    <p v-if="tab==='market' && catalogLoading" class="results" role="status">正在读取市场目录…</p>
    <p v-else class="results" role="status">{{rows.length}} 个{{tab==='market' ? '插件' : '已安装插件'}}</p>
    <div v-if="rows.length" class="grid">
      <article v-for="row in rows" :key="row.manifest.id" class="card">
        <span class="plugin-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><template v-if="row.manifest.category==='capability'"><path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5"/></template><template v-else-if="row.manifest.category==='tool'"><path d="M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 2-3-3 3-3Z"/></template><template v-else><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></template></svg></span>
        <div class="plugin-info">
          <div class="card-title"><h2>{{row.manifest.name}}</h2>
            <span v-if="tab==='installed'" class="status-pill" :class="installedState(row)==='enabled'?'success':installedState(row)==='disabled'?'neutral':'pending'"><i></i>{{stateLabels[installedState(row)] || stateLabels.disabled}}</span>
            <span v-else-if="existing(row.id)" class="status-pill neutral"><i></i>已安装</span>
          </div>
          <p class="description">{{row.manifest.description}}</p>
          <div class="card-meta">
            <span>{{categories[row.manifest.category||'uncategorized']}}</span>
            <span>v{{row.manifest.version}}</span>
            <span v-if="tab==='installed' && updateFor(row)" class="status-pill update">可更新至 v{{updateFor(row)?.version}}</span>
            <span v-else-if="tab==='market' && compatibility(row).state==='incompatible'" class="status-pill pending">不兼容</span>
            <span v-else-if="tab==='market' && compatibility(row).state==='unknown'" class="status-pill neutral">兼容性待检查</span>
          </div>
          <p v-if="tab==='market' && compatibility(row).state==='incompatible'" class="compatibility">{{compatibility(row).reason}}</p>
          <p v-if="row.error" class="error">{{row.error}}</p>
        </div>
        <footer>
          <button @click="openDetail(row)">详情</button>
          <template v-if="tab==='market'">
            <button class="primary" :disabled="busy" @click="openMarket(row)">{{marketAction(row)}}</button>
          </template>
          <template v-else>
            <button v-if="updateFor(row)" :disabled="busy" @click="openDetail(updateFor(row))">更新</button>
            <details class="more">
              <summary>更多</summary>
              <div class="more-actions">
                <button v-if="row.manifest.configuration && installedAction(row)!=='配置'" :disabled="busy" @click="editConfiguration(row)">配置</button>
                <button v-if="installedAction(row)!=='授权'" :disabled="busy" @click="editPermissions(row)">权限</button>
                <button v-if="row.enabled" :disabled="busy" @click="change(row,{enabled:false})">停用</button>
                <button :disabled="busy" @click="change(row,{showInMenu:!row.showInMenu})">{{row.showInMenu?'隐藏菜单':'显示菜单'}}</button>
                <button class="danger" :disabled="busy" @click="removing=row">移除</button>
              </div>
            </details>
            <button class="primary" :disabled="busy" @click="openInstalled(row)">{{installedAction(row)}}</button>
          </template>
        </footer>
      </article>
    </div>
    <p v-else-if="!busy && (tab!=='market'||!catalogLoading)" class="empty">{{emptyMessage}}</p>
    <aside v-if="taskId" class="task"><span>最近安装任务 · {{task ? taskLabels[task.status] || task.status : '可查询上次安装结果'}} {{task?.message}}</span><button :disabled="busy" @click="checkTask">核对结果</button></aside>

    <CenterDialog v-if="dialogLabel" :label="dialogLabel" @cancel="closeDialog">
    <template v-if="detail"><header><h2 data-dialog-title tabindex="-1">{{detail.manifest.name}}</h2><button @click="closeDialog">关闭</button></header><p>{{detail.manifest.description}}</p>
      <label v-if="selectedVersions(detail.manifest.id).length && detail.catalogId" class="field version-field">版本与来源
        <select :value="detail.key" @change="changeVersion(detail.manifest.id, $event)">
          <option v-for="release in selectedVersions(detail.manifest.id)" :key="release.key" :value="release.key">
            v{{release.version}} · {{release.sourceName}}{{compatibility(release).state === 'incompatible' ? ' · 不兼容' : compatibility(release).state === 'unknown' ? ' · 待检查' : ''}}
          </option>
        </select>
      </label>
      <p v-if="detail.catalogId && compatibility(detail).reason" :class="compatibility(detail).state === 'incompatible' ? 'warning' : 'hint'">{{compatibility(detail).reason}}</p>
      <dl>
        <dt>插件 ID与版本</dt><dd>{{detail.manifest.id}} · v{{detail.manifest.version}}</dd>
        <dt v-if="detail.manifest.author">作者</dt><dd v-if="detail.manifest.author">{{detail.manifest.author}}</dd>
        <dt v-if="detail.source">来源</dt><dd v-if="detail.source">{{detail.source}}</dd>
        <dt>分类</dt><dd>{{categories[detail.manifest.category||'uncategorized']}}</dd>
        <dt v-if="detail.manifest.theme">主题</dt><dd v-if="detail.manifest.theme">{{detail.manifest.theme}}</dd>
        <dt>适配要求</dt><dd>Host API {{detail.manifest.hostApi}}<template v-if="detail.manifest.compatibility"> · SDK {{detail.manifest.compatibility.sdk}} · 协议 {{detail.manifest.compatibility.protocol}}</template></dd>
        <dt v-if="detail.manifest.releaseNotes">更新说明</dt><dd v-if="detail.manifest.releaseNotes">{{detail.manifest.releaseNotes}}</dd>
        <dt v-if="detail.manifest.dependencies?.length">外部依赖</dt><dd v-if="detail.manifest.dependencies?.length">{{detail.manifest.dependencies.join('、')}}</dd>
        <dt v-if="detail.manifest.configuration">配置要求</dt><dd v-if="detail.manifest.configuration"><p v-for="field in detail.manifest.configuration.fields" :key="field.key">{{field.label}}（{{field.required?'必填':'选填'}}）{{field.description}}</p></dd>
        <dt v-if="detail.manifest.provides?.length || detail.manifest.consumes?.length">公开与使用能力</dt>
        <dd v-if="detail.manifest.provides?.length || detail.manifest.consumes?.length"><p v-for="c in detail.manifest.provides" :key="'provides-'+c.name">提供 {{c.name}}@{{c.version}} · {{c.methods.join('、')}}</p><p v-for="c in detail.manifest.consumes" :key="'consumes-'+c.name">使用 {{c.name}}@{{c.version}} · {{c.methods.join('、')}}</p></dd>
      </dl>
      <h3 v-if="capabilities(detail.manifest).length">权限与作用范围</h3>
      <div v-for="c in capabilities(detail.manifest)" :key="c.id" class="capability"><strong>{{c.id}} · {{c.required?'必需':'可选'}}</strong><p>{{c.purpose}}</p><small>{{c.scope}}</small></div>
      <p v-if="detail.manifest.application" class="warning">仅安装可信代码。插件代码可访问本机运行账号允许使用的文件与网络。</p>
      <p v-if="error" class="error" role="alert">{{error}}</p>
      <footer v-if="detail.catalogId"><button class="primary" :disabled="busy || compatibility(detail).state === 'incompatible'" @click="inspect(previewInput(detail))">{{busy ? '检查中…' : '检查并预览授权'}}</button></footer>
    </template>
    <template v-if="preview"><h2 data-dialog-title tabindex="-1">{{preview.replaceDigest?'更新':'安装'}} {{preview.manifest.name}} · {{preview.manifest.version}}</h2><p>来源：{{preview.source}}</p><p class="digest">包摘要 {{preview.digest}}</p><p>以下为宿主重新检查后的实际能力清单。拒绝必需能力不会安装。</p><label v-for="c in capabilities(preview.manifest)" :key="c.id" class="capability"><input v-model="grants" type="checkbox" :value="c.id"> <strong>{{c.id}} · {{c.required?'必需':'可选'}}</strong> <span v-if="deltas[c.id]" class="status-pill pending">{{deltas[c.id]}}</span><p>{{c.purpose}} · {{c.scope}}</p></label><label v-if="preview.manifest.application" class="warning check"><input v-model="trust" type="checkbox">我信任此版本的本机代码。它可访问当前用户文件与网络，不是操作系统安全沙箱。</label><label v-if="!preview.replaceDigest" class="check"><input v-model="showMenu" type="checkbox">安装后在菜单显示</label><p v-else>保留原配置、数据、菜单图标与顺序；新增可选能力不会自动勾选。</p><p v-if="error" class="error" role="alert">{{error}}</p><footer><button :disabled="busy" @click="cancelPreview">{{preview.replaceDigest ? '取消升级' : '取消安装'}}</button><button class="primary" :disabled="busy||!installAllowed" @click="install">{{busy ? '处理中…' : preview.replaceDigest ? '同意授权并升级' : '同意授权并安装'}}</button></footer></template>
    <template v-if="config"><h2 data-dialog-title tabindex="-1">{{config.row.manifest.name}} · 配置</h2><label v-for="f in config.row.manifest.configuration.fields" class="field">{{f.label}} {{f.required?'*':''}}<input v-model="fields[f.key]" :type="f.type==='password'?'password':'text'" autocomplete="off" :placeholder="f.type==='password'&&config.secrets[f.key]?'已设置，留空保留':''"><small>{{f.description}}</small><label v-if="f.type==='password'&&!f.required" class="check"><input v-model="clearSecrets" type="checkbox" :value="f.key">清除已保存值</label></label><p v-if="error" class="error">{{error}}</p><footer><button @click="config=undefined;fields={};error=''">取消</button><button class="primary" :disabled="busy" @click="saveConfiguration">保存配置</button></footer></template>
    <template v-if="permissions"><h2 data-dialog-title tabindex="-1">{{permissions.manifest.name}} · 权限</h2><p>撤权立即阻止相关新调用和排队操作；已发送的外部请求需核对结果。</p><label v-for="c in capabilities(permissions.manifest)" class="capability"><input v-model="grants" type="checkbox" :value="c.id">{{c.id}} · {{c.required?'必需':'可选'}}<p>{{c.purpose}} · {{c.scope}}</p></label><label v-if="grants.includes('application.local')&&!permissions.grants.includes('application.local')" class="check warning"><input v-model="trust" type="checkbox">信任此版本在声明的运行位置执行代码</label><p v-if="error" class="error">{{error}}</p><footer><button @click="permissions=undefined;error=''">取消</button><button :disabled="busy" @click="savePermissions">保存权限</button></footer></template>
    <template v-if="removing"><h2 data-dialog-title tabindex="-1">移除 {{removing.manifest.name}}？</h2><p>停止此插件并移除入口，保留其配置、业务数据和历史引用。不停止插件之外的服务。</p><footer><button @click="removing=undefined">取消</button><button class="danger" :disabled="busy" @click="remove">确认移除并保留数据</button></footer></template>
    </CenterDialog>
  </main>
</template>
