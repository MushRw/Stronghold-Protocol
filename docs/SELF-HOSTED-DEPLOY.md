# 自建部署记录：protocol.cc.cd

本文件记录**本 fork 的实际部署方式**，与 `docs/CLOUDFLARE.md`（上游的部署说明，描述 Workers Paid + GitHub OAuth + stronghold.lunar.ag）不同：这里用的是**免费套餐 + 自建账号 + 人工审核**。上游文档仍保留作为参考，部署时以本文件为准。

## 现状

| 项目 | 值 |
|---|---|
| 公开地址 | `https://protocol.cc.cd` |
| 运营后台 | `https://protocol.cc.cd/admin`（令牌 = Worker secret `ADMIN_TOKEN`） |
| 套餐 | Workers **Free**（静态文件上限 20,000/版本，单文件 25 MiB） |
| 账号体系 | 自建账号（代号 + 密码），注册后**必须人工批准**才能建房/进房 |
| 域名 | `protocol.cc.cd` 子域委派到 Cloudflare（NS：`elliott` / `tia.ns.cloudflare.com`），zone status = active |
| 素材 | 314 MiB，构建后 8,545 个静态文件 |

## 首次部署步骤

```bash
npm ci
npm run setup                  # 或直接下 https://stronghold.lunar.ag/stronghold-resources.zip 后解压到 public/
npx wrangler login             # 需要换账号时用 --device（见下）
npx wrangler secret put ADMIN_TOKEN    # ≥32 字符，审核后台的钥匙
npm run build:worker
npm run deploy:worker
```

### 素材获取（省时做法）

自己抓取只有 ~51 KB/s（且**走代理比直连慢一倍**）。最快的路径是让下载器下作者打包好的单文件，再解压：

```bash
# 405,865,315 字节，Stored 模式，支持多线程/断点续传
https://stronghold.lunar.ag/stronghold-resources.zip
# 解压到 public/ 后重建清单
node tools/fetch-assets.mjs --offline
```

`--offline` 会用磁盘上的素材重新生成 `data/assets.json` 并校验 Spine 模型；缺个别图标（如 `enemies.enemy_5601_entlec.icon`）不影响构建，客户端有占位图。

### 登录到非默认 Cloudflare 账号

`npx wrangler login --device` 会打印一个地址和一次性代码，在**任意浏览器**里打开并登录目标账号即可，不碰默认浏览器的登录状态。

## 部署注意

- **构建脚本会 `rm -rf dist/client`（8000+ 文件）**。在带批量删除保护的环境里（例如带沙箱的助手工具）这一步会被拦下、构建直接失败。正确做法是**在沙箱外运行构建**；退而求其次是把旧目录改名让路：`mv dist .dist-old-$(date +%H%M%S)`。`dist` 本身是构建产物，改名不会丢东西（清理由你决定，别让工具代删）。
- 部署慢在哪：`wrangler deploy` 会先跑 `build.command`（= `npm run build:worker`），**约 90 秒**用于重拷 400 MB 素材并计算 8543 个文件哈希；实际上传只有 ~42 秒（素材未变时不重复上传）。
- `wrangler.jsonc` **不要写 `routes`**，否则会覆盖控制台里绑好的自定义域名。
- 域名绑定可以用 API 完成，不必点控制台：
  `PUT /accounts/{account_id}/workers/domains` body `{hostname, service, zone_id}`。

## 免费套餐相关的硬约束（踩过的坑）

以下限制**Miniflare 本地不校验**，本地测试全绿也照样在生产炸，所以每次改动这些位置都要留神：

1. **PBKDF2 迭代上限 100000**。workerd 报 `Pbkdf2 failed: iteration counts above 100000 are not supported`。`LOCAL_AUTH.iterations` 已钉在 100000，并有测试断言。
2. **Durable Object isolate 内存 128 MiB**。每个 DO 都要装载并求值**整个 Worker 脚本**，所以包体过大会导致**所有** DO 一唤醒就被重置（症状：`Durable Object's isolate exceeded its memory limit and was reset`，注册、登录、后台全部 503）。历史规则引擎每版约 11 MiB，10 版就是 58 MiB 的包 —— 已改为**默认不嵌旧引擎**（`SP_KEEP_RETAINED_VERSIONS=1` 才嵌），并加了 24 MiB 构建护栏。包体从 58 MiB 降到 5.6 MiB 后 DO 才恢复正常。
3. **`run_worker_first` 是白名单**。不在名单里的路径由静态资源层直接应答，Worker 收不到。新增 Worker 路由（如 `/admin`）必须同时加进这个列表。
4. **`new Response(body, headersObj)` 是错的**，必须写 `new Response(body, { headers })`。写成前者会静默使用默认 `text/plain`，浏览器直接显示 HTML 源码。
5. **`e instanceof AccountError` 对跨 DO RPC 的错误无效**（原型丢失，`code`/`status` 仍在）。判断错误要用鸭子类型，并把未知错误 `console.error` 留痕，不要静默压成一个 `AUTH_FAILED`。
6. **RPC 不能传函数**。把闭包传进 DO 方法会让 workerd 去序列化它的捕获环境（例如 `SqlStorage`），报 `Could not serialize object of type "SqlStorage"`。诊断类方法应当由 DO 自己算好再返回纯数据对象。

