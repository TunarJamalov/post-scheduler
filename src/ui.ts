/**
 * Server-rendered pages. Client scripts are plain strings without template interpolation so
 * no server value is ever placed inside executable code.
 */
export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

const css = `
:root{--bg:#f4f6f8;--panel:#fff;--border:#dbe1e8;--text:#15202b;--muted:#5f6b7a;--ok:#15803d;--ok-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--warn:#b45309;--warn-bg:#fef3c7;--info:#1d4ed8;--info-bg:#dbeafe;--accent:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f141a;--panel:#171e26;--border:#2a3441;--text:#e6ebf0;--muted:#94a3b8;--ok:#4ade80;--ok-bg:#14532d;--bad:#fca5a5;--bad-bg:#7f1d1d;--warn:#fcd34d;--warn-bg:#78350f;--info:#93c5fd;--info-bg:#1e3a8a;--accent:#3b82f6}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:auto;padding:20px 16px;background:var(--bg);color:var(--text);line-height:1.45}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}
a{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:8px 0 16px;color:var(--muted)}
.panel,.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;background:var(--info-bg);color:var(--info);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.published{background:var(--ok-bg);color:var(--ok)}.badge.failed{background:var(--bad-bg);color:var(--bad)}.badge.publishing{background:var(--warn-bg);color:var(--warn)}.badge.draft,.badge.cancelled{background:var(--border);color:var(--muted)}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
button{padding:7px 11px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font:inherit;font-size:13px}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}
input,select,textarea{width:100%;padding:8px;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px}
textarea{min-height:160px;line-height:1.5}
label{display:block;font-size:13px}
form.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.full{grid-column:1/-1}
@media(max-width:700px){form.grid{grid-template-columns:1fr}.full{grid-column:auto}}
.summary{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
.summary span{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px}
.segment{white-space:pre-wrap;border-left:3px solid var(--border);padding:4px 10px;margin:6px 0;font-size:14px}
.counter{font-size:12px;color:var(--muted)}.counter.over{color:var(--bad);font-weight:600}
.msg{min-height:20px;margin:8px 0 0}.msg.error{color:var(--bad)}
.event{font-size:13px;padding:4px 0;border-top:1px solid var(--border)}
details summary{cursor:pointer;font-size:13px;color:var(--muted)}
.hidden{display:none !important}
pre{background:var(--bg);padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px}
`;

function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

const helpers = `
var $ = function (id) { return document.getElementById(id); };
var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var csrf = function () { var m = document.cookie.match(/(?:^|; )csrf=([^;]+)/); return m ? m[1] : ''; };
var api = function (url, method, body) {
  return fetch(url, { method: method || 'GET', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (r) { if (r.status === 401) { location = '/login'; throw new Error('Authentication required'); } return r; });
};
var showMessage = function (id, text, isError) { var el = $(id); el.textContent = text; el.className = 'msg' + (isError ? ' error' : ''); };
var when = function (ts) { return ts ? new Date(ts).toLocaleString() : ''; };
var LIMITS = { mastodon: 500, bluesky: 300 };
var splitThread = function (text) { return text.replace(/\\r\\n/g, '\\n').split(/\\n\\s*---\\s*\\n/).map(function (s) { return s.trim(); }).filter(Boolean); };
var countChars = function (s) { return Array.from(s).length; };
var toLocalInput = function (ts) { var d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
`;

