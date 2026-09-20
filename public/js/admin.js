var currentUser = null;
var state = { users: [], settings: {} };
var ws = null;
var uploads = [];
var isBatchUserMode = false;
var isBatchProcMode = false;
var isBatchChatMode = false;
var lastQueryResult = [];

async function bootstrapAdmin() {
  initTheme();

  var me = await apiGet('/api/me');
  if (!me.ok || me.data.role !== 'admin') { location.href = '/chatroom'; return; }
  currentUser = me.data;

  document.getElementById('adminContainer').style.display = 'flex';
  document.getElementById('userInfoHeader').textContent = '— ' + me.data.username + ' (管理员)';

  document.getElementById('brandIcon').innerHTML = icon('chat', 18);
  document.getElementById('backIcon').innerHTML = icon('arrowLeft', 16);
  document.getElementById('uIcon').innerHTML = icon('users', 16);
  document.getElementById('sIcon').innerHTML = icon('settings', 16);
  document.getElementById('pIcon').innerHTML = icon('upload', 16);
  document.getElementById('cIcon').innerHTML = icon('trash', 16);
  document.getElementById('sideUsersIcon').innerHTML = icon('users', 16);
  document.getElementById('sideLimitsIcon').innerHTML = icon('settings', 16);
  document.getElementById('sideUploadsIcon').innerHTML = icon('upload', 16);
  document.getElementById('sideChatIcon').innerHTML = icon('trash', 16);

  switchTab('users');
  onDelModeChange();
  bindContextMenu();
  initWS();
}

function switchTab(tab) {
  var items = document.querySelectorAll('.side-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', items[i].dataset.tab === tab);
  }
  var panels = document.querySelectorAll('.tab-panel');
  for (var j = 0; j < panels.length; j++) {
    panels[j].style.display = (panels[j].id === 'tab-' + tab) ? 'block' : 'none';
  }
}

function onDelModeChange() {
  var mode = document.querySelector('input[name="delMode"]:checked').value;
  document.getElementById('delBefore').disabled = (mode !== 'before');
  document.getElementById('delAfter').disabled = (mode !== 'after');
  document.getElementById('delFrom').disabled = (mode !== 'range');
  document.getElementById('delTo').disabled = (mode !== 'range');
}

