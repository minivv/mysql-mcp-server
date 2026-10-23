export function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MySQL MCP Server</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0c0e14;
  --surface-1: #141722;
  --surface-2: #1b1f2e;
  --surface-3: #232839;
  --border: rgba(255,255,255,0.06);
  --border-strong: rgba(255,255,255,0.12);
  --text: #e4e4e7;
  --text-muted: #71717a;
  --accent: #38bdf8;
  --accent-soft: rgba(56,189,248,0.12);
  --test: #22c55e;
  --test-soft: rgba(34,197,94,0.12);
  --prod: #ef4444;
  --prod-soft: rgba(239,68,68,0.12);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.15);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.25), 0 2px 4px rgba(0,0,0,0.15);
}
body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1040px; margin: 0 auto; padding: 40px 24px 64px; }

.header { text-align: center; margin-bottom: 28px; animation: fadeUp .4s cubic-bezier(.2,0,0,1); }
.header h1 {
  font-size: 19px; font-weight: 600; letter-spacing: -0.02em;
  display: flex; align-items: center; justify-content: center; gap: 10px;
}
.logo-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 12px rgba(56,189,248,.55);
  animation: pulse 2.2s ease-in-out infinite;
}
.status-pill {
  display: inline-flex; align-items: center; gap: 7px;
  margin-top: 14px; padding: 6px 14px;
  border-radius: 100px; font-size: 12px; font-weight: 500;
  background: var(--surface-2); box-shadow: var(--shadow-sm);
  color: var(--text-muted);
}
.status-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.status-pill.connected.test { color: var(--test); }
.status-pill.connected.test .dot { background: var(--test); box-shadow: 0 0 8px rgba(34,197,94,.5); }
.status-pill.connected.prod { color: var(--prod); }
.status-pill.connected.prod .dot { background: var(--prod); box-shadow: 0 0 8px rgba(239,68,68,.5); }

.tabs {
  display: flex; gap: 4px; padding: 4px; margin-bottom: 20px;
  background: var(--surface-1); border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,.03);
  animation: fadeUp .45s cubic-bezier(.2,0,0,1);
}
.tab {
  flex: 1; padding: 10px 16px; border: none; background: transparent;
  color: var(--text-muted); font-size: 13px; font-weight: 500;
  font-family: inherit; border-radius: var(--radius-sm); cursor: pointer;
  transition: background .2s, color .2s, transform .12s;
}
.tab:hover { color: var(--text); background: rgba(255,255,255,.04); }
.tab:active { transform: scale(.98); }
.tab.active { background: var(--surface-3); color: var(--text); }

.tab-panel { display: none; }
.tab-panel.active { display: block; animation: fadeUp .35s cubic-bezier(.2,0,0,1); }

.card {
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 20px;
  box-shadow: var(--shadow-sm); margin-bottom: 16px;
}
.card-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}
.card-head h2 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.muted { color: var(--text-muted); font-size: 12px; }

.conn-grid { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }
.conn-grid .card { margin-bottom: 0; }
.conn-grid .card:last-child { display: flex; flex-direction: column; max-height: calc(100vh - 250px); }

