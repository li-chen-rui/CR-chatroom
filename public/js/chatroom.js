/* ============================================================
   聊天室主逻辑（按天加载 + 增量 DOM 更新）
   ============================================================ */

var currentUser = null;
var ws = null;
var state = { users: [], messages: [], settings: {} };
var uploadsByMessage = {};
var liveUploads = [];

var isBatchMsgMode = false;
var isBatchUserMode = false;

var oldestLoadedDay = null;
var hasMoreHistory = false;
var loadingMore = false;
var autoScrollEnabled = true;

// 消息 id -> DOM 节点
var messageNodeMap = {};
var messageContainerEl = null;

// 渲染合并
var pendingRenderUsers = false;

async function bootstrapChatroom() {
  initTheme();

  var me = await apiGet('/api/me');
  if (!me.ok) { location.href = '/login'; return; }
  currentUser = me.data;

  document.getElementById('appContainer').style.display = 'flex';
  var roleName = currentUser.role === 'admin' ? '管理员' : '普通用户';
  document.getElementById('userInfoHeader').textContent = '— ' + currentUser.username + ' (' + roleName + ')';

  if (currentUser.role === 'admin') {
    document.getElementById('adminLink').style.display = 'inline-flex';
  }

  messageContainerEl = document.getElementById('messageContainer');

  injectIcons();
  await loadInitialMessages();
  initWebSocket();
  bindContextMenu();
  bindScroll();
}

function injectIcons() {
  var map = {
    'brandIcon': 'chat',
    'chatTitleIcon': 'chat',
    'userTitleIcon': 'users',
    'logoutBtnIcon': 'logout',
    'sendBtnIcon': 'send',
    'fileBtnIcon': 'paperclip',
    'adminLinkIcon': 'shield'
  };
  for (var id in map) {
    if (!map.hasOwnProperty(id)) continue;
    var el = document.getElementById(id);
    if (el) el.innerHTML = icon(map[id], 16);
  }
}

/* ============================================================
   按天加载
   ============================================================ */
async function loadInitialMessages() {
  var r = await apiGet('/api/messages/latest-day');
  if (!r.ok) {
    updateLoadMoreButton();
    renderUsers();
    return;
  }

  state.messages = r.data.messages || [];
  state.messages.sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });

  oldestLoadedDay = r.data.date || null;
  hasMoreHistory = !!r.data.hasMore;

  renderMessagesFull();
  updateLoadMoreButton();
  scrollToBottom();
}

async function loadMoreMessages() {
  if (loadingMore || !hasMoreHistory || !oldestLoadedDay) return;

  loadingMore = true;
  updateLoadMoreButton();

  var chatList = document.getElementById('chatList');
  var prevHeight = chatList.scrollHeight;
  var prevTop = chatList.scrollTop;

  var r = await apiGet('/api/messages/day-before?date=' + encodeURIComponent(oldestLoadedDay));
  if (r.ok) {
    var older = r.data.messages || [];
    if (r.data.date) {
      oldestLoadedDay = r.data.date;
      hasMoreHistory = !!r.data.hasMore;
    } else {
      hasMoreHistory = false;
    }

    var exist = {};
    state.messages.forEach(function (m) { exist[m.id] = true; });
    var filtered = older.filter(function (m) { return !exist[m.id]; });

    if (filtered.length) {
      // 把新节点 prepend 到 container 前面，保留已有 DOM
      var frag = document.createDocumentFragment();
      filtered.sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
      filtered.forEach(function (m) {
        var node = createMessageNode(m);
        messageNodeMap[m.id] = node;
        frag.appendChild(node);
      });

      // 只对新节点渲染 KaTeX
      filtered.forEach(function (m) {
        var node = messageNodeMap[m.id];
        var md = node.querySelector('.msg-md[data-md="1"]');
        if (md) renderKatexIn(md);
      });

      // 插到最前
      if (messageContainerEl.firstChild) {
        messageContainerEl.insertBefore(frag, messageContainerEl.firstChild);
      } else {
        messageContainerEl.appendChild(frag);
      }

      // 合并到 state（保持排序）
      state.messages = filtered.concat(state.messages);
      state.messages.sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
    }

    requestAnimationFrame(function () {
      var newHeight = chatList.scrollHeight;
      chatList.scrollTop = newHeight - prevHeight + prevTop;
    });
  }

  loadingMore = false;
  updateLoadMoreButton();
}

