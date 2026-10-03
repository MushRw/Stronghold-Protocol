// The operator console for self-hosted accounts: a single self-contained page, no build step, no
// framework. It only exists when ADMIN_TOKEN is configured, and it never sees the password — only the
// login, its review state and when it was reviewed.
const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>账号审核 · 卫戍协议</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --panel:#1c1f26; --line:#2b303b; --text:#e8eaee; --muted:#98a0ae;
          --ok:#5ec98a; --wait:#e0b354; --no:#e2756b; --accent:#6aa8ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  main { max-width:820px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; font-size:13px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
  input,select,button { font:inherit; color:inherit; background:var(--panel); border:1px solid var(--line);
    border-radius:8px; padding:8px 10px; }
  input { flex:1 1 240px; min-width:0; }
  button { cursor:pointer; } button:hover { border-color:var(--accent); }
  button.ok { color:var(--ok); } button.no { color:var(--no); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .tag { font-size:12px; padding:2px 8px; border-radius:99px; border:1px solid currentColor; }
  .pending { color:var(--wait); } .approved { color:var(--ok); } .rejected { color:var(--no); }
  .empty { color:var(--muted); padding:28px; text-align:center; }
  .msg { margin:12px 0 0; color:var(--muted); } .msg.err { color:var(--no); }
  code { background:#111; padding:1px 5px; border-radius:4px; }
</style></head>
<body><main>
  <h1>账号审核</h1>
  <p class="sub">批准后玩家才能登录并创建房间。口令只存 PBKDF2 散列，这里看不到原密码。</p>
  <div class="bar">
    <input id="token" type="password" placeholder="管理令牌 ADMIN_TOKEN" autocomplete="off" spellcheck="false">
    <select id="filter">
      <option value="pending">待审核</option>
      <option value="approved">已批准</option>
      <option value="rejected">已拒绝</option>
      <option value="">全部</option>
    </select>
    <button id="reload">刷新</button>
  </div>
  <div id="list"></div>
  <p class="msg" id="msg"></p>
</main>
<script>
const el = (id) => document.getElementById(id);
const tokenBox = el('token');
tokenBox.value = sessionStorage.getItem('sp_admin_token') || '';
tokenBox.addEventListener('input', () => sessionStorage.setItem('sp_admin_token', tokenBox.value.trim()));
const STATUS = { pending:'待审核', approved:'已批准', rejected:'已拒绝' };
const stamp = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { hour12:false }) : '—';
async function call(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Admin-Token': tokenBox.value.trim(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
  return body;
}
async function review(login, status) {
  el('msg').textContent = '';
  try {
    await call('/api/admin/review', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ login, status }) });
    await load();
  } catch (e) { el('msg').textContent = '操作失败：' + e.message; el('msg').className = 'msg err'; }
}
async function load() {
  const list = el('list'), msg = el('msg');
  if (!tokenBox.value.trim()) { list.innerHTML = '<div class="empty">先填管理令牌</div>'; return; }
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const { items } = await call('/api/admin/accounts?status=' + encodeURIComponent(el('filter').value));
    msg.textContent = ''; msg.className = 'msg';
    if (!items.length) { list.innerHTML = '<div class="empty">没有符合条件的账号</div>'; return; }
    const rows = items.map((it) => '<tr><td><strong>' + it.login.replace(/[<>&]/g, '') + '</strong></td>'
      + '<td><span class="tag ' + it.status + '">' + (STATUS[it.status] || it.status) + '</span></td>'
      + '<td>' + stamp(it.createdAt) + '</td><td>' + stamp(it.reviewedAt) + '</td><td>'
      + (it.status === 'approved' ? '<button class="no" data-login="' + it.login + '" data-status="rejected">撤销</button>'
        : '<button class="ok" data-login="' + it.login + '" data-status="approved">批准</button> '
          + '<button class="no" data-login="' + it.login + '" data-status="rejected">拒绝</button>')
      + '</td></tr>').join('');
    list.innerHTML = '<table><thead><tr><th>代号</th><th>状态</th><th>注册时间</th><th>审核时间</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) {
    list.innerHTML = '<div class="empty">无法读取</div>';
    msg.textContent = e.message === 'FORBIDDEN' ? '管理令牌不对' : e.message;
    msg.className = 'msg err';
  }
}
el('list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-login]');
  if (button) review(button.dataset.login, button.dataset.status);
});
el('reload').addEventListener('click', load);
el('filter').addEventListener('change', load);
load();
</script></main></body></html>`;

const adminPageHeaders = () => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
});

export { ADMIN_PAGE, adminPageHeaders };