## 部署流程：`npm run deploy:safe`（把顺序固定下来）

部署必然 evict 所有 DO、断开所有 WebSocket（客户端收到 **1012**），所以"偶尔要重新连接"**不是房间的 bug，是部署本身**。顺序容易在赶时间时忘掉，所以它是一个脚本：

```bash
npm run deploy:safe -- --dry-run   # 只体检：线上版本、规则版本、谁在玩，不做任何改动
npm run deploy:safe                # 正式跑
```

阶段依次是 `preflight` → `drain` → `maintenance` → `deploy` → `verify` → `record` → `restore`。

- **排空信号是公开房间目录**（`GET /api/rooms`）。它只列 `public && mode === 'coop'` 的房间，**solo / 未公开的房间看不到** —— 脚本会明确说明这一点，而不是假装站点是空的。确定只有自己在单机时用 `--force`。
- **切换维护需要 `ADMIN_TOKEN`**，而它只存在于 Worker 的 secret 里（本机读不到）。带 `SP_ADMIN_TOKEN=...` 跑，脚本自己开关（**不落盘**）；不带就打印点击步骤，并**等到维护页真的生效**（`GET /` 返回 503）才继续。两种情况下顺序都不会被跳过。
- **`--allow-rules-change`**：规则版本变了时守卫会拒绝部署；脚本先在体检里讲清楚，确认无人对局后加这个参数（它会给子进程设 `SP_ALLOW_RULES_CHANGE=1`）。
- **`--maintenance-off`**：脚本中途挂掉之后单独撤维护（幂等，可重复跑）。维护页卡住时也用它。
- **退出码**：`0` 成功 ｜ `2` 有人在对局、拒绝部署 ｜ `3` 维护未能生效 ｜ `4` 新版本没上报 ｜ `5` 部署失败。**`2` 和 `3` 都是"什么都没动"**，可以安全重跑。
- **非交互环境必须显式加 `--yes`**（部署前有一次确认）。`--stop-after <阶段>` 可以只做到某一步，例如只开维护、手工部署。

**为什么不是"先挂维护再排空"**：维护守卫会拦掉除 `/admin`、`/api/admin/*`、`/healthz` 之外的一切，维护页一挂上就**看不到房间列表**，也就无从等对局结束。所以顺序是"先排空、确认清空后立刻挂维护"，中间只留几秒。

## 部署前守卫（已接入）

`wrangler.jsonc` 的 `build.command` 现在是：

```
npm run build:worker && node tools/rules-version-guard.mjs check
```

它会读出刚构建产物里的规则版本号，与 `.cache/deployed-rules-version`（上次部署后由 `npm run rules:record` 写入）比对：

- **相同** → 放行，并提示"可与进行中的对局并存"
- **不同** → **拒绝部署并返回非零退出码**，打印为什么这会等同于踢人；确认没有对局在进行时可用 `SP_ALLOW_RULES_CHANGE=1 npm run deploy:worker` 强制通过

部署成功后记得记录新版本：

```bash
npm run rules:record
```

## 改动游戏规则前必读

`rulesVersion` = `server/` + `shared/` + `data/`（以及 `worker/replay-engine.js`、`worker/recovery-engine.js`、`worker/data-loader.js`、`worker/sim-data-loader.js`、构建脚本）的哈希。

- **只改 `worker/`（除上面四个文件）、`public/`、`docs/`、`test/`** → 规则版本不变，进行中的对局用同一引擎恢复，**不会踢人**。
- **改了 `server/` / `shared/` / `data/`** → 规则版本变化；因为默认不再嵌旧引擎，进行中的对局会退回到**用新规则解释旧检查点**（`retainedMatchVersions[id] || restoreMatch`），可能恢复错。**必须在没有对局进行时部署。**
- 将来若确实需要长期支持"旧对局可恢复"，正确做法是把历史引擎放到 R2 按需拉取，而不是塞回包里。

## 运营工具