function updateLoadMoreButton() {
  var wrap = document.getElementById('loadMoreWrap');
  var btn = document.getElementById('loadMoreBtn');
  var tip = document.getElementById('loadMoreTip');
  var empty = document.getElementById('chatEmpty');
  if (!wrap) return;

  wrap.style.display = 'flex';

  if (hasMoreHistory) {
    btn.style.display = 'inline-flex';
    tip.style.display = 'none';
    btn.disabled = loadingMore;
    btn.textContent = loadingMore ? '加载中...' : '加载前一天';
  } else {
    btn.style.display = 'none';
    tip.style.display = 'block';
  }

  if (empty) empty.style.display = state.messages.length ? 'none' : 'block';
}

function bindScroll() {
  var chatList = document.getElementById('chatList');
  chatList.addEventListener('scroll', function () {
    autoScrollEnabled = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
  });
}

function scrollToBottom() {
  var chatList = document.getElementById('chatList');
  chatList.scrollTop = chatList.scrollHeight;
}

/* ============================================================
   WebSocket
   ============================================================ */
function initWebSocket() {
  if (ws) { try { ws.close(); } catch (e) {} }
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);

  ws.onmessage = function (event) {
    var data;
    try { data = JSON.parse(event.data); } catch (e) { return; }

    if (data.type === 'state_update') {
      // 只更新用户 + 设置，不重绘消息
      state.users = data.users || [];
      state.settings = data.settings || {};
      scheduleRenderUsers();

    } else if (data.type === 'message_new') {
      handleMessageNew(data.message);

    } else if (data.type === 'message_update') {
      handleMessageUpdate(data.message);

    } else if (data.type === 'messages_deleted') {
      handleMessagesDeleted(data.ids || []);

    } else if (data.type === 'upload_update') {
      liveUploads = data.uploads || [];
      uploadsByMessage = {};
      liveUploads.forEach(function (u) {
        if (u.messageId) uploadsByMessage[u.messageId] = u;
      });
      liveUploads.forEach(function (u) {
        if (u.messageId) updateUploadProgressDom(u.messageId, u);
      });

    } else if (data.type === 'upload_progress') {
      var info = data.info || {};
      var task = null;
      for (var i = 0; i < liveUploads.length; i++) {
        if (liveUploads[i].id === data.uploadId) { task = liveUploads[i]; break; }
      }
      if (task && task.messageId) {
        var merged = {
          uploaded: info.uploaded,
          size: info.size || task.size,
          speed: info.speed || 0,
          progress: info.progress || 0
        };
        uploadsByMessage[task.messageId] = merged;
        updateUploadProgressDom(task.messageId, merged);
      }
    }
  };

  ws.onclose = function () {
    setTimeout(function () { if (currentUser) initWebSocket(); }, 1500);
  };
}

/* ============================================================
   增量消息更新
   ============================================================ */
