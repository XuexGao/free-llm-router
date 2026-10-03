# 项目指令：workbuddy-serverless

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释、文档、提交信息）一律使用中文。
- 代码标识符、关键字、类型名、配置键保持英文不变。

## 文档状态

**当前阶段：第 1–7 步全部完成。项目可交付。**

- **服务**：`https://workbuddy-gateway.xiegao.workers.dev`
- **面板**：`https://workbuddy-gateway.xiegao.workers.dev/panel/`
- **全部核心能力已用真实账号端到端验证**：凭据加密、任务自动化（growth 计划 23/23 成功）、
  OpenAI 兼容流式网关（54 个模型、对话、工具调用）、面板 + 安全头。
- **179 条单测通过**。

详见 [docs/01-egress-probe.md](docs/01-egress-probe.md)、[02-skeleton.md](docs/02-skeleton.md)、
[03-protocol.md](docs/03-protocol.md)、[04-accounts.md](docs/04-accounts.md)、
[05-task-engine.md](docs/05-task-engine.md)、[06-gateway.md](docs/06-gateway.md)、
[07-panel.md](docs/07-panel.md)。

本文件是本项目的**唯一权威设计文档**。实现前必须读完；实现中若发现本文件的判断与实测不符，**先改本文件再改代码**，不要把偏差留在注释里。

---

## 一、项目目标

构建一个**可部署到 Cloudflare Workers（或同类 serverless）**的服务，提供两件事：

1. **WorkBuddy 任务自动执行**（Task Engine）
   自动推进腾讯 CodeBuddy / WorkBuddy 的成长任务（growth tasks）、每日签到、连登兑换、抽奖、猫猫旅行、夜猫子等行为，并自动领奖。目标是「一键完成」，无需官方客户端、无需人工交互。

2. **API 聚合**（API Aggregator）
   对客户端暴露 **OpenAI 兼容**的 `/v1/models` 与 `/v1/chat/completions`，把上游账号池包装成统一入口，含流式 SSE、账号轮转、冷却熔断、会话粘性。

这两件事**共享同一个账号池与同一份凭据**，但**运行形态完全不同**（一个是长驻有状态的任务机，一个是无状态代理），因此在架构上必须分开设计、通过同一存储层协作。

---

## 二、可行性结论

### 2.1 总判定

**可行，但必须重新实现，不能移植。** 且**任务自动执行部分必须跑在 Durable Object 上**，不能跑在普通 Worker 请求里。

### 2.2 依据：两个参考项目的可移植性

| 参考项目 | 语言/规模 | 对本项目的价值 | 能否直接移植 |
|---|---|---|---|
| `../workbuddy2api-panel` | Go / ~21k 行非测试代码 | **任务协议的权威来源**：25 个任务动作、4 套客户端指纹、领奖路径、幂等判据、真实对话回执 | ❌ 不能。Go 二进制无法在 Workers 运行；且其依赖 23 处文件系统读写、`net/http` 长驻服务、6 处进程内 cron、`go-redis` TCP 客户端 |
| `../deepseek-harness-codearts` | TypeScript / ~68k 行 | **聚合网关的实现范式**：`src/openai-gateway/*` 已把「多 provider → OpenAI 兼容」做完整，且**对宿主的耦合面收敛为 4 个方法** | ⚠️ 部分。网关层可整体借鉴；但它是 DSH 插件，`src/index.ts` 等强耦合宿主 |

**关键结构性发现（决定了本项目的架构）**：
`deepseek-harness-codearts` 的 `src/openai-gateway/server.ts:20-25` 定义了 `LlmRuntimeLike` 接口，网关对 DSH 的真实依赖只有四个方法 —— `listProviders()` / `listModels(provider)` / `resolveModelInfo(provider, model)` / `stream(options)`（外加可选的 `attachments.saveImage`）。
⇒ **只要提供一个实现这四个方法的 runtime 桩，网关可以整体搬到 Workers。** 这是本项目最重要的复用杠杆。

**同时必须知道的事实**：`deepseek-harness-codearts` **完全没有实现** WorkBuddy 成长任务 —— 全仓库 grep `/v2/report` 零命中，`src/credits.ts` 只碰三个 billing 端点（签到/余额），`src/auto-checkin.ts` 只是「启动后 30 秒跑一次签到」。
⇒ **任务引擎没有现成 TS 实现可抄，必须照 Go 侧的协议重新实现。** 这是本项目的主要工作量。

### 2.3 依据：Cloudflare Workers 的实际限额（已核对官方文档）

来源：https://developers.cloudflare.com/workers/platform/limits/ 与 https://developers.cloudflare.com/durable-objects/platform/limits/

| 限额 | Free | Paid | 对本项目的影响 |
|---|---|---|---|
| **CPU 时间/请求** | 10 ms | 30 s（默认，可配到 5 min） | ⚠️ **Free 下的唯一硬约束**：见 §8.2.2 的设计纪律。付费则宽松 |
| **请求墙钟时长** | 无硬上限（客户端连着就行） | 同左 | ✅ **SSE 长流可行** |
| 内存/isolate | 128 MB | 128 MB | ✅ 够用（流式，不整包缓冲） |
| 出站子请求/调用 | 50 | 10,000 | ✅ 够用 |
| **同时出站连接/调用** | **6** | **6** | ⚠️ **真实约束**：账号池并发扫描必须分批，不能 `Promise.all` 打几十个账号 |
| Cron Triggers | 5 个/账号 | 250 个/账号 | ⚠️ **实测本项目账号只剩 1 条可用**（已被其他 Worker 占 4 条）⇒ 改为「1 条每小时 + 内部按时点分发」，见 §9 |
| **Cron 墙钟** | 15 min | 15 min | ⚠️ 单次最多 15 分钟 |
| **Cron CPU** | 10 ms | 30 s（<1h 间隔）/ 15 min（≥1h 间隔） | ✅ 任务主要时间花在 sleep + fetch，CPU 低 |
| **DO Alarm 墙钟** | 15 min | 15 min | ✅ **可自我续期**，这是任务引擎的落点 |
| DO 请求/响应 | 调用方连着就无上限 | 同左 | ✅ |
| Queue consumer 墙钟 | 15 min | 15 min | ✅ 可作重试层 |
| Workflow 单步 | 无上限 | 无上限 | 可作长流程备选 |

