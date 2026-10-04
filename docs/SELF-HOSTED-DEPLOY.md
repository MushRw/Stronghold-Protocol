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

- **每次部署前先 `mv dist .dist-old-$(date +%H%M%S)`**：`npm run build:worker` 开头会 `rm -rf dist/client`（8000+ 文件），在某些环境会被批量删除保护拦住而导致构建失败。
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

- `GET /api/admin/accounts?status=pending|approved|rejected|`（头 `X-Admin-Token`）列出账号。
- `POST /api/admin/review` body `{login, status}` 批准或拒绝；**拒绝会立即删除该账号已有会话**。
- `GET /api/admin/diag`（头 `X-Admin-Token`）逐个探活各 DO 并报告表行数；DO 被重置时这些调用会失败，这是判断"是不是 DO 挂了"的第一步。
- 该接口有令牌保护，因此会把内部错误原因放在 `detail` 字段里返回——公开接口（注册/登录）不会。
- `GET /api/admin/maintenance` 读维护开关，`POST` body `{enabled, message?, until?}` 切换（都要 `X-Admin-Token`，页面按钮在 `/admin` 顶部）。
  - 打开后**全站返回 503 维护页**（`/admin`、`/api/admin/*`、`/healthz` 除外——开关必须留着才能关回来）。**不需要部署**，这是它存在的理由：部署会 evict 所有 DO、断掉进行中的对局。
  - 你在浏览器里访问一次 `/?key=<令牌>` 会换到一张 12 小时的 cookie，之后自己照常进站（令牌不再留在地址栏里）。
  - 开关存在 SiteDirectory 的 `site_flags` 表，读取带 **10 秒 per-isolate 缓存**，切换后最长 10 秒全网生效；目录读不到时**放行**（fail open），不让读开关本身成为故障源。

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
