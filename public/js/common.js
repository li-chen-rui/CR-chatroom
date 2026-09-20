/* ============================================================
   公共工具
   ============================================================ */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var icons = document.querySelectorAll('[data-theme-icon]');
  for (var i = 0; i < icons.length; i++) {
    icons[i].innerHTML = (theme === 'dark') ? icon('moon', 16) : icon('sun', 16);
  }
  var labels = document.querySelectorAll('[data-theme-label]');
  for (var j = 0; j < labels.length; j++) {
    labels[j].textContent = (theme === 'dark') ? '深色' : '浅色';
  }
  try { localStorage.setItem('cr-theme', theme); } catch (e) {}
}

function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

function initTheme() {
  var theme = null;
  try { theme = localStorage.getItem('cr-theme'); } catch (e) {}
  if (!theme) {
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  applyTheme(theme);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function apiGet(url) {
  var res = await fetch(url, { credentials: 'same-origin' });
  var data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, data: data };
}

async function apiPost(url, body) {
  var res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  var data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, data: data };
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function showToast(text) {
  var el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.classList.remove('show'); }, 1500);
}

function themeToggleHtml() {
  return '<button class="theme-toggle" type="button" onclick="toggleTheme()" aria-label="切换主题">' +
    '<span data-theme-icon>' + icon('sun', 16) + '</span>' +
    '<span data-theme-label>浅色</span>' +
    '</button>';
}