.form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.field-row { display: grid; grid-template-columns: minmax(0, 1fr) 92px; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field.full { grid-column: 1 / -1; }
.field label { font-size: 12px; color: var(--text-muted); }
.field input {
  width: 100%; padding: 9px 12px; font-family: inherit; font-size: 13px;
  color: var(--text); background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  transition: border-color .18s, box-shadow .18s;
}
.field input::placeholder { color: #4b5563; }
.field input:focus {
  outline: none; border-color: rgba(56,189,248,.5);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.env-choice { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.env-option { position: relative; cursor: pointer; }
.env-option input { position: absolute; opacity: 0; pointer-events: none; }
.env-option span {
  display: block; padding: 9px 12px; text-align: center; font-size: 13px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-muted);
  transition: all .18s;
}
.env-option.test input:checked + span {
  border-color: rgba(34,197,94,.45); background: var(--test-soft); color: var(--test);
}
.env-option.prod input:checked + span {
  border-color: rgba(239,68,68,.45); background: var(--prod-soft); color: var(--prod);
}

.form-actions { display: flex; gap: 8px; margin-top: 18px; }
.btn {
  padding: 8px 16px; font-family: inherit; font-size: 13px; font-weight: 500;
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: var(--surface-3); color: var(--text); cursor: pointer;
  transition: background .18s, border-color .18s, transform .12s, opacity .18s;
}
.btn:hover { background: #2b3247; }
.btn:active { transform: scale(.98); }
.btn-primary { background: var(--accent); color: #06202c; }
.btn-primary:hover { background: #5bc8f9; }
.btn-ghost { background: transparent; border-color: var(--border); color: var(--text-muted); }
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text); background: rgba(255,255,255,.03); }
.btn-danger { background: transparent; border-color: transparent; color: var(--prod); }
.btn-danger:hover { background: var(--prod-soft); }
.btn-sm { padding: 5px 11px; font-size: 12px; }
.hidden { display: none !important; }

.conn-list {
  display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto; padding-right: 6px; margin-right: -6px;
  flex: 1; min-height: 0;
}
.conn-list::-webkit-scrollbar { width: 8px; }
.conn-list::-webkit-scrollbar-track { background: transparent; }
.conn-list::-webkit-scrollbar-thumb { background: #2b3247; border-radius: 100px; }
.conn-list::-webkit-scrollbar-thumb:hover { background: #3a4360; }
.conn-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 13px; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  transition: border-color .18s, background .18s;
}
.conn-item:hover { border-color: var(--border-strong); }
.conn-item.active { border-color: rgba(56,189,248,.35); background: rgba(56,189,248,.05); }
.conn-item.editing { border-color: rgba(251,191,36,.45); background: rgba(251,191,36,.05); }
.conn-info { flex: 1; min-width: 0; }
.conn-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.conn-name {
  font-size: 13px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.conn-item.active .conn-name { color: var(--accent); }
.conn-actions { display: flex; gap: 3px; flex-shrink: 0; }
.conn-meta {
  margin-top: 3px; font-size: 11.5px; color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.badge {
  padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 500;
}
.badge.test { color: var(--test); background: var(--test-soft); }
.badge.prod { color: var(--prod); background: var(--prod-soft); }
.badge.active-badge { color: var(--accent); background: var(--accent-soft); }

.empty { padding: 28px; text-align: center; color: var(--text-muted); font-size: 13px; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-dim); cursor: pointer; user-select: none; }
.check-row input { accent-color: var(--accent); width: 14px; height: 14px; }
.ssh-fields {
  display: flex; flex-direction: column; gap: 10px; padding: 12px;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-md);
  background: rgba(56,189,248,.03);
}
.hint-sm { margin: 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.55; }
.input-with-btn { display: flex; gap: 6px; }
.input-with-btn input { flex: 1; min-width: 0; }

.filter-tabs {
  display: flex; gap: 3px; padding: 3px; margin-bottom: 10px;
  background: var(--surface-2); border-radius: var(--radius-sm);
}
.filter-tab {
  flex: 1; border: 0; background: transparent; color: var(--text-muted);
  font: inherit; font-size: 12px; padding: 6px 0; border-radius: 6px;
  cursor: pointer; transition: background .15s, color .15s;
}
.filter-tab:hover { color: var(--text); }
.filter-tab.active { background: var(--surface-3); color: var(--text); }

.modal {
  position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 50;
  display: flex; align-items: center; justify-content: center;
}
.modal-box {
  width: min(520px, 90vw); max-height: 70vh; display: flex; flex-direction: column;
  background: var(--surface-1); border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-md); overflow: hidden;
}
.modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.modal-title { flex: 1; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-list { overflow-y: auto; padding: 6px; }
.file-item {
  padding: 7px 10px; border-radius: 6px; font-size: 12.5px; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.file-item:hover { background: var(--surface-2); }
.file-item.is-dir { color: var(--accent); }

.hint {
  font-size: 12.5px; color: var(--text-muted); line-height: 1.7;
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: 14px 16px; margin-bottom: 16px;
}
.hint strong { color: var(--text); font-weight: 600; }

.perm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.perm-card.test { border-color: rgba(34,197,94,.18); }
.perm-card.prod { border-color: rgba(239,68,68,.18); }
.perm-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.perm-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 0; border-top: 1px solid var(--border); cursor: pointer;
}
.perm-text { display: flex; flex-direction: column; gap: 2px; }
.perm-text strong { font-size: 13px; font-weight: 600; }
.perm-text small { font-size: 11px; color: var(--text-muted); }

.switch { position: relative; width: 38px; height: 21px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0; cursor: pointer; border-radius: 100px;
  background: var(--surface-3); transition: background .2s;
}
.slider::before {
  content: ""; position: absolute; height: 15px; width: 15px; left: 3px; top: 3px;
  background: #9ca3af; border-radius: 50%; transition: transform .2s, background .2s;
}
.switch input:checked + .slider { background: var(--accent-soft); }
.switch input:checked + .slider::before { transform: translateX(17px); background: var(--accent); }

.toast {
  position: fixed; top: 20px; left: 50%; transform: translate(-50%, -16px);
  padding: 10px 18px; font-size: 13px; border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-md); opacity: 0; pointer-events: none;
  transition: opacity .2s, transform .2s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.ok { border-color: rgba(34,197,94,.4); color: var(--test); }
.toast.err { border-color: rgba(239,68,68,.4); color: var(--prod); }

@keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
@media (max-width: 860px) {
  .conn-grid { grid-template-columns: 1fr; }
  .conn-grid .card:last-child { max-height: none; }
  .conn-list { overflow-y: visible; }
  .perm-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="page">
  <header class="header">
    <h1><span class="logo-dot"></span>MySQL MCP Server</h1>
    <div id="status" class="status-pill"><span class="dot"></span><span id="status-text">未连接</span></div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="connections">连接管理</button>
    <button class="tab" data-tab="permissions">权限配置</button>
  </nav>

  <section id="panel-connections" class="tab-panel active">
    <div class="conn-grid">
      <div class="card">
        <div class="card-head">
          <h2 id="form-title">添加连接</h2>
          <button id="btn-cancel" class="btn btn-ghost btn-sm hidden">取消编辑</button>
        </div>
        <form id="conn-form" autocomplete="off">
          <div class="form-grid">
            <div class="field">
              <label for="f-name">连接名称</label>
              <input id="f-name" name="name" placeholder="local-dev" required>
            </div>
            <div class="field">
              <label>库环境标识</label>
              <div class="env-choice">
                <label class="env-option test"><input type="radio" name="env" value="test"><span>测试库</span></label>
                <label class="env-option prod"><input type="radio" name="env" value="prod" checked><span>正式库</span></label>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="f-host">主机</label>
                <input id="f-host" name="host" placeholder="127.0.0.1" required>
              </div>
              <div class="field">
                <label for="f-port">端口</label>
                <input id="f-port" name="port" type="number" placeholder="3306">
              </div>
            </div>
            <div class="field">
              <label for="f-user">用户名</label>
              <input id="f-user" name="user" placeholder="root" required>
            </div>
            <div class="field">
              <label for="f-password">密码</label>
              <input id="f-password" name="password" type="password" placeholder="编辑时留空表示不修改">
            </div>
            <div class="field">
              <label for="f-database">默认数据库（可选）</label>
              <input id="f-database" name="database" placeholder="ruoyi-vue-pro">
            </div>
            <div class="field">
              <label class="check-row">
                <input type="checkbox" id="f-ssh-enabled">
                <span>通过 SSH 隧道访问</span>
              </label>
            </div>
            <div id="ssh-fields" class="ssh-fields hidden">
              <div class="field">
                <label for="f-ssh-host">SSH 主机</label>
                <input id="f-ssh-host" placeholder="ssh66 或 user@host">
              </div>
              <div class="field-row">
                <div class="field">
                  <label for="f-ssh-port">SSH 端口</label>
                  <input id="f-ssh-port" type="number" placeholder="22">
                </div>
                <div class="field">
                  <label for="f-ssh-user">SSH 用户</label>
                  <input id="f-ssh-user" placeholder="root">
                </div>
              </div>
              <div class="field">
                <label for="f-ssh-key">密钥文件</label>
                <div class="input-with-btn">
                  <input id="f-ssh-key" placeholder="~/.ssh/id_ed25519">
                  <button type="button" class="btn btn-sm btn-ghost" id="btn-ssh-key">选择</button>
                </div>
              </div>
              <div class="field">
                <label for="f-ssh-passphrase">密钥口令</label>
                <input id="f-ssh-passphrase" type="password" placeholder="无口令留空">
              </div>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">保存连接</button>
            <button type="button" id="btn-test" class="btn btn-ghost">测试连接</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>已保存的连接</h2>
          <span id="conn-count" class="muted"></span>
        </div>
        <div class="filter-tabs" id="conn-filter">
          <button type="button" class="filter-tab active" data-filter="all">全部</button>
          <button type="button" class="filter-tab" data-filter="test">测试库</button>
          <button type="button" class="filter-tab" data-filter="prod">正式库</button>
        </div>
        <div id="conn-list" class="conn-list"></div>
      </div>
    </div>
  </section>

  <section id="panel-permissions" class="tab-panel">
    <p class="hint">
      开关绑定在<strong>库环境标识</strong>上，改一次即对所有使用该标识的连接生效。
      只读查询（SELECT / SHOW / DESCRIBE / EXPLAIN）始终放行。
    </p>
    <div id="perm-grid" class="perm-grid"></div>
    <div class="form-actions">
      <button id="btn-save-perms" class="btn btn-primary">保存权限</button>
    </div>
  </section>
</div>
<div id="toast" class="toast"></div>

<div id="file-modal" class="modal hidden">
  <div class="modal-box">
    <div class="modal-head">
      <span id="file-dir" class="modal-title"></span>
      <button type="button" class="btn btn-sm btn-ghost" id="btn-file-close">关闭</button>
    </div>
    <div id="file-list" class="file-list"></div>
  </div>
</div>

<script>
var state = { connections: [], activeConnection: null, permissions: { test: {}, prod: {} }, editing: null, filter: 'all' };
var OPS = [
  { key: 'basicDdl', label: '基础 DDL', desc: '建表 / 加字段 / 加索引 / 重命名' },
  { key: 'advancedDdl', label: '高级 DDL', desc: '删表 / 清空 / 删字段' },
  { key: 'insert', label: 'INSERT', desc: '新增数据' },
  { key: 'update', label: 'UPDATE', desc: '修改数据' },
  { key: 'delete', label: 'DELETE', desc: '删除数据' }
];

function $(id) { return document.getElementById(id); }

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function toast(message, ok) {
  var el = $('toast');
  el.textContent = message;
  el.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { el.className = 'toast ' + (ok ? 'ok' : 'err'); }, 2600);
}

function api(path, options) {
  var opts = options || {};
  opts.headers = { 'Content-Type': 'application/json' };
  return fetch(path, opts).then(function (res) {
    return res.json().catch(function () { return {}; });
  });
}

function load() {
  return Promise.all([api('/api/connections'), api('/api/permissions')]).then(function (out) {
    state.connections = out[0].connections || [];
    state.activeConnection = out[0].activeConnection;
    state.permissions = out[1] || { test: {}, prod: {} };
    render();
  });
}

function render() {
  renderStatus();
  renderConnections();
  renderPermissions();
}

function renderStatus() {
  var pill = $('status');
  var active = null;
  for (var i = 0; i < state.connections.length; i++) {
    if (state.connections[i].name === state.activeConnection) { active = state.connections[i]; break; }
  }
  if (!active) {
    pill.className = 'status-pill';
    $('status-text').textContent = '未连接';
    return;
  }
  var tpl = state.permissions[active.env] || {};
  var writable = !!(tpl.basicDdl || tpl.advancedDdl || tpl.insert || tpl.update || tpl.delete);
  pill.className = 'status-pill connected ' + active.env;
  $('status-text').textContent =
    (active.env === 'test' ? '测试库' : '正式库') + ' · ' + (writable ? '可写' : '只读') + ' · ' + active.name;
}

function renderConnections() {
  var list = $('conn-list');
  var all = state.connections;
  var visible = state.filter === 'all' ? all : all.filter(function (c) { return c.env === state.filter; });
  $('conn-count').textContent = visible.length
    ? visible.length + (visible.length !== all.length ? ' / ' + all.length : '') + ' 个'
    : '';
  if (!visible.length) {
    list.innerHTML = '<div class="empty">' +
      (all.length ? '没有符合条件的连接。' : '还没有连接，先在上面添加一个。') + '</div>';
    return;
  }
  list.innerHTML = visible.map(function (c) {
    var name = esc(c.name);
    var cls = (c.active ? ' active' : '') + (state.editing === c.name ? ' editing' : '');
    var envLabel = c.env === 'test' ? '测试库' : '正式库';
    var activeBadge = c.active ? '<span class="badge active-badge">使用中</span>' : '';
    return '<div class="conn-item' + cls + '">' +
      '<div class="conn-info">' +
        '<div class="conn-title">' +
          '<span class="conn-name">' + name + '</span>' +
          '<span class="badge ' + c.env + '">' + envLabel + '</span>' +
          activeBadge +
        '</div>' +
        '<div class="conn-meta">' + esc(c.user) + '@' + esc(c.host) + ':' + esc(c.port) +
          (c.database ? ' / ' + esc(c.database) : '') +
          (c.ssh ? ' · 🔒 ' + esc(c.ssh.host) : '') + '</div>' +
      '</div>' +
      '<div class="conn-actions">' +
        '<button class="btn btn-sm btn-ghost" data-act="activate" data-name="' + name + '">使用</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="edit" data-name="' + name + '">编辑</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="test" data-name="' + name + '">测试</button>' +
        '<button class="btn btn-sm btn-danger" data-act="delete" data-name="' + name + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderPermissions() {
  $('perm-grid').innerHTML = ['test', 'prod'].map(function (env) {
    var tpl = state.permissions[env] || {};
    var title = env === 'test' ? '测试库' : '正式库';
    var rows = OPS.map(function (op) {
      var checked = tpl[op.key] ? ' checked' : '';
      return '<label class="perm-row">' +
        '<span class="perm-text"><strong>' + op.label + '</strong><small>' + op.desc + '</small></span>' +
        '<span class="switch"><input type="checkbox" data-env="' + env + '" data-op="' + op.key + '"' + checked + '>' +
        '<span class="slider"></span></span>' +
      '</label>';
    }).join('');
    return '<div class="card perm-card ' + env + '">' +
      '<div class="perm-head">' +
        '<span class="badge ' + env + '">' + title + '</span>' +
        '<span class="muted">env=' + env + '</span>' +
      '</div>' + rows +
    '</div>';
  }).join('');
}

function findConnection(name) {
  for (var i = 0; i < state.connections.length; i++) {
    if (state.connections[i].name === name) return state.connections[i];
  }
  return null;
}

function setEnvRadio(env) {
  var radios = document.querySelectorAll('input[name=env]');
  for (var i = 0; i < radios.length; i++) {
    radios[i].checked = radios[i].value === env;
  }
}

function fillForm(conn) {
  $('f-name').value = conn ? conn.name : '';
  $('f-host').value = conn ? conn.host : '';
  $('f-port').value = conn ? conn.port : '';
  $('f-user').value = conn ? conn.user : '';
  $('f-password').value = '';
  $('f-database').value = conn ? (conn.database || '') : '';
  var ssh = conn && conn.ssh ? conn.ssh : null;
  $('f-ssh-enabled').checked = !!ssh;
  $('f-ssh-host').value = ssh ? ssh.host : '';
  $('f-ssh-port').value = ssh && ssh.port ? ssh.port : '';
  $('f-ssh-user').value = ssh && ssh.user ? ssh.user : '';
  $('f-ssh-key').value = ssh && ssh.keyFile ? ssh.keyFile : '';
  $('f-ssh-passphrase').value = '';
  $('f-ssh-passphrase').placeholder = ssh && ssh.hasPassphrase ? '已设置，留空则不修改' : '无口令留空';
  toggleSshFields();
  setEnvRadio(conn ? conn.env : 'prod');
  state.editing = conn ? conn.name : null;
  $('form-title').textContent = conn ? '编辑连接：' + conn.name : '添加连接';
  $('btn-cancel').classList.toggle('hidden', !conn);
  renderConnections();
}

function readForm() {
  var checked = document.querySelector('input[name=env]:checked');
  return {
    name: $('f-name').value.trim(),
    originalName: state.editing || '',
    host: $('f-host').value.trim(),
    port: $('f-port').value ? Number($('f-port').value) : 3306,
    user: $('f-user').value.trim(),
    password: $('f-password').value,
    database: $('f-database').value.trim(),
    env: checked ? checked.value : 'prod',
    ssh: sshPayload()
  };
}

function toggleSshFields() {
  $('ssh-fields').classList.toggle('hidden', !$('f-ssh-enabled').checked);
}

function sshPayload() {
  if (!$('f-ssh-enabled').checked) return null;
  var host = $('f-ssh-host').value.trim();
  if (!host) return null;
  var ssh = { host: host };
  if ($('f-ssh-port').value) ssh.port = Number($('f-ssh-port').value);
  if ($('f-ssh-user').value.trim()) ssh.user = $('f-ssh-user').value.trim();
  if ($('f-ssh-key').value.trim()) ssh.keyFile = $('f-ssh-key').value.trim();
  if ($('f-ssh-passphrase').value) ssh.passphrase = $('f-ssh-passphrase').value;
  return ssh;
}

function setFilter(filter) {
  state.filter = filter;
  var tabs = document.querySelectorAll('.filter-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-filter') === filter);
  }
  renderConnections();
}

function loadFileDir(dir) {
  api('/api/files' + (dir ? '?dir=' + encodeURIComponent(dir) : '')).then(function (res) {
    if (!res || res.error) {
      toast((res && res.error) || '无法读取目录', false);
      return;
    }
    $('file-dir').textContent = res.dir;
    var html = '';
    if (res.parent) {
      html += '<div class="file-item is-dir" data-dir="' + esc(res.parent) + '">⬆ 上一级</div>';
    }
    html += res.entries.map(function (e) {
      return '<div class="file-item' + (e.dir ? ' is-dir' : '') + '" data-' +
        (e.dir ? 'dir' : 'file') + '="' + esc(e.path) + '">' +
        (e.dir ? '📁 ' : '📄 ') + esc(e.name) + '</div>';
    }).join('');
    $('file-list').innerHTML = html || '<div class="empty">空目录</div>';
  });
}

function openFilePicker() {
  $('file-modal').classList.remove('hidden');
  loadFileDir($('f-ssh-key').value.trim());
}

function saveConnection(event) {
  event.preventDefault();
  var payload = readForm();
  if (!payload.name || !payload.host || !payload.user) {
    toast('名称、主机、用户名必填', false);
    return;
  }
  api('/api/connections', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
    if (res && res.success) {
      toast(res.renamed ? '已重命名为：' + res.name : '已保存：' + res.name, true);
      load().then(function () { fillForm(findConnection(res.name) || null); });
    } else {
      toast((res && res.error) || '保存失败', false);
    }
  });
}

function testConnection() {
  var payload = readForm();
  toast('正在测试连接…', true);
  api('/api/connections/test', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
    toast(res.message || (res.success ? '连接成功' : '连接失败'), !!res.success);
  });
}

function handleConnAction(event) {
  var btn = event.target.closest('button[data-act]');
  if (!btn) return;
  var name = btn.getAttribute('data-name');
  var act = btn.getAttribute('data-act');
  var conn = findConnection(name);

  if (act === 'edit') {
    if (conn) fillForm(conn);
    return;
  }
  if (act === 'activate') {
    api('/api/connections/' + encodeURIComponent(name) + '/activate', { method: 'POST' }).then(function (res) {
      toast(res.success ? '已切换到 ' + name : (res.error || '切换失败'), !!res.success);
      load();
    });
    return;
  }
  if (act === 'test') {
    if (!conn) return;
    api('/api/connections/test', {
      method: 'POST',
      body: JSON.stringify({ ...conn, originalName: conn.name, password: '' })
    }).then(function (res) {
      toast(res.message || (res.success ? '连接成功' : '连接失败'), !!res.success);
    });
    return;
  }
  if (act === 'delete') {
    if (!confirm('确定删除连接「' + name + '」？')) return;
    fetch('/api/connections/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (res) { return res.json(); })
      .then(function (res) {
        toast(res.success ? '已删除' : (res.error || '删除失败'), !!res.success);
        if (state.editing === name) fillForm(null);
        load();
      });
  }
}

function savePermissions() {
  var next = { test: {}, prod: {} };
  var boxes = document.querySelectorAll('#perm-grid input[type=checkbox]');
  for (var i = 0; i < boxes.length; i++) {
    next[boxes[i].getAttribute('data-env')][boxes[i].getAttribute('data-op')] = boxes[i].checked;
  }
  api('/api/permissions', { method: 'PUT', body: JSON.stringify(next) }).then(function (res) {
    if (res && res.success) {
      state.permissions = res.permissions;
      toast('权限已保存', true);
      render();
    } else {
      toast('保存失败', false);
    }
  });
}

function switchTab(tab) {
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
  }
  $('panel-connections').classList.toggle('active', tab === 'connections');
  $('panel-permissions').classList.toggle('active', tab === 'permissions');
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', '#' + tab);
  }
}

document.querySelector('.tabs').addEventListener('click', function (event) {
  var tab = event.target.closest('.tab');
  if (tab) switchTab(tab.getAttribute('data-tab'));
});
$('conn-form').addEventListener('submit', saveConnection);
$('f-ssh-enabled').addEventListener('change', toggleSshFields);
$('btn-ssh-key').addEventListener('click', openFilePicker);
$('btn-file-close').addEventListener('click', function () { $('file-modal').classList.add('hidden'); });
$('file-modal').addEventListener('click', function (event) {
  if (event.target === $('file-modal')) $('file-modal').classList.add('hidden');
});
$('file-list').addEventListener('click', function (event) {
  var item = event.target.closest('.file-item');
  if (!item) return;
  var dir = item.getAttribute('data-dir');
  if (dir) {
    loadFileDir(dir);
    return;
  }
  $('f-ssh-key').value = item.getAttribute('data-file');
  $('file-modal').classList.add('hidden');
});
$('conn-filter').addEventListener('click', function (event) {
  var tab = event.target.closest('.filter-tab');
  if (tab) setFilter(tab.getAttribute('data-filter'));
});
$('btn-test').addEventListener('click', testConnection);
$('btn-cancel').addEventListener('click', function () { fillForm(null); });
$('btn-save-perms').addEventListener('click', savePermissions);
$('conn-list').addEventListener('click', handleConnAction);

fillForm(null);
load();

if (window.location.hash === '#permissions') {
  switchTab('permissions');
}
</script>
</body>
</html>`;
}