function toMs(localStr) {
  if (!localStr) return null;
  var ms = new Date(localStr).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function buildQueryParams() {
  var mode = document.querySelector('input[name="delMode"]:checked').value;
  var keyword = (document.getElementById('chatKeyword').value || '').trim();

  if (mode === 'before') {
    var b = toMs(document.getElementById('delBefore').value);
    if (b === null) { alert('请选择时间'); return null; }
    return { mode: 'before', before: b, keyword: keyword };
  }
  if (mode === 'after') {
    var a = toMs(document.getElementById('delAfter').value);
    if (a === null) { alert('请选择时间'); return null; }
    return { mode: 'after', after: a, keyword: keyword };
  }
  var f = toMs(document.getElementById('delFrom').value);
  var t = toMs(document.getElementById('delTo').value);
  if (f === null || t === null) { alert('请选择起止时间'); return null; }
  if (f > t) { alert('起始时间不能晚于结束时间'); return null; }
  return { mode: 'range', from: f, to: t, keyword: keyword };
}

async function queryMessages() {
  var p = buildQueryParams();
  if (!p) return;
  var r = await apiPost('/api/messages/admin/query-range', p);
  var box = document.getElementById('chatResult');
  if (!r.ok) { box.innerHTML = '<div class="settings-hint">查询失败</div>'; return; }
  lastQueryResult = r.data.messages || [];
  box.innerHTML =
    '<div class="settings-kv">匹配条数: <b>' + r.data.count + '</b>（最多预览 200 条）</div>' +
    (lastQueryResult.length ? lastQueryResult.map(function (m) {
      return '<label class="chat-result-item">' +
        (isBatchChatMode ? '<input type="checkbox" class="chat-select" value="' + m.id + '">' : '') +
        '<div class="cri-main">' +
          '<div class="cd-meta">' + (m.timestamp || '') + ' · ' + escapeHtml(m.username) + '</div>' +
          '<div class="cd-content">' + escapeHtml((m.content || '').slice(0, 120)) + '</div>' +
        '</div>' +
        '<button class="btn btn-danger" onclick="deleteOneMessage(\'' + m.id + '\')">删除</button>' +
      '</label>';
    }).join('') : '<div class="settings-hint">无匹配消息</div>');
}

/* 单条删除：不再确认 */
async function deleteOneMessage(id) {
  var r = await apiPost('/api/messages/delete', { ids: [id] });
  if (!r.ok) { alert(r.data.error || '删除失败'); return; }
  queryMessages();
}

/* 批量删除选中：仍提示"未选择"，不再确认 */
async function batchDeleteSelected() {
  var els = document.querySelectorAll('.chat-select:checked');
  var ids = [];
  for (var i = 0; i < els.length; i++) ids.push(els[i].value);
  if (!ids.length) { alert('请选择要删除的消息！'); return; }
  var r = await apiPost('/api/messages/delete', { ids: ids });
  if (!r.ok) { alert(r.data.error || '删除失败'); return; }
  queryMessages();
}

/* 清空筛选：不再确认 */
async function deleteAllFiltered() {
  if (!lastQueryResult.length) { alert('请先查询'); return; }
  var ids = lastQueryResult.map(function (m) { return m.id; });
  var r = await apiPost('/api/messages/delete', { ids: ids });
  if (!r.ok) { alert(r.data.error || '删除失败'); return; }
  queryMessages();
}

function toggleChatBatch(enable) {
  isBatchChatMode = enable;
  document.getElementById('btnBatchChat').style.display = enable ? 'none' : 'inline-flex';
  document.getElementById('chatBatchActions').style.display = enable ? 'inline-flex' : 'none';
  queryMessages();
}

function initWS() {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onmessage = function (event) {
    var data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (data.type === 'state_update') {
      state.users = data.users || [];
      state.settings = data.settings || {};
      renderUsers();
      renderSettings();
    } else if (data.type === 'upload_update') {
      uploads = data.uploads || [];
      renderUploads();
    }
  };
  ws.onclose = function () { setTimeout(initWS, 1500); };
}

function toggleUserBatch(enable) {
  isBatchUserMode = enable;
  document.getElementById('btnBatchUser').style.display = enable ? 'none' : 'inline-flex';
  document.getElementById('userBatchActions').style.display = enable ? 'inline-flex' : 'none';
  renderUsers();
}

function collectChecked(selector) {
  var set = {};
  var els = document.querySelectorAll(selector);
  for (var i = 0; i < els.length; i++) set[els[i].value] = true;
  return set;
}

function renderUsers() {
  var selected = collectChecked('.user-select:checked');
  var box = document.getElementById('adminUserList');
  box.innerHTML = state.users.map(function (u) {
    var checkbox = (isBatchUserMode && u.role !== 'admin')
      ? '<input type="checkbox" class="user-select" value="' + escapeHtml(u.username) + '"' + (selected[u.username] ? ' checked' : '') + '>'
      : '';
    var badgeCls = u.role === 'admin' ? 'badge-admin' : (u.role === 'banned' ? 'badge-banned' : 'badge-user');
    var btns = '';
    if (u.role !== 'admin') {
      btns += (u.role === 'banned')
        ? '<button class="btn btn-success" onclick="userAction(\'' + escapeHtml(u.username) + '\',\'unban\')">解封</button>'
        : '<button class="btn btn-warning" onclick="userAction(\'' + escapeHtml(u.username) + '\',\'ban\')">封禁</button>';
      btns += '<button class="btn btn-danger" onclick="userAction(\'' + escapeHtml(u.username) + '\',\'delete\')">删除</button>';
    }
    return '' +
      '<div class="user-item" data-username="' + escapeHtml(u.username) + '" data-role="' + u.role + '">' +
        '<div class="user-info">' + checkbox +
          '<span class="status-dot ' + (u.isOnline ? 'status-online' : 'status-offline') + '"></span>' +
          '<strong>' + escapeHtml(u.username) + '</strong>' +
        '</div>' +
        '<div class="user-actions">' +
          '<span class="badge ' + badgeCls + '">' + u.role + '</span>' + btns +
        '</div>' +
      '</div>';
  }).join('');
}

function renderSettings() {
  document.getElementById('cfgMaxUploads').value = state.settings.maxSimultaneousUploads || 1;
  document.getElementById('cfgMaxSpeed').value = state.settings.userSpeedLimitMB || 2;
  document.getElementById('cfgMaxFileSize').value = state.settings.maxFileSizeMB || 100;
}

function toggleProcBatch(enable) {
  isBatchProcMode = enable;
  document.getElementById('btnBatchProc').style.display = enable ? 'none' : 'inline-flex';
  document.getElementById('procBatchActions').style.display = enable ? 'inline-flex' : 'none';
  renderUploads();
}

function renderUploads() {
  var selected = collectChecked('.proc-select:checked');
  var box = document.getElementById('adminUploads');
  if (!uploads.length) { box.innerHTML = '<div class="settings-hint">当前无上传任务</div>'; return; }
  box.innerHTML = uploads.map(function (u) {
    var checkbox = isBatchProcMode
      ? '<input type="checkbox" class="proc-select" value="' + u.id + '"' + (selected[u.id] ? ' checked' : '') + '>'
      : '';
    return '' +
      '<div class="proc-item" data-id="' + u.id + '" data-username="' + escapeHtml(u.username) + '">' +
        '<div class="proc-row">' +
          '<label class="proc-name">' + checkbox +
            '<strong>' + escapeHtml(u.fileName) + '</strong>' +
          '</label>' +
          '<span class="proc-speed">' + u.speed + '</span>' +
        '</div>' +
        '<div class="proc-sub">用户: ' + escapeHtml(u.username) + ' | ' + u.progress + '%</div>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + u.progress + '%"></div></div>' +
      '</div>';
  }).join('');
}

/* 批量终止：仍提示"未选择"，不再确认 */
async function batchCancelUploads() {
  var els = document.querySelectorAll('.proc-select:checked');
  var ids = [];
  for (var i = 0; i < els.length; i++) ids.push(els[i].value);
  if (!ids.length) { alert('请选择要终止的上传任务！'); return; }
  await apiPost('/api/upload/cancel', { uploadIds: ids });
  toggleProcBatch(false);
}

/* 单个终止：不再确认 */
async function cancelOneUpload(uploadId) {
  await apiPost('/api/upload/cancel', { uploadIds: [uploadId] });
}

/* 单个用户操作：不再确认 */
async function userAction(username, action) {
  await apiPost('/api/admin/users/action', { usernames: [username], action: action });
}

/* 批量用户操作：仍提示"未选择"，不再确认 */
async function batchUserAction(action) {
  var els = document.querySelectorAll('.user-select:checked');
  var usernames = [];
  for (var i = 0; i < els.length; i++) usernames.push(els[i].value);
  if (!usernames.length) { alert('请选择要操作的用户！'); return; }
  await apiPost('/api/admin/users/action', { usernames: usernames, action: action });
  toggleUserBatch(false);
}

async function saveSettings() {
  var a = document.getElementById('cfgMaxUploads').value;
  var b = document.getElementById('cfgMaxSpeed').value;
  var c = document.getElementById('cfgMaxFileSize').value;
  var r = await apiPost('/api/admin/settings', { maxSimultaneousUploads: a, userSpeedLimitMB: b, maxFileSizeMB: c });
  if (r.ok) alert('已保存');
  else alert(r.data.error || '保存失败');
}

function bindContextMenu() {
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t.closest('.user-item') && !t.closest('.proc-item')) hideContextMenu();
  });
  document.getElementById('adminUserList').addEventListener('contextmenu', onUserContextMenu);
  document.getElementById('adminUploads').addEventListener('contextmenu', onProcContextMenu);
}

function onUserContextMenu(e) {
  var item = e.target.closest('.user-item');
  if (!item) return;
  e.preventDefault();
  var username = item.dataset.username;
  var role = item.dataset.role;
  if (role === 'admin') { hideContextMenu(); return; }

  var menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  addMenuItem(menu, 'ban', '封禁账号', function () { userAction(username, 'ban'); });
  addMenuItem(menu, 'check', '解封账号', function () { userAction(username, 'unban'); });
  addMenuItem(menu, 'trash', '删除账号', function () { userAction(username, 'delete'); }, true);
  showContextMenu(e.clientX, e.clientY, menu);
}

function onProcContextMenu(e) {
  var item = e.target.closest('.proc-item');
  if (!item) return;
  e.preventDefault();
  var uploadId = item.dataset.id;

  var menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  addMenuItem(menu, 'stop', '终止此上传', function () { cancelOneUpload(uploadId); }, true);
  showContextMenu(e.clientX, e.clientY, menu);
}

function addMenuItem(menu, iconName, text, onClick, danger) {
  var el = document.createElement('div');
  el.className = 'context-menu-item' + (danger ? ' danger' : '');
  el.innerHTML = icon(iconName, 14) + '<span>' + text + '</span>';
  el.onclick = function () { hideContextMenu(); onClick(); };
  menu.appendChild(el);
}
function showContextMenu(x, y, menu) {
  menu.style.display = 'block';
  var rect = menu.getBoundingClientRect();
  var maxX = window.innerWidth - rect.width - 4;
  var maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}
function hideContextMenu() {
  var menu = document.getElementById('contextMenu');
  if (menu) menu.style.display = 'none';
}