### 2.4 为什么任务引擎必须是 Durable Object

这是本项目**最容易做错、代价最高**的一个决定。依据来自 Go 侧的实测数据（`../workbuddy2api-panel`）：

| 常量 | 值 | 出处 |
|---|---|---|
| `reportGap` | 1050 ms | `internal/panel/autotask.go:745` |
| `acceptBatchGap` | 1050 ms | `internal/panel/tasks.go:17` |
| `claimPollGap` × `claimPollAttempts` | 3 s × 4 ≈ 12 s | `internal/panel/autotask.go:241-244` |
| `mpActionGap` | 2 s | `internal/panel/autotask.go:318` |
| `mpChatEventGap` | **45 s + 0~10 s 抖动** | `internal/panel/autotask.go:326` |
| `expertSummonGap` | 6 s | `internal/panel/autotask.go:1051` |
| `accountTaskAutoAll` 超时 | **5 min** | `internal/panel/autotask.go:1249` |

⇒ **单个账号跑完「一键全部任务」需要数分钟；`Sequential_Tasks_6`（target=10）单账号就要约 8 分钟。**

而 Workers 的普通请求 handler **没有跨请求的后台执行**：`setInterval` 只在请求上下文内有效，请求结束即冻结；`ctx.waitUntil()` 只延长 30 秒。

**结论**：
- 任务引擎**不能**写成「一个请求里 sleep 到底」；
- 必须用 **每个账号一个 Durable Object**，把任务拆成**状态机 + alarm 步进**，每步做一个动作、存一次进度、再 `setAlarm()` 续期；
- DO 的**单线程串行**语义**天然等价**于 Go 侧的 per-account `sync.Mutex TryLock`（`internal/panel/panel.go:96`），这一条正好解决了 Go 项目里「expert 系任务重复消耗真实对话」的并发风险。

**DO 的关键约束**（`developers.cloudflare.com/durable-objects/platform/limits/`）：
- 每个 DO 是**单线程**的，软上限约 1000 req/s；
- 单个 SQLite-backed DO 存储上限 10 GB（Paid）；
- key+value 合计 ≤ 2 MB；
- alarm handler 墙钟 15 min，CPU 30 s 默认（可配 `limits.cpu_ms`）；
- **每个 DO 的 CPU 时间会在每次收到请求/WebSocket 消息时重置为 30 s**。

### 2.5 已确认的硬阻塞（必须在设计阶段处理，不能留到实现）

1. **10 ms CPU 配额（Free 计划）**：非阻塞，但强制「一次调用 = 一步」的设计纪律。
   ⚠️ 本节初稿曾判定「Free 不可用」，**该结论已被推翻**：经核对官方文档，**Durable Objects 在 Free 计划可用**（仅 SQLite 后端），
   且 DO Duration（13,000 GB-s/天）+ alarm 机制足以承载任务引擎。详见 §8.2。
2. **本地回调式登录在 Workers 上不可行**：Workers 没有 listen socket。
   `deepseek-harness-codearts` 中 CodeArts / LobsterAI / TRAE / Loomy 微信 / Raccoon 扫码五套登录都依赖 `127.0.0.1:<port>` 接收浏览器回调。
   ✅ **WorkBuddy / buddy 是轮询式设备码**（`POST /v2/plugin/auth/state` → 轮询 `/v2/plugin/auth/token`），**天生适配 Workers**，无本地监听。这是本项目能成立的前提之一。
3. **无持久本地文件系统**：即使 `node:fs` 能 import，Worker isolate 也没有可跨请求持久的磁盘。
   所有状态（凭据、冷却、任务进度、幂等标记）**必须**走 KV / D1 / R2 / DO storage。
   ⇒ Go 侧的 `auths/*.json`、`data/state.json` 的 **tmp+rename 原子写模式没有对应物**，需改用 DO 的串行事务语义。
4. **`node:child_process` 不可用**（`nodejs_compat` 下仅为 stub）：`deepseek-harness-codearts` 中用它探测 opencode 版本、跑 `runtime-info.exe` 取 Qoder 机器码、拉起 headful Chromium 过 zcode captcha。⇒ **zcode 类需要浏览器的能力必须整体排除**（Go 侧 `src/auto-checkin.ts` 也已把 zcode 排除，做法一致）。

### 2.6 需要在实现前定级的两项风险