function handleMessageNew(msg) {
  if (!msg) return;
  if (messageNodeMap[msg.id]) return;

  var msgDay = dayKeyFromMs(msg.timestampMs);
  if (oldestLoadedDay && msgDay < oldestLoadedDay) {
    oldestLoadedDay = msgDay;
  }

  // 按 timestampMs 插入到正确位置
  var insertIndex = state.messages.length;
  for (var i = 0; i < state.messages.length; i++) {
    if ((state.messages[i].timestampMs || 0) > (msg.timestampMs || 0)) {
      insertIndex = i;
      break;
    }
  }
  state.messages.splice(insertIndex, 0, msg);

  // DOM 插入
  var newNode = createMessageNode(msg);
  messageNodeMap[msg.id] = newNode;

  // 找下一个已存在消息的节点作为参考
  var refNode = null;
  for (var j = insertIndex + 1; j < state.messages.length; j++) {
    var ref = messageNodeMap[state.messages[j].id];
    if (ref) { refNode = ref; break; }
  }
  if (refNode && refNode.parentNode === messageContainerEl) {
    messageContainerEl.insertBefore(newNode, refNode);
  } else {
    messageContainerEl.appendChild(newNode);
  }

  // 渲染公式
  var md = newNode.querySelector('.msg-md[data-md="1"]');
  if (md) renderKatexIn(md);

  updateLoadMoreButton();
  if (autoScrollEnabled) scrollToBottom();
}

function handleMessageUpdate(msg) {
  if (!msg) return;

  var idx = -1;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id === msg.id) { idx = i; break; }
  }
  if (idx >= 0) state.messages[idx] = msg;
  else state.messages.push(msg);

  var oldNode = messageNodeMap[msg.id];
  var newNode = createMessageNode(msg);

  if (oldNode && oldNode.parentNode) {
    oldNode.parentNode.replaceChild(newNode, oldNode);
  } else {
    messageContainerEl.appendChild(newNode);
  }
  messageNodeMap[msg.id] = newNode;

  var md = newNode.querySelector('.msg-md[data-md="1"]');
  if (md) renderKatexIn(md);
}

function handleMessagesDeleted(ids) {
  var set = {};
  ids.forEach(function (id) { set[id] = true; });

  state.messages = state.messages.filter(function (m) { return !set[m.id]; });

  ids.forEach(function (id) {
    var node = messageNodeMap[id];
    if (node && node.parentNode) node.parentNode.removeChild(node);
    delete messageNodeMap[id];
  });

  updateLoadMoreButton();
}

/* ============================================================
   上传进度：局部 DOM 更新
   ============================================================ */
function updateUploadProgressDom(messageId, info) {
  var item = messageNodeMap[messageId];
  if (!item) return;

  var progress = Number(info.progress) || 0;
  var progressText = progress.toFixed(2);
  var speedBytes = Number(info.speed) || 0;
  var uploadedBytes = Number(info.uploaded) || 0;
  var sizeBytes = Number(info.size) || 0;

  var fill = item.querySelector('.progress-fill');
  if (fill) fill.style.width = progressText + '%';

  var meta = item.querySelector('.msg-file-meta');
  if (meta) {
    var uploadedText = fmtMB(uploadedBytes) + ' / ' + (sizeBytes ? fmtMB(sizeBytes) : '0.00 MB');
    var speedText = fmtSpeed(speedBytes);
    meta.textContent = uploadedText + ' · ' + speedText + ' · ' + progressText + '%';
  }
}

function dayKeyFromMs(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function logout() {
  await apiPost('/api/logout', {});
  if (ws) { try { ws.close(); } catch (e) {} }
  currentUser = null;
  location.href = '/login';
}

/* ============================================================
   输入框
   ============================================================ */
function autoGrow(el) {
  el.style.height = 'auto';
  var max = 160;
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}
function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
}
function resetInput() {
  var input = document.getElementById('msgInput');
  input.value = '';
  input.style.height = '36px';
}

/* ============================================================
   渲染：用户列表（合并多次调用）
   ============================================================ */
function scheduleRenderUsers() {
  if (pendingRenderUsers) return;
  pendingRenderUsers = true;
  requestAnimationFrame(function () {
    pendingRenderUsers = false;
    renderUsers();
  });
}

function toggleBatchMode(type, enable) {
  if (type === 'msg') isBatchMsgMode = enable;
  if (type === 'user') isBatchUserMode = enable;

  document.getElementById('btnBatchMsg').style.display = isBatchMsgMode ? 'none' : 'inline-flex';
  document.getElementById('msgBatchActions').style.display = isBatchMsgMode ? 'inline-flex' : 'none';

  var isAdmin = currentUser && currentUser.role === 'admin';
  document.getElementById('btnBatchUser').style.display = (isAdmin && !isBatchUserMode) ? 'inline-flex' : 'none';
  document.getElementById('userBatchActions').style.display = (isAdmin && isBatchUserMode) ? 'inline-flex' : 'none';

  // 批量模式切换会影响消息里的选择框，需重绘消息列表
  renderMessagesFull();
}