- `GET /api/admin/accounts?status=pending|approved|rejected|` 列出账号（`status` 空串 = 全部）。
- `GET /api/admin/session`（无需凭据）回答"我是谁"，供控制台决定渲染哪一块：未登录 / 已登录但不是操作员 / 是操作员（含 `fresh`：本次登录是否在写操作窗口内）。匿名调用只会得到 `authenticated:false`，不泄露任何信息。
- **两条凭据路径**（`worker/accounts/admin.js` 的 `adminIdentity`）：
  - **登录会话**（日常）：复用玩家的 `__Host-sp_session`（`HttpOnly`），账号需在 `site_flags.operators` 名单里（存 **accountId**，不是代号 —— 代号可改可重用）。
  - **`ADMIN_TOKEN`**（救急 / 脚本）：`deploy:safe` 用它，忘了密码也靠它；**它也是唯一能授予第一个操作员席位的东西**（没有令牌就没人能产生第一个操作员）。
- **写操作要求"最近 12 小时登录过"**（`OPERATOR_WRITE_WINDOW_MS`）：玩家会话是 30 天，直接拿它当管理凭据等于"半年前登录的设备还能关站"。读操作不受限；超期时接口返回 `403 RELOGIN_REQUIRED`，页面提示重新登录。会话记录新增 `createdAt`（加性字段），旧会话没有该字段即视为不新鲜，需重新登录一次。
- `POST /api/admin/operators` body `{login, action:'add'|'remove'}`（**只接受令牌**，会话不能授予/回收席位，否则被盗的会话能自我固化）；`GET` 同路径列出名单。名单项是 accountId，`action` 与 body 都是严格白名单。
- **状态码约定**：`401 LOGIN_REQUIRED`=没带凭据，`403 FORBIDDEN`=带了凭据但不对，`403 NOT_OPERATOR`=登录了但不在名单，`403 RELOGIN_REQUIRED`=是操作员但登录太久（只有写操作）。页面靠这几个码区分"该登录 / 该找人开权限 / 该重新登录"。
- CSRF 不需要额外机制：会话 cookie 是 `SameSite=Lax`（跨站 POST 不带 cookie），且所有改状态的管理路由都过 `requireOrigin`。
- `/admin` 页面现在有三态：登录表单 / "你不是操作员"（附"用令牌激活"入口）/ 控制台；令牌框收进折叠的「高级」区，仍可用于救急。
- `POST /api/admin/review` body `{login, status}` 批准或拒绝；**拒绝会立即删除该账号已有会话**。
- `GET /api/admin/diag`（头 `X-Admin-Token`）逐个探活各 DO 并报告表行数；DO 被重置时这些调用会失败，这是判断"是不是 DO 挂了"的第一步。
  - 返回的 `probes` 是**结构化**的：`{ [对象名]: { ok, detail } }`。**判断成败是服务端的责任** —— 早先它返回的是给人读的字符串（`"SITES: ok"`），页面拿它跟 `'ok'` 比较，结果把每个对象都报成异常，还把标签打印了两遍。
  - **`MATCH_ARCHIVES` 探针的 `ARCHIVE_NOT_READY` 是健康答案**：探针用的是固定 id 且**故意不放存档**，所以"没有存档"这个错误恰恰证明对象回答了。任何**其它**错误才是真的信号（那才是被重置的 isolate）。把它当故障会在每次访问时误报，而且永远如此 —— 那个探针 id 永远不会有数据。
  - 探针只证明**对象能应答**（一次最便宜的读走个来回），**不是数据校验**；表行数是另一块信息。
- 该接口有令牌保护，因此会把内部错误原因放在 `detail` 字段里返回——公开接口（注册/登录）不会。
- `GET /api/admin/maintenance` 读维护开关，`POST` body `{enabled, message?, until?}` 切换（都要 `X-Admin-Token`，页面按钮在 `/admin` 顶部）。
  - 打开后**全站返回 503 维护页**（`/admin`、`/api/admin/*`、`/healthz` 除外——开关必须留着才能关回来）。**不需要部署**，这是它存在的理由：部署会 evict 所有 DO、断掉进行中的对局。
  - **`until` 是真的会生效的截止时间**：到点后守卫不再拦截（判断在读取侧，`maintenance.js` 的 `maintenanceActive()`），所以到期**不产生任何写入**——`site_flags` 里的值仍然是 `enabled: true`，只是不再算数。页面会把这种状态显示成"已到期（站点已恢复）"，并给一个"进入维护"按钮，而不是"结束维护"。留空表示一直维护到手动关闭。
  - 你在浏览器里访问一次 `/?key=<令牌>` 会换到一张 12 小时的 cookie，之后自己照常进站（令牌不再留在地址栏里）。
  - 开关存在 SiteDirectory 的 `site_flags` 表，读取带 **10 秒 per-isolate 缓存**，切换/到期后最长 10 秒全网生效；目录读不到时**放行**（fail open），不让读开关本身成为故障源。