- **⚠️ 出口 IP 风险（高风险，已建立验证手段）**：Go 项目的 `internal/server/wafip.go` 记录了真实的**IP 级 WAF 拦截** —— 60 秒内 2 个不同账号接连命中 403 即判定出口 IP 被封。Workers 从 Cloudflare 共享 IP 段出网，且**Free 计划无法指定出口 IP**。
  ⇒ 若上游 WAF 对 CF 网段有额外关照，本项目可能**整体不可用**。
  **必须实测**。验证探针已实现并自测通过：`probe/`，方法与判据见 [docs/01-egress-probe.md](docs/01-egress-probe.md)。
  这是**前置验证项**，不是实现细节。

  **🔴 已从本沙箱观测到的关键事实（2026-10-03）**：
  上游网关是 **EdgeOne + APISIX**（响应头 `server: APISIX/3.9.1`、`eo-log-uuid`、`eo-cache-status`）。
  ⇒ 这意味着 WAF 大概率是 APISIX 插件，其拦截面对**机房 IP 段**可能比住宅 IP 更敏感。
  ⚠️ 并且这印证了 §8.2b：上游与 EdgeOne 同属腾讯技术栈。
  同时确认了**本项目登录第一步可用且零配额**：`POST /v2/plugin/auth/state?platform=CLI` 稳定返回
  `{"code":0,...,"data":{"state":...,"authUrl":...}}`，无需凭据、不签 token
  ⇒ 设备码流程**无需本地回调，天然适配 Workers**（印证 §2.5 第 2 条）。

  **⚠️ 判据纪律**：WAF 判据必须严格照抄 Go 的 `IsWafBlocked` ——
  **仅在 HTTP 403 且无业务信封时**判为 WAF。实测 APISIX 对「缺凭据」回的是 **401**
  （`www.workbuddy.cn/console/account` 甚至回 **302**），把 401/302 也当 WAF 会产生假警报。

- **⚠️ 协议时效性风险**：Go 侧的任务判据是**逆向实测**得到的（事件链形状、指纹字段、领奖路径），上游随时可改。
  ⇒ 设计上必须做到「协议表与执行逻辑分离」，使上游变化只需改表不改流程；且必须有真实错误上报，**不允许静默失败**。

---

## 三、范围边界（红线）

### 3.1 使用边界（不可协商）

参考项目 `../workbuddy2api-panel` 的 README 明确声明其定位是**个人自用账号管理**，并明确反对：批量注册小号、账号池出租、付费 API 中转、二次打包售卖。

本项目**继承该边界**，并在实现上体现：

- **只服务本人授权账号**；不提供多租户、不做对外售卖、不做账号池分发。
- **不实现批量注册**：不实现任何自动化账号注册/养号流程。
- 凭据**只存自己的账号**，且需加密存储。

> ⚠️ 若需求实际是「对外提供 API 服务」，本项目的技术方案仍然成立，但**合规边界会被突破**。这类需求必须在实现前明确提出并单独讨论，不能默认纳入。

### 3.2 明确不做（第一版）

| 不做 | 原因 |
|---|---|
| 移植 Go 项目全部功能 | Go 侧 21k 行含大量部署态能力（Docker、面板、归档），与 serverless 目标无关 |
| 一次性支持 13 个 provider | `deepseek-harness-codearts` 的 13 provider 中多数需本地回调或子进程；第一版只做能跑通闭环的子集 |
| zcode 签到（需浏览器产 captcha） | 依赖 headful Chromium，Workers 不可行 |
| 管理面板的完整复刻 | 面板功能多；第一版只做**能验证闭环的最小 API** |
| `Expert_Philanthropy` 任务 | 需真实捐款，Go 侧已实测无法绕过（`internal/panel/autotask.go:19`） |

---

## 四、目标架构

### 4.1 组件图

```
                        ┌──────────────────────────────┐
   客户端 / SDK  ──────►│  Worker: fetch handler       │
   (OpenAI 兼容)        │  /v1/models                  │
                        │  /v1/chat/completions  (SSE) │
                        │  /admin/*              鉴权  │
                        └───────┬──────────────┬───────┘
                                │              │
                    选号/记账 RPC│              │任务控制 RPC
                                ▼              ▼
                   ┌────────────────────┐  ┌──────────────────────┐
                   │ DO: AccountPool    │  │ DO: TaskRunner        │
                   │ (每 realm 一个实例)│  │ (每账号一个实例)      │
                   │ · 冷却/熔断/租约   │  │ · 任务状态机          │
                   │ · 会话粘性         │  │ · alarm 步进          │
                   │ · 凭据读写         │  │ · per-account 串行    │
                   └─────────┬──────────┘  └──────────┬───────────┘
                             │                        │
                             └────────┬───────────────┘
                                      ▼
                          ┌────────────────────────┐
                          │ DO SQLite storage      │
                          │ 凭据(加密)/池状态/任务 │
                          └────────────────────────┘
                                      ▲
                                      │ 扇出
                          ┌───────────┴────────────┐
                          │ Cron Trigger (每小时)  │
                          │  → 逐账号唤起 TaskRunner│
                          └────────────────────────┘
```

### 4.2 为什么是「AccountPool DO」而不是「Worker 内内存池」

Go 侧的账号池状态机（冷却/熔断/在途租约/会话粘性）是**必须跨请求共享且必须串行修改**的。
Workers 会水平扩展 + 随时回收 isolate，模块级变量等于**每个 isolate 一份**，状态必然撕裂。

DO 提供三件这里正需要的东西：
1. **单点串行**（无需自己实现锁）；
2. **持久化存储**（替代 `data/state.json`）；
3. **alarm**（替代进程内 ticker）。

按 realm 分片（`cn` / `global`）而不是全局单例，是为了避免单 DO 的 1000 req/s 软上限成为瓶颈。

### 4.3 为什么「每账号一个 TaskRunner DO」

直接对应 Go 侧的三条实测约束：
1. **per-account 串行**：Go 用 `sync.Mutex TryLock`（`panel.go:96`），冲突返回 409。DO 天然串行 ⇒ 语义**完全一致**，且不用自己写锁。
2. **长时间多步**：DO alarm 可自我续期（每次 15 min 墙钟），足以覆盖 8 分钟的 mp 任务。
3. **可恢复**：进度存 DO storage，实例被回收后 alarm 仍会重新唤起 ⇒ 比 Go 侧「进程重启即丢队列」更强。

---

## 五、模块划分（拟）