function collectChecked(selector) {
  var set = {};
  var els = document.querySelectorAll(selector);
  for (var i = 0; i < els.length; i++) set[els[i].value] = true;
  return set;
}

function fmtTime(m) {
  if (m.timestamp && /^\d{4}-\d{2}-\d{2}\s/.test(m.timestamp)) return m.timestamp;
  if (m.timestampMs) {
    var d = new Date(m.timestampMs);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  return '';
}

function fmtProgress(v) {
  var n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}
function fmtSpeed(bytesPerSec) {
  var mbps = (Number(bytesPerSec) || 0) / 1024 / 1024;
  return mbps.toFixed(2) + ' MB/s';
}
function fmtMB(bytes) {
  var mb = (Number(bytes) || 0) / 1024 / 1024;
  return mb.toFixed(2) + ' MB';
}

/* 全量重绘消息列表（仅初次加载 / 加载更多 / 批量模式切换） */
function renderMessagesFull() {
  messageContainerEl.innerHTML = '';
  messageNodeMap = {};

  if (!state.messages.length) return;

  var frag = document.createDocumentFragment();
  var mdNodes = [];

  state.messages.forEach(function (m) {
    var node = createMessageNode(m);
    messageNodeMap[m.id] = node;
    frag.appendChild(node);

    var md = node.querySelector('.msg-md[data-md="1"]');
    if (md) mdNodes.push(md);
  });

  messageContainerEl.appendChild(frag);

  // 统一渲染 KaTeX
  for (var i = 0; i < mdNodes.length; i++) renderKatexIn(mdNodes[i]);
}

/* 创建单条消息 DOM 节点 */
function createMessageNode(m) {
  var isSelf = currentUser && m.username === currentUser.username;
  var isFile = !!m.fileUrl;
  var isUploading = !!m.uploading;
  var uploadInfo = uploadsByMessage[m.id] || null;

  var useMd = m.markdown === true || m.markdown === 'true' || m.markdown === 1 || m.markdown === '1';

  var bodyHtml;
  if (isFile || isUploading) {
    bodyHtml = '<div>' + escapeHtml(m.content) + '</div>';
  } else {
    bodyHtml = '<div class="msg-md" data-md="' + (useMd ? '1' : '0') + '">' +
      renderMessageHtml(m.content, useMd) + '</div>';
  }

  var fileHtml = '';
  if (isUploading) {
    var progress = uploadInfo ? Number(uploadInfo.progress) : 0;
    var speedBytes = uploadInfo ? Number(uploadInfo.speed) : 0;
    var uploadedBytes = uploadInfo ? Number(uploadInfo.uploaded) : 0;
    var sizeBytes = uploadInfo ? Number(uploadInfo.size) : (Number(m.fileSize) || 0);

    var progressText = fmtProgress(progress);
    var speedText = fmtSpeed(speedBytes);
    var uploadedText = fmtMB(uploadedBytes) + ' / ' + (sizeBytes ? fmtMB(sizeBytes) : (m.fileSize || '0 MB'));

    fileHtml =
      '<div class="msg-file msg-uploading">' +
        '<div class="msg-file-row">' + icon('paperclip', 14) +
          '<span>' + escapeHtml(m.fileName || m.content) + '</span>' +
        '</div>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + progressText + '%"></div></div>' +
        '<div class="msg-file-meta">' + uploadedText + ' · ' + speedText + ' · ' + progressText + '%</div>' +
      '</div>';
  } else if (isFile) {
    fileHtml =
      '<div class="msg-file">' + icon('paperclip', 14) +
        '<a href="' + m.fileUrl + '" target="_blank" rel="noopener">' + escapeHtml(m.fileName) + '</a>' +
        '<span class="msg-file-size">(' + m.fileSize + ')</span>' +
      '</div>';
  }

  var editedTag = m.edited ? '<span class="msg-edited">(已编辑)</span>' : '';
  var canDelete = isSelf || (currentUser && currentUser.role === 'admin');

  var actionsHtml = isBatchMsgMode ? '' :
    '<div class="msg-actions">' +
      '<button class="msg-action-btn" title="复制" onclick="copyMessage(\'' + m.id + '\')">' + icon('copy', 14) + '</button>' +
      (canDelete ? '<button class="msg-action-btn danger" title="删除" onclick="deleteSingleMessage(\'' + m.id + '\')">' + icon('trash', 14) + '</button>' : '') +
    '</div>';

  var checkbox = isBatchMsgMode
    ? '<input type="checkbox" class="msg-select" value="' + m.id + '">'
    : '';

  var wrapper = document.createElement('div');
  wrapper.innerHTML =
    '<div class="msg-item ' + (isSelf ? 'self' : 'other') + (isUploading ? ' uploading' : '') + '"' +
         ' data-id="' + m.id + '"' +
         ' data-username="' + escapeHtml(m.username) + '"' +
         ' data-markdown="' + (useMd ? '1' : '0') + '">' +
      checkbox +
      '<div class="msg-main">' +
        '<div class="msg-bubble">' +
          '<div class="msg-content">' +
            '<div class="msg-meta"><strong>' + escapeHtml(m.username) + '</strong> · ' + fmtTime(m) + ' ' + editedTag + '</div>' +
            bodyHtml +
            fileHtml +
          '</div>' +
        '</div>' +
        actionsHtml +
      '</div>' +
    '</div>';
  return wrapper.firstElementChild;
}

function renderUsers() {
  var isAdmin = currentUser && currentUser.role === 'admin';
  var selectedUsers = collectChecked('.user-select:checked');
  var box = document.getElementById('userList');

  box.innerHTML = state.users.map(function (u) {
    var checkbox = (isAdmin && isBatchUserMode)
      ? '<input type="checkbox" class="user-select" value="' + escapeHtml(u.username) + '"' +
        (selectedUsers[u.username] ? ' checked' : '') +
        (u.role === 'admin' ? ' disabled' : '') + '>'
      : '';
    var badgeCls = u.role === 'admin' ? 'badge-admin' : (u.role === 'banned' ? 'badge-banned' : 'badge-user');
    return '' +
      '<div class="user-item" data-username="' + escapeHtml(u.username) + '" data-role="' + u.role + '">' +
        '<div class="user-info">' + checkbox +
          '<span class="status-dot ' + (u.isOnline ? 'status-online' : 'status-offline') + '"></span>' +
          '<strong>' + escapeHtml(u.username) + '</strong>' +
        '</div>' +
        '<span class="badge ' + badgeCls + '">' + u.role + '</span>' +
      '</div>';
  }).join('');
}

/* ============================================================
   操作
   ============================================================ */
async function copyMessage(id) {
  var msg = null;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id === id) { msg = state.messages[i]; break; }
  }
  if (!msg) return;
  var ok = await copyToClipboard(msg.content || '');
  showToast(ok ? '已复制' : '复制失败');
}

