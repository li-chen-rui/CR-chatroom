/* ============================================================
   登录 / 注册页逻辑
   ============================================================ */

function setAuthError(msg) {
  var el = document.getElementById('authError');
  if (el) el.textContent = msg || '';
}

function setAuthLoading(loading) {
  var btn = document.getElementById('authBtn');
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '请稍候...';
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
  }
}

async function checkAlreadyLoggedIn() {
  try {
    var res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) window.location.href = '/chatroom';
  } catch (e) {}
}

async function handleLogin() {
  var u = document.getElementById('username').value.trim();
  var p = document.getElementById('password').value.trim();
  setAuthError('');
  if (!u || !p) { setAuthError('请输入账号和密码！'); return; }

  setAuthLoading(true);
  try {
    var res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    setAuthLoading(false);
    if (!res.ok) { setAuthError(data.error || '登录失败'); return; }
    window.location.href = '/chatroom';
  } catch (e) {
    setAuthLoading(false);
    setAuthError('网络错误，请重试');
  }
}

async function handleRegister() {
  var u = document.getElementById('username').value.trim();
  var p = document.getElementById('password').value.trim();
  var code = document.getElementById('inviteCode').value.trim();
  setAuthError('');
  if (!u || !p) { setAuthError('请输入账号和密码！'); return; }
  if (!code) { setAuthError('请输入邀请码！'); return; }

  setAuthLoading(true);
  try {
    var res = await fetch('/api/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p, inviteCode: code })
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    setAuthLoading(false);
    if (!res.ok) { setAuthError(data.error || '注册失败'); return; }
    window.location.href = '/chatroom';
  } catch (e) {
    setAuthLoading(false);
    setAuthError('网络错误，请重试');
  }
}

function setupPasswordToggle(inputId, btnId) {
  var input = document.getElementById(inputId);
  var btn = document.getElementById(btnId);
  if (!input || !btn) return;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    var isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.classList.toggle('is-visible', isHidden);
    btn.setAttribute('aria-label', isHidden ? '隐藏密码' : '显示密码');
    btn.innerHTML = isHidden ? icon('eyeOff', 16) : icon('eye', 16);
  });
}

window.addEventListener('DOMContentLoaded', function () {
  setupPasswordToggle('password', 'passwordToggle');
});