- `GET /api/admin/write-stats`（头 `X-Admin-Token`）返回三块：最近 50 局、**按天的汇总**（`daily`，UTC 日界，与免费额度重置一致）、以及**今日额度**（`quota: {limit, day, rows, matches, percent}`）。`/admin` 页面把今日占用放在最上面。
  - 免费层的分析接口**不提供** `rowsWritten`，所以这是唯一能看到"一局到底写了多少行"的途径；每局结束时由房间上报一行，代价可忽略。
  - **口径要说清**：只统计房间 flush（目录、账号、会话那些写入不经过房间），而且**对局结束才计入**。所以它是**下限**，不是当天全部用量 —— 页面也是这么写的。
  - 对局中看实时值走房间的 `/_diag`（**不是 `/_status`**）：`/_status` 被 `/api/rooms/:code` 公开代理，客户端还断言了它的返回形状，内部计数放在那里既是泄露也是破坏契约。
  - 用途：任何持久化改动（分块大小、节流、批量）的效果，都靠这张表验证，别再用推算。
- `GET /api/admin/diag` 同样在页面上（`/admin` 的"诊断"一节）：探针 + 各表行数，全部渲染出来。

## 出错时的自查顺序

在浏览器控制台执行（能区分网络问题和服务端问题）：

```js
// 1. 网络往返（不含 DO）：稳定在几十毫秒说明线路正常
const t=performance.now(); fetch('/healthz').then(()=>console.log('往返',Math.round(performance.now()-t),'ms'))
// 2. 登录态与席位
fetch('/api/me/active-match').then(r=>r.text().then(t=>console.log('座位',r.status,t)))
// 3. 是否残留了无效席位（应返回 201 并给出房号）
fetch('/api/rooms',{method:'POST'}).then(r=>r.text().then(t=>console.log('建房',r.status,t)))
// 4. 四个 DO 是否都活着
fetch('/api/admin/diag',{headers:{'X-Admin-Token':'<你的令牌>'}}).then(r=>r.text().then(t=>console.log('诊断',r.status,t)))
```

- `/api/rooms` 返回 **403 `NOT_APPROVED`** → 账号还没批准（或被拒绝）。
- 返回 **409 `ALREADY_SEATED`** → 名下还有有效席位；若房间已消失会自动释放（见下）。
- 返回 **429 `RATE`** → 同网络短时间请求过多，等一分钟。

## 磁盘卫生

每次构建前先 `mv dist .dist-old-$(date +%H%M%S)`（原因见上），这些目录会累积，每个约 0.9 GB。清理时**请在资源管理器里 Shift+Delete 直接删除**：本机环境下 `rm` 会把文件移入同盘回收站，**不会释放空间**，而且回收站属于用户，不应由工具代劳清理。

## 本轮修复记录

- **注册 502**：PBKDF2 210000 轮超过 workerd 上限，降到 100000。
- **后台显示源码**：`Response` 的 headers 没包在 init 里，落到 `text/plain`。
- **后台 404**：`/admin` 不在 `run_worker_first` 白名单。
- **所有 DO 被重置**：包内嵌了 10 个历史规则引擎（58 MiB），改为默认不嵌 + 24 MiB 护栏。
- **账号被永久锁死**：`/api/rooms` 记的座位租约从不续期，而 `getActiveSeat()` 不看 `expiresAt`；客户端建房后若没连上，座位永久残留，之后每次都 409。现改为建房前**向房间核实**该账号是否真的还在（去问 `/_account`，房间不存在或已不含该账号则释放席位）。注意不能简单地让 `getActiveSeat()` 遵守 `expiresAt`：座位上游戏时不会续期，那样会让坐着的玩家被判定过期、进而开出第二个房间。
- **首页绕不过维护页**：`assets.run_worker_first` 原本只列 `/api/*`、`/ws`、`/healthz`、`/admin`，首页 HTML 由静态资源直出，任何 Worker 层的开关都拦不住它；现已加入 `/` 与 `/index.html`。`test/worker/maintenance.test.js` 里有配置契约断言守着这条，改配置时会被测试拦下。
- **写入失败会把对局冻死**：`alarm()` 里 `await this.persist()` 没有 try/catch，一次写入抛错（额度耗尽、存储抖动）就跳过下面的 `scheduleAlarm()`；而 alarm 链是唯一会唤醒房间的东西，客户端消息又撞上同一个失败的写入，于是对局永久卡住 —— 这大概率就是上次超限那天故障特别严重的原因。现在 flush 有守卫、重排**一定**执行：降级而不是死掉。
- **`setAlarm()` 每次 persist 都重排**：它本身按一行写入计费，对局中等于每条客户端消息白烧一行（而 `alarm()` 3 秒后本来就会自己重排）。现改为只在"期限真的提前"时才排，内存里记住已排时间，DO 被 evict 后回退 `getAlarm()`。