async function deleteSingleMessage(id) {
  var msg = null;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id === id) { msg = state.messages[i]; break; }
  }
  if (!msg) return;
  var isOwner = currentUser && currentUser.username === msg.username;
  var isAdmin = currentUser && currentUser.role === 'admin';
  if (!isOwner && !isAdmin) { showToast('无权删除'); return; }

  var r = await apiPost('/api/messages/delete', { ids: [id] });
  if (!r.ok) { showToast(r.data.error || '删除失败'); return; }
  showToast('已删除');
}

function openEditMessage(id) {
  var msg = null;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id === id) { msg = state.messages[i]; break; }
  }
  if (!msg) return;
  var overlay = document.getElementById('editModal');
  overlay.classList.add('show');
  document.getElementById('editContent').value = msg.content || '';
  document.getElementById('editMarkdown').checked = !!msg.markdown;
  overlay.dataset.msgId = id;
}
function closeEditMessage() {
  document.getElementById('editModal').classList.remove('show');
}
async function submitEditMessage() {
  var overlay = document.getElementById('editModal');
  var id = overlay.dataset.msgId;
  var content = document.getElementById('editContent').value;
  var markdown = document.getElementById('editMarkdown').checked;
  if (!content.trim()) { showToast('内容不能为空'); return; }
  var r = await apiPost('/api/messages/edit', { id: id, content: content, markdown: markdown });
  if (!r.ok) { showToast(r.data.error || '编辑失败'); return; }
  closeEditMessage();
  showToast('已更新');
}