```
src/
├── index.ts                  Worker 入口：路由、鉴权、CORS
├── env.ts                    Bindings 类型与 env 解析（禁止 parseInt(x) || 默认）
├── gateway/                  ① 聚合网关（对应 openai-gateway/*）
│   ├── server.ts             路由 + 鉴权 + body 限额 + SSE 输出
│   ├── models.ts             跨账号模型目录聚合（逐账号兜错，承诺不抛）
│   ├── messages.ts           OpenAI 请求 → 上游载荷
│   ├── stream.ts             上游 SSE → OpenAI chunk 流
│   └── runtime.ts            LlmRuntimeLike 的 Workers 实现
├── pool/                     ② 账号池（跑在 AccountPool DO 内）
│   ├── state.ts              条目状态与迁移（对应 pool/entry.go + transition.go）
│   ├── pick.ts               选号（分层 → 权重 → 防惊群 → 加权随机）
│   ├── cooldown.ts           冷却/熔断/降权四维正交状态机
│   └── session.ts            会话粘性
├── upstream/                 ③ 上游协议层（纯函数优先，便于测试）
│   ├── client.ts             fetch 封装 + 统一信封解包 + 错误分类
│   ├── headers.ts            4 套指纹头族（CLI/桌面/web/mp）
│   ├── auth.ts               设备码登录 + token 续期
│   ├── tasks.ts              任务列表/接受/领奖
│   ├── events.ts             行为事件构造（纯函数：事件 → JSON）
│   ├── checkin.ts            签到/余额
│   └── travel.ts             旅行/连登/抽奖/夜猫子
├── taskrunner/               ④ 任务引擎（跑在 TaskRunner DO 内）
│   ├── machine.ts            状态机：步骤表 + 持久化 + alarm 续期
│   ├── actions.ts            25 个任务动作（对应 panel/autotask.go）
│   └── verify.ts             进度回读 + 自动领奖
├── admin/                    ⑤ 管理 API
└── store/                    ⑥ 存储抽象（DO SQLite / KV）
```

**分层纪律**：`upstream/events.ts` 与 `upstream/headers.ts` 必须是**纯函数**（输入账号 + 参数，输出对象），不碰网络、不碰存储。
理由：Go 侧这些是纯 map 构造，最适合用单测锁死事件形状；上游改判据时只改这部分。

---

## 六、必须遵守的协议事实（来自 Go 侧实测）

> 这一节是本项目**最有价值的部分**。全部来自 `../workbuddy2api-panel` 的实测结论，重写时**不要重新踩**。

### 6.1 四套客户端指纹（同一端点，不同判据）

任务计分都走 `POST /v2/report`，但**不同任务认不同客户端指纹**：

| 指纹 | Base | UA | 判别性字段 |
|---|---|---|---|
| CN CLI | `www.codebuddy.cn` | `WorkBuddy/<v> WorkBuddy/<v> CLI/<v>` | `agentName:"default"`, `agentType:"conversation"`, `mode:"craft"` |
| 桌面 | `copilot.tencent.com` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` + `X-Product: SaaS` | `ideName/ideType:"WorkBuddy"`, `extName:"workbuddy-desktop"`, `machineId=deriveID(uid,"machine")` |
| Web | `www.workbuddy.cn` | Chrome UA | `x-client-platform: web`, `machineId=deriveID(uid,"webmachine")`, `pageURL`/`elementId` |
| mp 小程序 | `www.codebuddy.cn` | 无（`X-Client-Product: workbuddy-mp`） | `ideType:"WorkBuddy_MP"`, `platform:"mini_program"`, `X-Client-Platform: mp-weixin`, `machineId` 为**硬编码常量** |

`deriveID(uid, salt) = sha256(salt + ":" + uid)` 取前 18 字节 → 36 位 hex（`internal/upstream/desktop.go:51-53`）。**同账号恒同值**，模拟固定设备。

### 6.2 三个 Base 不可混用

| Base | 用途 |
|---|---|
| `https://copilot.tencent.com` | chat SSE、token 刷新、模型目录、growth 域（任务列表/接受）、桌面与专家事件上报 |
| `https://www.codebuddy.cn` | 签到、余额、CLI 活跃上报、trial、mp 上报 |
| `https://www.workbuddy.cn` | **任务领奖（权威路径）**、账号资料、web 事件 |
| `https://www.workbuddy.ai` | global realm 全部路径 |

### 6.3 领奖路径是历史踩坑点（必须按此实现）

- ❌ **错误**：`POST {copilot}/v2/activity/growth/tasks/reward/claim`，task_code 放 body。
  该路径**不存在**，恒返回 400 `"task not completed"` —— 这是 Go 侧领奖长期失败的真实原因。
- ✅ **正确**：`POST {workbuddy.cn}/activity/growth/tasks/<code>/claim`，**任务码在路径**，无 body，带 `x-client-platform: web`（`internal/upstream/tasks.go:228-254`）。
- mp 任务：`{codebuddy.cn}/activity/growth/tasks/<code>/claim` + mp 头；chat 域 400 时降级到 Web 域。

### 6.4 只有 6 个任务需要真实对话（会真实消耗配额）

`Model_chat_GLM5.2`、`expert_5`（×5）、`Expert_team_use_3`（×3）、`skill_1`、`Expert_lighthouse`、`black_cat`。

其中专家类任务的服务端回执 `requestId` **必须从 SSE 流里抓真实 id**：
正则 `^(cmb-)?[0-9a-f]{32}$`，从 `"id":` 字段提取（`internal/upstream/desktop.go:419-518`）。
⚠️ **自造 UUID 不计数** —— 服务端校验真实性。这是「必须真发对话」的根本原因。

### 6.5 幂等与回读