const nav = (active: string) =>
  `<nav>${[
    ['/dashboard', 'Posts'],
    ['/dashboard/accounts', 'Accounts'],
    ['/dashboard/security', 'Security'],
  ]
    .map(([href, label]) =>
      href === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`
    )
    .join(' · ')} · <button id="logout">Log out</button></nav>`;
const logoutScript = `$('logout').onclick = function () { api('/api/auth/logout', 'POST').then(function () { location = '/login'; }); };`;

export function loginPage() {
  return page(
    'Sign in',
    `<section class="panel" style="max-width:420px;margin:40px auto"><h1>Sign in</h1><form id="f"><label>Username<input id="u" autocomplete="username" required></label><label>Password<input id="p" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code<input id="t" autocomplete="one-time-code" placeholder="Leave empty if TOTP is not enabled"></label><p><button class="primary">Sign in</button></p></form><p id="m" class="msg"></p></section>`,
    `document.getElementById('f').onsubmit = async function (e) {
  e.preventDefault();
  var auth = 'Basic ' + btoa(document.getElementById('u').value + ':' + document.getElementById('p').value);
  var r = await fetch('/api/auth/login', { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('t').value }) });
  if (r.ok) { location = '/dashboard'; return; }
  var data = await r.json().catch(function () { return {}; });
  var m = document.getElementById('m'); m.textContent = data.error || 'Sign-in failed'; m.className = 'msg error';
};`
  );
}

const postsScript = `
${helpers}
var accounts = [], posts = [], editing = null;
function accountName(id) { var a = accounts.find(function (x) { return x.id === id; }); return a ? a.name + ' (' + a.provider + ')' : 'deleted account'; }
function provider() { var a = accounts.find(function (x) { return x.id === $('accountId').value; }); return a ? a.provider : 'mastodon'; }
function updateCounter() {
  var segments = splitThread($('text').value), limit = LIMITS[provider()], over = false;
  var parts = segments.map(function (s, i) { var n = countChars(s); if (n > limit) over = true; return 'Part ' + (i + 1) + ': ' + n + '/' + limit; });
  $('counter').textContent = segments.length ? parts.join(' · ') + (segments.length > 1 ? ' · ' + segments.length + '-part thread' : '') : 'Separate thread parts with a line containing only ---';
  $('counter').className = 'counter' + (over ? ' over' : '');
}
$('text').oninput = updateCounter; $('accountId').onchange = updateCounter;
function fillForm(p) {
  editing = p ? p.id : null;
  $('accountId').value = p ? p.accountId : (accounts[0] ? accounts[0].id : '');
  $('text').value = p ? p.segments.join('\\n\\n---\\n\\n') : '';
  $('scheduledAt').value = p && p.scheduledAt ? toLocalInput(p.scheduledAt) : '';
  $('form-title').textContent = p ? 'Edit post' : 'New post';
  $('cancel').classList.toggle('hidden', !p);
  updateCounter();
  if (p) window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function submit(action) {
  var scheduledAt = $('scheduledAt').value ? new Date($('scheduledAt').value).getTime() : null;
  var body = { accountId: $('accountId').value, text: $('text').value, scheduledAt: action === 'now' ? Date.now() : scheduledAt, status: action === 'draft' ? 'draft' : undefined };
  if (action === 'schedule' && !scheduledAt) { showMessage('post-message', 'Choose a date and time to schedule, or save as draft', true); return; }
  var r = await api('/api/admin/posts' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', body);
  if (r.ok) { showMessage('post-message', action === 'now' ? 'Publishing now' : action === 'draft' ? 'Draft saved' : 'Post scheduled'); fillForm(null); load(); }
  else showMessage('post-message', await r.text(), true);
}
$('post-form').onsubmit = function (e) { e.preventDefault(); submit('schedule'); };
$('save-draft').onclick = function () { submit('draft'); };
$('publish-now').onclick = function () { if (confirm('Publish immediately?')) submit('now'); };
$('cancel').onclick = function () { fillForm(null); showMessage('post-message', ''); };
function card(p) {
  var segments = p.segments.map(function (s) { return '<div class="segment">' + esc(s) + '</div>'; }).join('');
  var meta = [];
  if (p.status === 'scheduled') meta.push('Scheduled for ' + esc(when(p.scheduledAt)));
  if (p.status === 'published') meta.push('Published ' + esc(when(p.publishedAt)) + (p.remoteUrl ? ' · <a href="' + esc(p.remoteUrl) + '" target="_blank" rel="noopener">Open</a>' : ''));
  if (p.error) meta.push('<span style="color:var(--bad)">' + esc(p.error) + '</span>');
  if (p.attempts) meta.push('Attempts: ' + p.attempts);
  var events = (p.events || []).map(function (ev) { return '<div class="event">' + esc(when(ev.at)) + ' · ' + esc(ev.event) + (ev.detail ? ' · ' + esc(ev.detail) : '') + '</div>'; }).join('');
  var actions = '';
  if (p.status !== 'published' && p.status !== 'publishing') actions += '<button data-action="edit">Edit</button>';
  if (p.status === 'scheduled') actions += '<button data-action="cancel">Cancel</button>';
  if (p.status === 'draft' || p.status === 'failed' || p.status === 'cancelled') actions += '<button data-action="publish">Publish now</button>';
  actions += '<button data-action="delete" class="danger">Delete</button>';
  return '<article class="card" data-id="' + esc(p.id) + '"><div class="row"><div><strong>' + esc(accountName(p.accountId)) + '</strong><div class="muted">' + meta.join(' · ') + '</div></div><span class="badge ' + esc(p.status) + '">' + esc(p.status.toUpperCase()) + '</span></div>' + segments + (events ? '<details><summary>History</summary>' + events + '</details>' : '') + '<div class="actions">' + actions + '</div><p class="msg" data-msg></p></article>';
}
function render() {
  var s = {}; posts.forEach(function (p) { s[p.status] = (s[p.status] || 0) + 1; });
  $('summary').innerHTML = ['scheduled', 'draft', 'published', 'failed'].map(function (k) { return '<span>' + k + ' ' + (s[k] || 0) + '</span>'; }).join('');
  var filter = $('filter').value;
  var visible = posts.filter(function (p) { return filter === 'all' || p.status === filter; });
  $('posts').innerHTML = visible.map(card).join('') || '<div class="card muted">' + (accounts.length ? 'No posts yet.' : 'Add an account first on the Accounts page.') + '</div>';
}
$('filter').onchange = render;
async function load() {
  accounts = await (await api('/api/admin/accounts')).json();
  $('accountId').innerHTML = accounts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + ' (' + esc(a.provider) + ')</option>'; }).join('');
  if (!editing && !$('text').value) $('accountId').value = accounts[0] ? accounts[0].id : '';
  posts = await (await api('/api/admin/posts')).json();
  render(); updateCounter();
}
$('posts').onclick = async function (e) {
  var button = e.target.closest('[data-action]'); if (!button) return;
  var article = button.closest('[data-id]'), id = article.getAttribute('data-id'), msg = article.querySelector('[data-msg]');
  var p = posts.find(function (x) { return x.id === id; }), action = button.getAttribute('data-action');
  button.disabled = true;
  try {
    if (action === 'edit') fillForm(p);
    else if (action === 'cancel') { await api('/api/admin/posts/' + id + '/cancel', 'POST'); load(); }
    else if (action === 'publish') { await api('/api/admin/posts/' + id + '/publish', 'POST'); load(); }
    else if (action === 'delete') { if (!confirm('Delete this post?')) return; await api('/api/admin/posts/' + id, 'DELETE'); if (editing === id) fillForm(null); load(); }
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  finally { button.disabled = false; }
};
${logoutScript}
load();
setInterval(function () { if (document.visibilityState === 'visible') load(); }, 20000);
`;

export function postsPage() {
  return page(
    'Posts',
    `<h1>Post scheduler</h1>${nav('/dashboard')}<div id="summary" class="summary"></div>
<section class="panel"><h2 id="form-title">New post</h2><form id="post-form" class="grid">
<label>Account<select id="accountId" required></select></label>
<label>Schedule (local time)<input id="scheduledAt" type="datetime-local"></label>
<label class="full">Text<textarea id="text" placeholder="Write your post. Put --- on its own line to start the next part of a thread." required></textarea><span id="counter" class="counter"></span></label>
<div class="full actions"><button class="primary">Schedule</button><button type="button" id="save-draft">Save draft</button><button type="button" id="publish-now">Publish now</button><button type="button" id="cancel" class="hidden">Cancel edit</button></div>
</form><p id="post-message" class="msg"></p></section>
<div class="row"><h2>Posts</h2><label style="width:180px">Show<select id="filter"><option value="all">All</option><option value="scheduled">Scheduled</option><option value="draft">Drafts</option><option value="published">Published</option><option value="failed">Failed</option></select></label></div>
<div id="posts"></div>`,
    postsScript
  );
}

const accountsScript = `
${helpers}
var accounts = [], editing = null;
function applyProvider() {
  var p = $('provider').value;
  $('server').placeholder = p === 'mastodon' ? 'https://mastodon.social' : 'https://bsky.social';
  $('identifier-label').classList.toggle('hidden', p !== 'bluesky');
  $('token-label').textContent = p === 'mastodon' ? 'Access token' : 'App password';
  $('provider-help').textContent = p === 'mastodon'
    ? 'Create a token under Preferences → Development → New application with the write:statuses and read:accounts scopes.'
    : 'Create an app password under Settings → Privacy and security → App passwords. Never use your main password.';
}
$('provider').onchange = applyProvider;
function fillForm(a) {
  editing = a ? a.id : null;
  $('name').value = a ? a.name : '';
  $('provider').value = a ? a.provider : 'mastodon';
  $('server').value = a ? a.server : '';
  $('identifier').value = a ? a.identifier : '';
  $('token').value = '';
  $('token').required = !a;
  $('token').placeholder = a ? 'Leave empty to keep the stored token' : '';
  $('form-title').textContent = a ? 'Edit account' : 'Add account';
  $('cancel').classList.toggle('hidden', !a);
  applyProvider();
}
$('cancel').onclick = function () { fillForm(null); };
$('account-form').onsubmit = async function (e) {
  e.preventDefault();
  var body = { name: $('name').value, provider: $('provider').value, server: $('server').value || ($('provider').value === 'mastodon' ? '' : 'https://bsky.social'), identifier: $('identifier').value, token: $('token').value };
  var r = await api('/api/admin/accounts' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', body);
  if (r.ok) { var a = await r.json(); showMessage('account-message', 'Saved. Verified as ' + a.identity); fillForm(null); load(); }
  else showMessage('account-message', await r.text(), true);
};
function render() {
  $('accounts').innerHTML = accounts.map(function (a) {
    return '<article class="card" data-id="' + esc(a.id) + '"><div class="row"><div><strong>' + esc(a.name) + '</strong><div class="muted">' + esc(a.provider) + ' · ' + esc(a.server) + (a.identifier ? ' · ' + esc(a.identifier) : '') + '</div></div></div><div class="actions"><button data-action="verify">Verify</button><button data-action="edit">Edit</button><button data-action="delete" class="danger">Delete</button></div><p class="msg" data-msg></p></article>';
  }).join('') || '<div class="card muted">No accounts yet.</div>';
}
async function load() { accounts = await (await api('/api/admin/accounts')).json(); render(); }
$('accounts').onclick = async function (e) {
  var button = e.target.closest('[data-action]'); if (!button) return;
  var article = button.closest('[data-id]'), id = article.getAttribute('data-id'), msg = article.querySelector('[data-msg]');
  var a = accounts.find(function (x) { return x.id === id; }), action = button.getAttribute('data-action');
  button.disabled = true;
  try {
    if (action === 'edit') fillForm(a);
    else if (action === 'verify') { var r = await api('/api/admin/accounts/' + id + '/verify', 'POST'); var x = await r.json(); msg.textContent = r.ok ? 'Verified as ' + x.identity : x.error; msg.className = 'msg' + (r.ok ? '' : ' error'); }
    else if (action === 'delete') { if (!confirm('Delete "' + a.name + '" and all of its posts?')) return; await api('/api/admin/accounts/' + id, 'DELETE'); load(); }
  } catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
  finally { button.disabled = false; }
};
${logoutScript}
applyProvider();
load();
`;

export function accountsPage() {
  return page(
    'Accounts',
    `<h1>Accounts</h1>${nav('/dashboard/accounts')}
<section class="panel"><h2 id="form-title">Add account</h2><form id="account-form" class="grid">
<label>Name<input id="name" placeholder="Personal Mastodon" required></label>
<label>Provider<select id="provider"><option value="mastodon">Mastodon</option><option value="bluesky">Bluesky</option></select></label>
<label>Server URL<input id="server" placeholder="https://mastodon.social"></label>
<label id="identifier-label">Handle<input id="identifier" placeholder="you.bsky.social"></label>
<label class="full"><span id="token-label">Access token</span><input id="token" type="password" autocomplete="off"></label>
<p class="full muted" id="provider-help"></p>
<div class="full actions"><button class="primary">Save and verify</button><button type="button" id="cancel" class="hidden">Cancel edit</button></div>
</form><p id="account-message" class="msg"></p></section>
<div id="accounts"></div>`,
    accountsScript
  );
}

const securityScript = `
${helpers}
async function load() {
  var x = await (await api('/api/admin/security')).json();
  $('auth-state').textContent = x.authConfigured ? 'Admin credentials are configured. ' + (x.totpConfigured ? 'TOTP is enabled.' : 'TOTP is not enabled: sign-in only needs the password.') : 'Admin credentials are not configured: the dashboard is open. Set ADMIN_USERNAME, ADMIN_PASSWORD and AUTH_ENCRYPTION_KEY to protect it.';
  $('setup').disabled = !x.authConfigured; $('disable').disabled = !x.totpConfigured;
  $('setup').textContent = x.totpConfigured ? 'Regenerate authenticator' : 'Enable authenticator';
}
$('setup').onclick = async function () {
  if (!confirm('This replaces any existing authenticator and recovery codes. Continue?')) return;
  var x = await (await api('/api/admin/security/regenerate', 'POST')).json();
  $('qr').src = x.qrDataUrl; $('qr').classList.remove('hidden');
  $('secret').textContent = 'Secret: ' + x.secret;
  $('codes').textContent = 'Recovery codes (each works once):\\n' + x.recoveryCodes.join('\\n');
  load();
};
$('disable').onclick = async function () {
  if (!confirm('Disable TOTP?')) return;
  await api('/api/admin/security/disable', 'POST');
  $('qr').classList.add('hidden'); $('codes').textContent = ''; $('secret').textContent = '';
  load();
};
${logoutScript}
load();
`;

export function securityPage() {
  return page(
    'Security',
    `<h1>Security</h1>${nav('/dashboard/security')}<section class="panel"><h2>Two-factor authentication (TOTP)</h2><p id="auth-state" class="muted">Loading...</p><div class="actions"><button id="setup" class="primary">Enable authenticator</button><button id="disable" class="danger">Disable TOTP</button></div><p><img id="qr" class="hidden" alt="TOTP QR code" style="max-width:260px;background:#fff;padding:8px;border-radius:8px"></p><p id="secret" class="muted"></p><pre id="codes"></pre></section>`,
    securityScript
  );
}
