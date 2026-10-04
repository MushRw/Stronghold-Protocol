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
  input[type=datetime-local] { flex:0 0 auto; max-width:190px; }
  h3 { font-size:13px; color:var(--muted); font-weight:600; margin:20px 0 8px; }
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
  <section>
    <div class="bar">
      <span class="tag" id="mstate">维护状态：—</span>
      <input id="mmsg" placeholder="维护公告（可选，访客会看到这句话）" maxlength="500">
      <input id="muntil" type="datetime-local" title="自动结束时间；留空表示一直维护到你手动关闭">
      <button id="mtoggle" disabled>进入维护</button>
    </div>
    <p class="sub">进入维护后全站返回维护页（不影响在线对局的中途结算，但会拒绝新连接）。填了「自动结束」就到点自动恢复（最迟多 10 秒，开关有缓存）；留空则一直维护到手动关闭。开启状态下访问 <code>/?key=管理令牌</code> 可换到一张放行 cookie。</p>
  </section>
  <section>
    <div class="bar">
      <span class="tag" id="dstate">诊断：—</span>
      <button id="dreload" disabled>刷新</button>
    </div>
    <p class="sub">逐个 Durable Object 探一次最便宜的读，并列出各表行数。某个对象被重置时会反映在这里 —— 故障时第一个问题永远是「哪个对象挂了」。</p>
    <div id="dlist"></div>
  </section>
  <section>
    <div class="bar">
      <span class="tag" id="wstate">写入量：—</span>
      <button id="wreload" disabled>刷新</button>
    </div>
    <p class="sub">每局结束时由房间上报的 rows written（免费层每天 10 万行；<strong>超限是所有写入直接失败，不是限速</strong>）。云端分析接口拿不到这个数，所以这是判断持久化改动有没有真正生效的唯一依据。</p>
    <div id="wlist"></div>
  </section>
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
// A datetime-local input speaks local wall-clock with no zone, so shift by the offset before slicing ISO.
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const utcDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
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
async function loadMaint() {
  const state = el('mstate'), button = el('mtoggle');
  if (!tokenBox.value.trim()) {
    state.textContent = '维护状态：先填管理令牌'; state.className = 'tag'; button.disabled = true; return;
  }
  button.disabled = false;
  try {
    const { maintenance } = await call('/api/admin/maintenance');
    // An expired deadline is not "in maintenance": the guard stops blocking at that moment, so the button
    // and the label have to follow the same rule or the operator is told the site is down when it is up.
    const until = Number.isSafeInteger(maintenance?.until) ? maintenance.until : null;
    const expired = !!until && until <= Date.now();
    const on = !!maintenance?.enabled && !expired;
    state.textContent = '维护状态：' + (maintenance?.enabled
      ? (expired ? '已到期（站点已恢复）' : '已开启' + (until ? '，自动结束 ' + stamp(until) : '（需手动关闭）'))
      : '正常');
    state.className = 'tag ' + (on ? 'pending' : 'approved');
    button.textContent = on ? '结束维护' : '进入维护';
    if (maintenance?.message) el('mmsg').value = maintenance.message;
    el('muntil').value = until && !expired ? toLocalInput(until) : '';
  } catch (e) {
    state.textContent = '维护状态：读取失败'; state.className = 'tag rejected';
  }
}
async function toggleMaint() {
  const button = el('mtoggle');
  const enter = button.textContent === '进入维护';
  const raw = el('muntil').value.trim();
  const parsed = raw ? new Date(raw).getTime() : null;
  if (raw && !Number.isFinite(parsed)) {
    el('msg').textContent = '自动结束时间读不出来，请用日期选择器选一个时间';
    el('msg').className = 'msg err';
    return;
  }
  el('msg').textContent = '';
  button.disabled = true;
  try {
    await call('/api/admin/maintenance', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ enabled: enter, message: el('mmsg').value.trim() || null, until: parsed }) });
    await loadMaint();
  } catch (e) {
    el('msg').textContent = '维护开关失败：' + e.message; el('msg').className = 'msg err';
  } finally { button.disabled = false; }
}
async function loadDiag() {
  const state = el('dstate'), list = el('dlist'), button = el('dreload');
  if (!tokenBox.value.trim()) {
    state.textContent = '诊断：先填管理令牌'; state.className = 'tag'; list.innerHTML = ''; button.disabled = true; return;
  }
  button.disabled = false;
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const { probes, sizes } = await call('/api/admin/diag');
    const clean = (value) => String(value).replace(/[<>&]/g, '');
    const bad = Object.entries(probes || {}).filter(([, value]) => value !== 'ok');
    state.textContent = '诊断：' + (bad.length ? bad.length + ' / ' + Object.keys(probes).length + ' 个对象异常' : '全部正常');
    state.className = 'tag ' + (bad.length ? 'rejected' : 'approved');
    const probeRows = Object.entries(probes || {}).map(([name, value]) => '<tr><td>' + clean(name) + '</td><td>'
      + (value === 'ok' ? '<span class="tag approved">ok</span>' : '<span class="tag rejected">' + clean(value) + '</span>')
      + '</td></tr>').join('');
    const sizesHtml = typeof sizes === 'string'
      ? '<p class="sub">表行数不可用：' + clean(sizes) + '</p>'
      : '<h3>表行数</h3><table><thead><tr><th>表</th><th>行数</th></tr></thead><tbody>'
        + Object.entries(sizes || {}).map(([name, count]) => '<tr><td>' + clean(name) + '</td><td>' + count + '</td></tr>').join('')
        + '</tbody></table>';
    list.innerHTML = '<table><thead><tr><th>对象</th><th>探针</th></tr></thead><tbody>' + probeRows + '</tbody></table>' + sizesHtml;
  } catch (e) {
    state.textContent = '诊断：读取失败'; state.className = 'tag rejected'; list.innerHTML = '';
  }
}
async function loadWrites() {
  const state = el('wstate'), list = el('wlist'), button = el('wreload');
  if (!tokenBox.value.trim()) {
    state.textContent = '写入量：先填管理令牌'; state.className = 'tag'; list.innerHTML = ''; button.disabled = true; return;
  }
  button.disabled = false;
  try {
    const { items, averageRows, daily, quota } = await call('/api/admin/write-stats');
    state.textContent = '写入量：最近 ' + items.length + ' 局，平均 ' + averageRows + ' 行/局';
    state.className = 'tag approved';
    // Today's slice of the daily cap is the number worth showing first: over it, every write fails.
    const quotaHtml = quota
      ? '<p class="sub">今日（UTC ' + utcDay(quota.day) + '）已计 <strong>' + quota.rows + '</strong> 行 / '
        + quota.limit + '（' + quota.percent + '%），' + quota.matches + ' 局。只统计房间 flush，且对局结束才计入；'
        + '目录与账号侧的写入不在内 —— 所以这是下限，不是全部。</p>'
      : '';
    const dailyHtml = daily && daily.length
      ? '<h3>按天（UTC 日界，与额度重置一致）</h3><table><thead><tr><th>日期</th><th>局数</th><th>总行数</th><th>flush 次数</th></tr></thead><tbody>'
        + daily.map((d) => '<tr><td>' + utcDay(d.day) + '</td><td>' + d.matches + '</td><td><strong>' + d.rows + '</strong></td>'
          + '<td>' + d.flushes + '</td></tr>').join('')
        + '</tbody></table>'
      : '';
    const rows = items.map((it) => '<tr><td>' + it.roomId.replace(/[^A-Za-z0-9]/g,'') + '</td><td><strong>' + it.rows + '</strong></td>'
      + '<td>' + it.flushes + '</td><td>' + Math.round(it.matchMs / 1000) + ' 秒</td><td>' + stamp(it.at) + '</td></tr>').join('');
    const recent = items.length
      ? '<h3>最近对局</h3><table><thead><tr><th>房间</th><th>写入行数</th><th>flush 次数</th><th>时长</th><th>结束时间</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="empty">还没有对局记录</div>';
    list.innerHTML = quotaHtml + dailyHtml + recent;
  } catch (e) {
    state.textContent = '写入量：读取失败'; state.className = 'tag rejected'; list.innerHTML = '';
  }
}
el('list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-login]');
  if (button) review(button.dataset.login, button.dataset.status);
});
el('reload').addEventListener('click', () => { load(); loadMaint(); loadDiag(); loadWrites(); });
el('filter').addEventListener('change', load);
el('mtoggle').addEventListener('click', toggleMaint);
el('dreload').addEventListener('click', loadDiag);
el('wreload').addEventListener('click', loadWrites);
tokenBox.addEventListener('input', () => { loadMaint(); loadDiag(); loadWrites(); });
load();
loadMaint();
loadDiag();
loadWrites();
</script></main></body></html>`;

const adminPageHeaders = () => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
});

export { ADMIN_PAGE, adminPageHeaders };