- **幂等**：`claimed` 即跳过；`Current >= Target && Target > 0` 即跳过；只补**差额**上报。
- **回读**：上游计分是**异步**的（Go 实测约 5–8 s 才从 0/1 变 1/1）。
  参数：`claimPollAttempts = 4`、`claimPollGap = 3 s`（共约 12 s），已 `Claimable || Claimed` 立即返回。
- **mp accept 需回读验证**：上游存在「200 + OK 但未落账」形态，以 `AcceptStatus != "not_accepted"` 为准，未生效重试一次（`internal/panel/autotask.go:290-304`）。
- **mp 事件必须按真人节奏**：`45 s + 0~10 s` 抖动间隔，否则服务端**回滚进度**。

### 6.6 反探测脱敏

请求体只要出现裸数字 `11128` 就会被拦截，**包含在请求里本身就是拦截条件** ⇒ 必须整段改写（`internal/upstream/sanitize.go:70-76`）。

### 6.7 错误分类（决定换号还是罚号）

Go 侧有 13 种 `ErrKind`，判定有 12 层优先级（`internal/upstream/client.go:489-596`）。关键语义：

| 上游信号 | 处置 | 备注 |
|---|---|---|
| 402 / 14018 | 硬冷却至次日 04:00 | 余额耗尽 |
| 429 `code=6004` | **模型级**冷却，对齐上游重置墙钟 | 切模型即可用，不该罚账号 |
| 429 `code=11102` | (账号,模型) 负缓存 6h 起指数退避封顶 24h | 该后端无此模型 |
| 11140 | **Disable 账号** | 请求非法的强信号 |
| 14017 | 软冷却 | |
| 12153 | **连续 3 次**才 Disable | 单次多为网络抖动，误杀健康号 |
| 11115 | 不罚号、不轮转 | 上下文超限 |
| 11135 | 同上 | 图片无效 |
| 403（无业务信封） | WAF，账号级软冷却 | ⚠️ 可能是 **IP 级**，见 §2.6 |

### 6.8 配置解析的唯一硬规则

**绝不写 `parseInt(x) || 默认值`。** `0` 是合法配置值却是 falsy。
`deepseek-harness-codearts` 中至少三处记录了这个同型缺陷（`openai-gateway/config.ts:12-14`、`auto-checkin.ts:188-190`、`buddy-balance-rank.ts:87-89`）。
统一做法：判据只看**归一化后的字符串**是否在显式假值集合里。

---

## 七、实现纪律

### 7.1 安全

1. **凭据加密存储**：上游 token 是明文 bearer，落 D1/DO 前必须加密（用 Worker secret 派生密钥）。Go 侧明文存盘是已知弱点，不要继承。
2. **管理 API 必须鉴权**，且用**常量时间比较**（Go 侧 `internal/httpauth` 用 SHA-256 摘要 + `subtle.ConstantTimeCompare`，连缺头也走一次比较以保持耗时形状）。
3. **不实现 SSRF**：网关不下载 http(s) 图片 URL（`deepseek-harness-codearts` 的 `images.ts:163-168` 明确拒绝，理由是能打环回/云元数据端点）。
4. **错误信息不泄漏凭据**：日志里 token 必须脱敏。

### 7.2 可靠性

1. **幂等优先**：所有写上游的动作都要能安全重放；重放前先读状态。
2. **失败必须显式**：绝不允许「静默失败」。`deepseek-harness-codearts` 记录了多个「没有任何报错就中断」的真实缺陷，全部源于解析器不认错误帧。上游返回非预期形状时**必须抛错并带上原文片段**。
3. **`waitUntil` 只用于收尾**，不承担核心流程（只延长 30 s，且不保证执行）。
4. **每个任务动作单独可重入**：DO 被回收后必须能从 storage 恢复并继续。

### 7.3 测试

- `upstream/events.ts` / `headers.ts` 的**纯函数**用单测锁死形状（这是上游改判据时唯一要改的地方）。
- 状态机迁移用**表驱动**单测（对应 Go 侧 `transition_test.go` 的思路）。
- ⚠️ **付费保护闸门**（继承 `deepseek-harness-codearts` 的纪律）：
  任何**会真实消耗上游配额**的测试（真实对话、真实领奖）必须由**显式环境变量**开启，且默认只跑只读探针。
  绝不允许「无条件遍历免费模型」这类写法 —— 免费资格是服务端**随时可撤销**的营销状态，某天转成计费后一次测试就会按付费价刷 token。

---

## 八、待确认问题

### 8.1 已确认（2026-10-03）

| # | 问题 | 结论 |
|---|---|---|
| A1 | 目标平台 | 重写 TypeScript + **Cloudflare Workers**（见 §8.2） |
| A2 | 付费档位 | **只能 Workers Free 计划**（$0）⇒ 见 §8.2 的可行性分析 |
| B1 | 第一版范围 | **全量**：OpenAI 兼容代理 + Web 面板 + 签到/连登 + 零消耗成长任务 + 设备码登录 |
| B2 | 任务覆盖 | 签到 + 约 19 个零对话消耗任务（6 个需真实对话的任务**不在第一版**） |
| C2 | 账号规模 | **1–3 个** |
| C3 | 请求节奏 | **保持 Go 侧同等保守**（1s+ 间隔、45s mp 间隔） |
| D1 | 出口 IP 风险 | **先实测验证**，再实现 |
| D2 | 告警 | **只记日志**，不接 webhook |
| E1 | 合规边界 | **仅本人授权账号自用** ⇒ §3.1 红线生效 |

### 8.2 ✅ 已决策：路径② TypeScript + Cloudflare Workers（Free 计划）

