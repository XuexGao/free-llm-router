# 第 2 步：项目骨架（已完成）

> 对应 `../AGENTS.md` §9 第 2 步。本文件记录**实际部署验证的结果**与踩到的真实约束。

## ✅ 结论：骨架已在 Cloudflare 上部署并端到端验证通过

| 项 | 值 |
|---|---|
| Worker 地址 | `https://workbuddy-gateway.xiegao.workers.dev` |
| Durable Objects | `AccountPoolDO`（每 realm 一个）+ `TaskRunnerDO`（每账号一个） |
| DO 存储后端 | **SQLite**（Free 计划唯一可选） |
| 体积 | 37.34 KiB / gzip 11.57 KiB |
| 启动时间 | **2 ms** |
| Cron | **1 条**：`0 * * * *`（见下方约束） |
| 单测 | **26/26 通过**（`npm test`） |
| 类型检查 | 通过（`npm run typecheck`） |

### 已验证的行为

| 验证项 | 结果 |
|---|---|
| `/healthz` 免鉴权 | ✅ 返回 `{ok:true}` |
| 无密钥访问 `/admin/pool` | ✅ **401** |
| 正确密钥访问 `/admin/pool` | ✅ 返回 DO 计数（`total: 0`） |
| **DO 自动建表** | ✅ `blockConcurrencyWhile` + `migrate()` 生效 |
| **任务入队** | ✅ `POST /admin/tasks/start` 返回 `queued: 3` |
| **alarm 逐步执行** | ✅ 3 步队列全部执行完毕，顺序正确（`listTasks → balance → checkin`） |
| **失败如实上报** | ✅ 未传 accessToken ⇒ 3 步均报 401 并带**响应原文片段**（不静默） |
| `/v1/models` 占位 | ✅ 返回空列表 + 明确说明未实现（**不编造数据**） |

## 🔴 实测发现的真实平台约束：cron 配额只有 1 条

**这是文档里没预料到、必须记录的问题。**

原设计在 `wrangler.jsonc` 里声明了 3 条 cron（`0 9` / `0 21` / `0 10`），部署失败：

```
This account has reached the Workers Free limit of 5 cron triggers per account.
[code: 10072]
```

排查后实测该账号的 5 个 cron 配额**已被其他 Worker 占用**：

| Worker | 占用的 cron |
|---|---|
| `cf-server-monitor` | `0 * * * *`、`*/1 * * * *`（2 条） |
| `cloud-mail` | `0 * * * *`（1 条） |
| `nodewarden` | `*/5 * * * *`（1 条） |
| **剩余可用** | **1 条** |

**解决方案**：改成 **1 条每小时 cron + Worker 内按时点分发**。

```
0 * * * *  → scheduled() 判断 UTC+8 小时
           → 命中 SCHEDULE_UTC8 才扇出，否则直接返回
```

这反而更好：
- **省 4 条配额**（1 vs 3，且不随任务数增长）；
- **改时点不用重新部署**（改 `src/index.ts` 的 `SCHEDULE_UTC8` 即可）；
- **非任务时点零 DO 调用**（连 DO Duration 都不消耗）。

⚠️ 代价：所有任务的时点粒度被限制为**整点**。Go 侧支持任意分钟，本项目第一版只支持整点。
若将来需要分钟级精度，需升级 Paid（1,000 条配额）或改用 DO alarm 自调度。

## 🐛 实测踩到并修复的缺陷：`.one()` 在零行时抛异常

**现象**：`POST /admin/tasks/start` 传一个不存在的账号 uid，返回 `error code: 1101`（Worker 抛异常），
而代码本意是返回 404「账号不存在」。

**根因**（`wrangler tail` 抓到的真实堆栈）：

```
Error: Expected exactly one result from SQL query, but got no results.
    at async startRun (index.js:1054:3)
```

DO SQLite 的 `.one()` 在**零行**时**抛异常**，而不是返回 `undefined`。

**为什么这个坑很危险**：本项目里「查不到」是**完全正常**的路径 ——
账号不存在、会话未绑定、任务进度未创建。若用 `.one()`，
每一个这样的正常路径都会变成 500。

**修法**：`src/store/db.ts` 加 `firstRow()` 助手，用 `toArray()` 取首元素，
把「查不到」变成 `undefined`。所有 5 处 `.one()` 调用点已替换。

## ⚠️ 已知的、刻意的未完成项

| 项 | 状态 | 原因 |
|---|---|---|
| **凭据存储** | ❌ 未实现 | 需要一个 `CREDENTIAL_KEY` secret 做 AES-GCM 加密。**绝不明文落盘**（AGENTS.md §7.1）。第 4 步做。 |
| **`accessToken` 传递** | ❌ 未接通 | 当前所有任务调用都传空串 ⇒ 必然 401。这是**故意的**：在凭据层做好之前不硬编码任何 token。 |
| **积分保底 / costTier 分层选号** | ❌ 未实现 | 依赖实测扣费账本。1–3 个账号时分层收益低于复杂度，**刻意裁剪**（AGENTS.md §3.2）。 |
| **行为事件上报类动作** | ❌ 未实现 | 第一版先打通「签到 + 余额 + 任务列表」三个低风险动作（§9：每步独立可验证）。第 5 步做。 |
| **OpenAI 兼容网关** | ⚠️ 仅占位 | 第 6 步。 |

## 结构

```
src/
├── index.ts                Worker 入口：路由 + 鉴权 + Cron 扇出（只唤起，不执行）
├── env.ts                  Bindings 与「禁止 parseInt(x) || 默认值」的解析助手
├── pool/
│   ├── state.ts            账号状态模型：四维正交惩罚状态机（纯函数，26 条单测锁定）
│   └── AccountPoolDO.ts    账号池 DO：选号、冷却、会话粘性
├── taskrunner/
│   ├── TaskRunnerDO.ts     每账号一个 DO：alarm 步进的状态机
│   ├── actions.ts          动作注册表（字符串名 → 执行体，**不能传函数**）
│   └── plans.ts            任务计划表（协议与逻辑分离）
├── store/
│   └── db.ts               SQLite 访问层（含 firstRow 修复）
└── upstream/
    ├── headers.ts          四套客户端指纹头族（纯函数）
    └── client.ts           HTTP 客户端 + 错误分类（15 条单测锁定）
```

## 复现与验证

```bash
npm install
npm run typecheck    # 类型检查
npm test             # 26 条单测
npm run build:check  # 干跑构建
npm run deploy       # 部署（需已 wrangler login）

# 部署后验证
KEY=$(cat /tmp/wb_api_key.txt)   # 或重新 wrangler secret put API_KEY
BASE=https://workbuddy-gateway.xiegao.workers.dev
curl -s "$BASE/healthz"
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=cn"
```

## 下一步（第 3 步）

上游协议层的**纯函数**部分已部分就位（`headers.ts` / `client.ts`），
第 3 步补齐：`events.ts`（行为事件构造）、`auth.ts`（设备码登录 + 续期）、
`tasks.ts`（任务列表/接受/领奖，**注意领奖路径的坑**）、`checkin.ts`、`travel.ts`。

⚠️ **领奖路径必须先读 AGENTS.md §6.3** —— Go 侧曾在这个路径上长期失败。