function bindContextMenu() {
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', function (e) {
    var t = e.target;
    if (!t.closest('.msg-item') && !t.closest('.user-item')) hideContextMenu();
  });
  messageContainerEl.addEventListener('contextmenu', onMessageContextMenu);
  document.getElementById('userList').addEventListener('contextmenu', onUserContextMenu);
}

function onMessageContextMenu(e) {
  if (isBatchMsgMode) return;
  var item = e.target.closest('.msg-item');
  if (!item) return;
  e.preventDefault();
  var id = item.dataset.id;
  var username = item.dataset.username;
  var msg = null;
  for (var i = 0; i < state.messages.length; i++) {
    if (state.messages[i].id === id) { msg = state.messages[i]; break; }
  }
  if (!msg) return;

  var isAdmin = currentUser && currentUser.role === 'admin';
  var isOwner = currentUser && currentUser.username === username;
  var isFile = !!msg.fileUrl;

  var menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  addMenuItem(menu, 'copy', '复制内容', function () { copyMessage(id); });
  if (isOwner && !isFile) addMenuItem(menu, 'edit', '编辑消息', function () { openEditMessage(id); });
  if (isAdmin || isOwner) addMenuItem(menu, 'trash', '删除消息', function () { deleteSingleMessage(id); }, true);
  showContextMenu(e.clientX, e.clientY, menu);
}

function onUserContextMenu(e) {
  if (isBatchUserMode) return;
  var item = e.target.closest('.user-item');
  if (!item) return;
  e.preventDefault();
  var username = item.dataset.username;
  var role = item.dataset.role;
  var isAdmin = currentUser && currentUser.role === 'admin';
  if (!isAdmin || role === 'admin') { hideContextMenu(); return; }

  var menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  addMenuItem(menu, 'ban', '封禁账号', function () { singleUserAction(username, 'ban'); });
  addMenuItem(menu, 'check', '解封账号', function () { singleUserAction(username, 'unban'); });
  addMenuItem(menu, 'trash', '删除账号', function () { singleUserAction(username, 'delete'); }, true);
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

async function sendText() {
  var input = document.getElementById('msgInput');
  var text = input.value;
  if (!text.trim()) return;
  var markdown = document.getElementById('mdToggle').checked;
  var r = await apiPost('/api/messages/send', { content: text, markdown: markdown });
  if (r.ok) resetInput();
  else alert(r.data.error || '发送失败');
}

async function deleteSelectedMessages() {
  var els = document.querySelectorAll('.msg-select:checked');
  var ids = [];
  for (var i = 0; i < els.length; i++) ids.push(els[i].value);
  if (!ids.length) { alert('请选择要删除的发言或文件！'); return; }
  await apiPost('/api/messages/delete', { ids: ids });
  toggleBatchMode('msg', false);
}

async function singleUserAction(username, action) {
  await apiPost('/api/admin/users/action', { usernames: [username], action: action });
}
async function batchUserAction(action) {
  var els = document.querySelectorAll('.user-select:checked');
  var usernames = [];
  for (var i = 0; i < els.length; i++) usernames.push(els[i].value);
  if (!usernames.length) { alert('请选择要操作的用户！'); return; }
  await apiPost('/api/admin/users/action', { usernames: usernames, action: action });
  toggleBatchMode('user', false);
}

/* ============================================================
   上传
   ============================================================ */
var CHUNK_SIZE = 2 * 1024 * 1024;

async function uploadFile() {
  var fileInput = document.getElementById('fileInput');
  if (!fileInput.files.length) { alert('请选择要上传的文件！'); return; }
  var file = fileInput.files[0];
  if (file.size <= 4 * 1024 * 1024) { uploadWholeFile(file, fileInput); return; }
  try {
    await uploadChunkedFile(file);
    fileInput.value = '';
  } catch (e) {
    alert('上传失败：' + (e.message || e));
  }
}

function uploadWholeFile(file, fileInput) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);
  xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
  xhr.onload = function () {
    if (xhr.status === 200) fileInput.value = '';
    else {
      try { alert(JSON.parse(xhr.responseText).error || '上传失败！'); }
      catch (e) { alert('上传失败！'); }
    }
  };
  xhr.onerror = function () { alert('上传失败：网络错误'); };
  xhr.send(file);
}