**决策**：用户选择重写为 TypeScript 部署到 Cloudflare Workers，且**只能用 Free 计划**（拒绝 $5/月 Paid）。
**被否决的路径①**（记录备查）：Go 项目直接部署到 Fly.io —— 零重写、架构完美贴合、可用静态出口 IP（$3.60/月）消除最高风险项。**若路径②因出口 IP 被 WAF 拦而不可行，这是首选回退方案。**

#### 8.2.1 Free 计划额度（已核对官方文档）

来源：https://developers.cloudflare.com/workers/platform/pricing/ 与 https://developers.cloudflare.com/durable-objects/platform/pricing/

| 资源 | Free 额度 | 对本项目是否够用 |
|---|---|---|
| Worker 请求 | 100,000/天 | ✅ 够（1–3 账号自用） |
| **Worker CPU 时间** | **10 ms / 次调用** | ⚠️ **本项目最关键约束**，见 §8.2.2 |
| Worker 墙钟 | HTTP 请求无硬上限（客户端连着即可） | ✅ SSE 长流可行 |
| **Durable Objects** | ✅ **Free 计划可用**（仅 SQLite 后端） | ✅ 关键：任务引擎有着落 |
| DO 请求 | 100,000/天 | ✅ 够 |
| DO Duration | **13,000 GB-s/天** | ⚠️ 需估算，见下 |
| DO 行写入 | 100,000/天（每次 `setAlarm` 计 1 行） | ✅ 够 |
| DO 行读取 | 5,000,000/天 | ✅ 够 |
| DO SQL 存储 | 5 GB | ✅ 够 |
| Cron Triggers | 5 个/账号 | ⚠️ **实测只剩 1 条**（已被其他 Worker 占 4 条）⇒ 已改为「1 条每小时 + 内部按时点分发」，见 §9 |
| DO alarm 墙钟 | 15 min | ✅ 可自我续期 |
| D1 行写入 | 100,000/天 | ✅ 够（日志用） |
| D1 存储 | 5 GB | ✅ 够 |
| Workers Logs | 200,000 事件/天，保留 3 天 | ✅ 满足「只记日志」 |

**DO Duration 估算**（13,000 GB-s/天；DO 按 128 MB 计费 ⇒ 每秒活跃 ≈ 0.125 GB-s）：
13,000 ÷ 0.125 = **104,000 秒/天**（≈28.9 小时）的 DO 活跃时间预算。

单账号一次任务扫全量待办 ≈ 50 步。按保守节奏（每步间隔均值 30 s）估：
50 步 × 30 s = 1,500 s/次；每天约 6 次（签到×2、活跃、旅行×2、成长）⇒ 9,000 s/账号/天。
**3 个账号 ⇒ 27,000 s/天 ≈ 3,375 GB-s，占 Free 额度的 26%。** ✅ 有充足余量。

> ⚠️ **未证实项**：DO 在**等待 alarm 期间**是否计入 Duration（即是否能休眠）。
> 官方表述是「idle 且**符合休眠条件**的 DO 不计 Duration」，但未明确「有待触发 alarm 的对象」是否休眠。
> **若等待期全额计费**：上述估算成立且仍有 74% 余量 ⇒ **结论不变**。
> 若相反（等待期不计费）则更宽松。**故该不确定性不影响可行性判定。**

#### 8.2.2 ⚠️ 唯一硬约束：10 ms CPU / 次调用

Free 计划下 Worker 与 DO 的 CPU 预算都是 **10 ms/次调用**（Paid 才是 30 s）。这**不改变架构，但强制以下设计纪律**：

1. **任务状态机必须「一次调用 = 一步」**：绝不在一次 invocation 内循环或 `await sleep()` 跑多步。
   每步只做「发一个上游请求 → 解析小 JSON → 写一次状态 → `setAlarm()` 排下一步」。
   按此纪律，单步 CPU 消耗约为**数毫秒**（JSON 解析 + 状态写入），**稳在 10 ms 内**。
2. **所有等待都用 alarm 调度，不用 sleep**：45 s 的 mp 间隔 = `setAlarm(now + 45s)`。
   注意：**CPU 只计「实际执行代码」的时间，等待网络 I/O 不计入**。故纯等待不消耗 CPU 预算。
3. **代理必须流式，禁止整包缓冲**：SSE 逐帧透传（`TransformStream`），不做全量 `await response.json()`。
4. **⚠️ 图片请求是最大风险**：base64 图片解码 + 大 JSON 解析可能**超出 10 ms CPU**。
   第一版策略：**限制单张图片大小与总请求体大小**，超限直接返回明确错误（而不是超时崩溃）；
   并在实现后**实测**单张图片的 CPU 消耗，据此定阈值。

#### 8.2.3 Free 计划下的架构调整

由于 Free 额度收敛，存储方案从「KV + D1 + DO」简化为**以 DO SQLite 为主**：

| 数据 | 落点 | 理由 |
|---|---|---|
| 凭据（加密） | **DO SQLite** | 需强一致 + 串行写；KV 是最终一致（60 s），不适合 |
| 账号池状态（冷却/熔断/租约） | **DO SQLite** | 同上；且 KV Free 仅 1,000 写/天，太紧 |
| 会话粘性绑定 | **DO SQLite** | 同上 |
| 任务进度/幂等标记 | **DO SQLite**（TaskRunner DO 内） | 天然按账号隔离 |
| 请求日志/历史 | **Workers Logs**（`console.log`） | 200,000 事件/天 + 保留 3 天，满足「只记日志」 |
| ~~KV~~ | **不使用** | Free 仅 1,000 写/天，且最终一致；无必要 |

**Cron 扇出模型**（Free 计划下 Cron 只有 10 ms CPU，故只做廉价的扇出）：
```
Cron Trigger（如 0 9 * * *）
  → scheduled() handler：读账号列表（DO RPC）
  → 对每个账号调用 TaskRunner DO 的 start()
  → 立即返回（不做实际任务工作）
TaskRunner DO
  → alarm() 每次执行一步，完成后 setAlarm() 排下一步
  → 全部完成则不再排 alarm（对象进入 idle）
```

#### 8.2.4 剩余风险

| 风险 | 状态 |
|---|---|
| **出口 IP 被 WAF 拦**（§2.6） | ✅ **已验证通过（2026-10-03）**：CF 出口 `2a06:98c0:3600::103`，25 次请求 0 拦截。⚠️ 但测的是**无凭据只读**请求；带真实凭据的场景仍需在第 3–5 步复核 |
| 10 ms CPU 超限 | ⚠️ 按 §8.2.2 纪律设计可控；需实测图片路径 |
| DO 等待期计费语义 | ⚠️ 未证实，但两种情形下都够用（§8.2.1） |
| 协议时效性 | ⚠️ 采用「协议表与逻辑分离」缓解 |

### 8.2b EdgeOne Pages（EdgeOne Makers）可行性评估 —— 不适用

**结论：不能承担「任务自动执行」。** 证据来自官方 skill 仓库（`TencentEdgeOne/edgeone-makers-tools`，62 篇文档全量 grep）。

**平台有两个互斥的运行时**：

| | Edge Functions | Cloud Functions |
|---|---|---|
| 运行时 | V8 纯 JS（ES2023） | Node 20.x / Go 1.26+ / Python 3.10 |
| npm | ❌ 不支持 | ✅ 支持 |
| CPU / 墙钟 | **CPU 200 ms** | **墙钟 120 s** |
| 请求体 | 1 MB | 6 MB |
| 包体积 | 5 MB | 128 MB |
| KV 存储 | ✅ **仅此侧可用** | ❌ 不支持 |
| Blob 存储 | ❌ | ✅ `@edgeone/pages-blob` |

**三条硬伤**：

1. **无定时任务能力（决定性）**。
   全仓库 grep `cron|schedule|scheduled|定时任务|周期任务`，仅在 `makers-deploy/SKILL.md:363` 出现：
   > "**Scheduled / automated jobs** — e.g. 「每日定时生成一个页面并部署」, cron pipelines, any task that must run with nobody watching"
   这是**匿名部署的适用场景描述**，不是平台功能。**平台没有 cron / scheduled function / timer 触发**。
   ⇒ 本项目的核心需求是「自动执行」，无定时器即无法成立。

2. **Cloud Functions 墙钟 120 秒封顶**，且三种运行时一致写死。
   ⇒ 单账号跑完任务需数分钟（见 §2.4），会被强制切断，且**没有可续期的 alarm 机制**。

3. **KV 与 Cloud Functions 互斥**：
   KV **只在 Edge Functions 可用**（而那是 200 ms CPU 的 V8 环境，且不支持 npm）；
   有 npm 与 120 s 额度的 Cloud Functions **不能访问 KV**。
   且 KV 是**最终一致（≤60 s 全局同步）**，账号冷却/熔断状态会读到脏数据。
   平台**没有托管数据库**（官方明确："There is NO managed database on this platform — no SQL, no MongoDB, no Prisma, no ORM"），
   官方建议「**Blob IS your database**」，把表建模为 key 前缀——但对高频读写的池状态与并发租约**不适用**。

**唯一可用的部分**：静态托管 + Cloud Functions 的请求/响应模型可以承载**无状态的 OpenAI 兼容代理**（若其 6 MB 请求体与 120 s 上限可接受，且出口 IP 风险另论）。
但「任务自动执行」必须落在别处。

**顺带记录**：`makers-env-adaption/SKILL.md` 全篇是**针对 WorkBuddy 沙箱环境**的适配指南 —— 即腾讯自己的 WorkBuddy 与该平台是配套生态。这意味着 EdgeOne 出口 IP 与上游同属腾讯体系，WAF 行为**未知**（既可能因同源而宽松，也可能因风控策略而特殊对待），**必须实测**，不可假设。

### 8.3 剩余待确认项

以下问题**不阻塞开工**，可在实现过程中按需确认：

- **C1. 账号导入格式**：Go 侧 `auths/*.json` 是嵌套形/扁平形双形态（`internal/auth/auth.go:219-266`）。
  第一版建议**支持导入该格式**，便于与既有环境互通；设备码登录作为新增入口。
- **B1. realm 支持范围**：Go 侧支持 `cn`（`copilot.tencent.com`）与 `global`（`www.workbuddy.ai`）双域。
  建议**第一版只做 `cn`**（任务体系目前只在 CN 域验证过），global 留接口。
- **D2. 协议失效时的行为**：建议**暂停该任务并记录明确错误**，不静默降级（符合 §7.2）。

---

## 九、实施进度

| 步骤 | 状态 |
|---|---|
| 1. 出口 IP 前置验证 | ✅ **通过**：CF 出口 `2a06:98c0:3600::103`，25 次请求 0 WAF 拦截。见 [docs/01-egress-probe-result.json](docs/01-egress-probe-result.json) |
| 2. 骨架（DO + SQLite + 鉴权 + alarm） | ✅ **完成**：alarm 逐步执行队列实测通过。见 [docs/02-skeleton.md](docs/02-skeleton.md) |
| 3. 上游协议层 | ✅ **完成**：四套指纹、错误分类、设备码登录、任务/签到/旅行/上报、AES-GCM 凭据加密。见 [docs/03-protocol.md](docs/03-protocol.md) |
| 4. 账号接入 | ✅ **完成**：双形态导入 + 删除（带 confirm）。**凭据全链路打通**（假 token → 上游真实 401）。见 [docs/04-accounts.md](docs/04-accounts.md) |
| 5. 任务引擎动作 | ✅ **完成**：11 个零消耗动作 + 领奖闭环。**真实账号 growth 计划 23/23 全部成功**。见 [docs/05-task-engine.md](docs/05-task-engine.md) |
| 6. 聚合网关 | ✅ **完成**：`/v1/models`（真实 54 个模型）+ 流式 `/v1/chat/completions`（含工具调用）+ **已接入账号池**（选号/记账/换号）。见 [docs/06-gateway.md](docs/06-gateway.md) |
| 7. Web 面板 | ✅ **完成**：`/panel/` 已上线（账号运维 / 导入 / 设备码登录 / 任务触发+进度 / 模型目录）。CSP 保持严格（无 `unsafe-inline`），安全头齐全。见 [docs/07-panel.md](docs/07-panel.md) |