async function uploadChunkedFile(file) {
  var init = await apiPost('/api/upload/init', {
    fileName: file.name,
    size: file.size,
    chunkSize: CHUNK_SIZE
  });
  if (!init.ok) throw new Error(init.data.error || '初始化失败');

  var uploadId = init.data.uploadId;
  var totalChunks = init.data.totalChunks;
  var received = init.data.received || [];
  var receivedSet = {};
  received.forEach(function (i) { receivedSet[i] = true; });

  for (var i = 0; i < totalChunks; i++) {
    if (receivedSet[i]) continue;

    var start = i * CHUNK_SIZE;
    var end = Math.min(start + CHUNK_SIZE, file.size);
    var blob = file.slice(start, end);

    var baseUploaded = 0;
    for (var k = 0; k < i; k++) {
      if (receivedSet[k]) {
        baseUploaded += Math.min(CHUNK_SIZE, file.size - k * CHUNK_SIZE);
      }
    }

    await uploadChunkXHR(uploadId, i, blob, baseUploaded, file.size);
    receivedSet[i] = true;
  }

  var done = await apiPost('/api/upload/complete', { uploadId: uploadId });
  if (!done.ok) throw new Error(done.data.error || '合并失败');
  showToast('上传完成');
}

function uploadChunkXHR(uploadId, index, blob, baseUploaded, totalSize) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/chunk', true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-upload-id', uploadId);
    xhr.setRequestHeader('x-chunk-index', String(index));

    var lastUpdate = 0;
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var now = Date.now();
      if (now - lastUpdate < 120) return;
      lastUpdate = now;

      var totalUploaded = baseUploaded + e.loaded;
      var progress = totalSize ? Math.min(100, (totalUploaded / totalSize) * 100) : 0;

      var messageId = findMessageIdByUploadId(uploadId);
      if (messageId) {
        var info = {
          uploaded: totalUploaded,
          size: totalSize,
          speed: 0,
          progress: Number(progress.toFixed(2))
        };
        uploadsByMessage[messageId] = info;
        updateUploadProgressDom(messageId, info);
      }
    };

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        resolve(data);
      } else {
        var errMsg = '上传失败';
        try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch (e) {}
        reject(new Error(errMsg));
      }
    };
    xhr.onerror = function () { reject(new Error('网络错误')); };
    xhr.onabort = function () { reject(new Error('上传已中止')); };

    xhr.send(blob);
  });
}

function findMessageIdByUploadId(uploadId) {
  for (var i = 0; i < liveUploads.length; i++) {
    if (liveUploads[i].id === uploadId && liveUploads[i].messageId) {
      return liveUploads[i].messageId;
    }
  }
  for (var j = 0; j < state.messages.length; j++) {
    var m = state.messages[j];
    if (m.uploadId === uploadId && m.uploading) return m.id;
  }
  return null;
}