**测试**：`npm test` → **179/179 通过**。`npm run typecheck` → 通过。

**面板地址**：`https://workbuddy-gateway.xiegao.workers.dev/panel/`

### 🎯 真实账号端到端验证结果（2026-10-03）

用真实凭据实测，**全部成功**：

| 验证项 | 结果 |
|---|---|
| 凭据全链路（导入→加密→解密→出站） | ✅ |
| 任务自动化 `growth` 计划 | ✅ **23/23 步全部成功，零失败** |
| 其中 `first_buddy` | ✅ **真实领到 +300 积分 +8 能量** |
| 剩余未领任务 | 3 个，**恰好都是确实无法自动化的**（微信关注 / 真实对话 / mp 专家对话）—— 与 Go 项目声称的「17/18 可自动化」吻合 |
| `/v1/models` | ✅ 真实 **54 个模型** |
| 流式对话 | ✅ 真实回复，22 帧 + `[DONE]` + usage 完整 |
| 工具调用 | ✅ `finish: tool_calls`，10 个 tool_calls 帧，零错误 |
| 网关记账 | ✅ `successCount` 从 0 → 2（证明回写池状态） |

### 🔴 已实测发现的约束（都必须记住）

1. **cron 配额只剩 1 条**（账户 Free 上限 5，被其他 Worker 占 4）
   ⇒ 用「1 条每小时 + Worker 内按 UTC+8 分发」（`src/index.ts` 的 `SCHEDULE_UTC8`）。
   **代价**：任务时点粒度只能是整点。
2. **DO SQLite 的 `.one()` 在零行时抛异常**（不是返回 undefined）
   ⇒ 统一用 `firstRow()` 助手。**新增 SQL 查询不要直接用 `.one()`**。
3. **DO RPC 不支持泛型透传**（`Expected 0 type arguments`）
   ⇒ 跨 DO 方法返回 `unknown`，调用方在边界断言一次。
4. **DO 不能接收函数**（RPC 只传可结构化克隆的值）
   ⇒ 动作用「字符串名 + 注册表」，不注入执行器。
5. **`expiresAt` 单位**：Go 存**秒**，本项目用**毫秒**，导入时必须 ×1000（否则永远「需要续期」）。

### ⚠️ 仍未消除的风险（诚实记录，优先级从高到低）

| 项 | 影响 | 状态 |
|---|---|---|
| **IP 级 WAF 护栏**（`wafIPGate` 等价物） | 短窗内多号接连 403 时应在**进程级** fail-fast；当前只有账号级软冷却，真遇到会轮转完所有号才停 | ❌ 未实现 |
| **带真实凭据的高频请求是否会被 IP 级拦截** | 第 1 步只验证了**无凭据只读**请求 | ⚠️ 未验证 |
| **会话粘性** | 同一会话可能落不同账号 → 上游 prompt cache 未命中（多花钱、更慢） | ❌ 未实现 |
| **图片入站** | Free 计划 10ms CPU 下 base64 图片解码可能超限 | ❌ 未实现 |
| **连登兑换 / 抽奖 / 旅行** | `travel.ts` 已实现但**未接入计划表**（当前 `growth` 计划只覆盖 11 个任务动作） | ❌ 未接入 |

### 项目结构（最终）

```
src/
├── index.ts              Worker 入口：路由 + 鉴权 + Cron 扇出
├── env.ts                Bindings 与「禁止 parseInt(x) || 默认值」的解析助手
├── gateway/              ① OpenAI 兼容网关
│   ├── server.ts         选号 → 转发 → 记账 → 失败换号（流式透传）
│   ├── payload.ts        请求体准备（4 处必改 + 工具配对清理）
│   ├── stream.ts         SSE 帧解析与转换（4 种错误形态识别）
│   ├── models.ts         模型目录（data.models 单层 + 双层兼容）
│   └── http.ts           JSON 响应助手
├── pool/                 ② 账号池（AccountPoolDO + 四维正交状态机）
├── taskrunner/           ③ 任务引擎（TaskRunnerDO + 11 个动作 + 领奖闭环）
├── upstream/             ④ 上游协议层（四套指纹 / 错误分类 / 登录 / 导入）
├── panel/                ⑤ 管理面板（严格 CSP + 安全头）
└── store/                ⑥ 存储（DO SQLite + AES-GCM 凭据加密）
```

## 十、参考文件

| 用途 | 路径 |
|---|---|
| 任务协议权威来源 | `../workbuddy2api-panel/internal/upstream/*.go`、`internal/panel/autotask.go` |
| 账号池状态机参考 | `../workbuddy2api-panel/internal/pool/*.go` |
| 网关实现范式 | `../deepseek-harness-codearts/src/openai-gateway/*.ts` |
| 上游错误分类参考 | `../workbuddy2api-panel/internal/upstream/client.go` |
| Workers 限额 | https://developers.cloudflare.com/workers/platform/limits/ |
| DO 限额 | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Node 兼容性 | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ |
