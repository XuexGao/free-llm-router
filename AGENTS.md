# 项目指令：free-llm-router

> **对外名称统一用 `free-llm-router`**：多供应商账号池 → 一个 OpenAI 兼容入口。
>
> ⚠️ 历史名称：`workbuddy-serverless` → `hivegate` → **`free-llm-router`**。
> **仓库名、Worker 名、`package.json` 名现在三者一致**，不再有历史遗留。
>（Worker 名在网页端改过，`wrangler.jsonc` 已同步 —— 见该文件开头的说明。）

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释、文档、提交信息）一律使用中文。
- 代码标识符、关键字、类型名、配置键保持英文不变。

## 文档状态

**当前阶段：第 1–8 步全部完成。项目可交付。**

- **服务**：`https://<你的域名>`（备用 `<worker 名>.<你的子域>.workers.dev`）
- **面板**：`https://<你的域名>/panel/`
- **全部核心能力已用真实账号端到端验证**：凭据加密、任务自动化（growth 计划 23/23 成功）、
  OpenAI 兼容流式/非流式网关（54 个模型、对话、工具调用）、面板 + 安全头。
- **417 条单测通过**（`npm test`）。

**第 1–8 步的实施记录、实测结论与踩过的坑，全部在 [§9 实施进度与实测发现](#九实施进度与实测发现)。**
原先 `docs/` 下的 8 份分步文档已并入该节，`docs/` 目录已删除。

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
  **必须实测**。验证探针已实现并自测通过：`probe/`，方法与判据见 §9.2。
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
| 支持全部 provider | ✅ **已做 10 家厂商 / 11 个变体**（第 8 步，含腾讯国内版 + 国际版双变体）。`loomy` 已于提交 `9ac653f` 整体删除；未接的家其推理仍可以「导入凭据」方式使用 |
| ~~zcode 签到~~ | 已确认**不可行**（需 headful Chromium 过阿里云 captcha）；推理不受影响 |
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

## 九、实施进度与实测发现

**第 1–8 步全部完成，项目可交付。** `npm test` → **417/417 通过**；`npm run typecheck` → 通过。

> 本节是**唯一的实施记录**：每一步做了什么、**实测验证到什么**、以及**踩到的真实坑**。
> 原先分散在 `docs/` 下的 8 份分步记录已全部并入本节，`docs/` 目录已删除。
> 合并原则：只保留**实测得出的事实**与**踩过的坑**，不复述代码。

### 9.1 步骤总览

| 步骤 | 状态 |
|---|---|
| 1. 出口 IP 前置验证 | ✅ **通过**：CF 出口 `2a06:98c0:3600::103`，25 次请求 0 WAF 拦截 |
| 2. 骨架（DO + SQLite + 鉴权 + alarm） | ✅ **完成**：alarm 逐步执行队列实测通过 |
| 3. 上游协议层 | ✅ **完成**：四套指纹、错误分类、设备码登录、任务/签到/旅行/上报、AES-GCM 凭据加密 |
| 4. 账号接入 | ✅ **完成**：双形态导入 + 删除（带 confirm）。**凭据全链路打通**（假 token → 上游真实 401） |
| 5. 任务引擎动作 | ✅ **完成**：11 个零消耗动作 + 领奖闭环。**真实账号 growth 计划 23/23 全部成功** |
| 6. 聚合网关 | ✅ **完成**：`/v1/models` + 流式/非流式 `/v1/chat/completions`（含工具调用）+ 已接入账号池 |
| 7. Web 面板 | ✅ **完成**：`/panel/` 上线，**7 视图**，CSP 严格 |
| 8. 多供应商 | ✅ **完成**：**11 个变体 / 10 家厂商**接入统一 `Provider` 接口（约 14.5k 行） |

### 9.2 第 1 步：出口 IP / WAF 前置验证（✅ 通过）

**为什么必须先做**：Go 参考实现在 `internal/server/wafip.go` 记录了真实的 IP 级拦截 ——
60 秒内 2 个不同账号接连命中 403 即判定出口 IP 被封。Workers 从**共享 IP 段**出网，
Free 计划**无法指定出口 IP**；若上游对 CF 网段有额外关照，项目在写第一行业务代码前就不成立。

**探针**：`probe/` 是一个独立的最小 Worker，只发**只读、零配额**请求，出站头**逐字对齐**
Go 侧 `internal/panel/login.go:54-64` 的 `commonHeaders`（否则风控看到的指纹与生产不同，验证失去意义）。
三个目标：`cn-auth-state`（登录第一步）、`cn-billing`（负向，预期鉴权拒绝）、`cn-web`（web 域负向）。

**WAF 判据（关键）**：严格照抄 Go 的 `IsWafBlocked`（`internal/upstream/client.go:337-340`）——
**仅 HTTP 403 且无业务信封**（HTML/空体/纯文本）判为 WAF；
HTTP 200 + `{code:0}` 判通；4xx 但带业务信封判通；**401 / 302 且无信封也判通**。
⚠️ 实测 APISIX 对「缺 Authorization」回的是 **401**，`www.workbuddy.cn/console/account` 回 **302**；
把 401/302 也当 WAF 会产生**假警报**，误导决策。

**实测结果（2026-10-03，探针原始输出已并入下表）**：

| 项 | 值 |
|---|---|
| Cloudflare 出口 IP | `2a06:98c0:3600::103`（IPv6；`loc=SG`、`colo=SIN`） |
| 请求总数 | 5 轮 × 3 目标 + 10 轮加压 = **25 次，0 次 WAF 拦截** |
| `cn-auth-state` | **15/15 = HTTP 200 + `code:0`**，耗时 253–973 ms |
| `cn-billing` | 5/5 = **401**（正常鉴权拒绝，非 WAF） |
| `cn-web` | 5/5 = **302**（正常鉴权拒绝，非 WAF） |
| 汇总 | `waf_blocked: 0`、`network_error: 0`、`unexpected: 0` |

**⇒ 判定：可行，进入第 2 步。**
⚠️ **边界**：本次测的是**无凭据的只读请求**；带真实凭据 + 真实对话的完整链路
在第 8 步时仍以低频为主，**未覆盖高频场景**（见 §9.14）。

**同批观测到的协议事实（可直接用于实现）**：

1. **登录第一步可用且零配额**：`POST /v2/plugin/auth/state?platform=CLI` 稳定返回 HTTP 200
   与 `{code:0, data:{state, authUrl}}`，连续多轮 200 且 `state` 每次不同
   ⇒ **确认轮询式设备码流程无需本地回调，天然适配 Workers**。
2. **🔴 上游网关是 EdgeOne + APISIX**：响应头实证 `server: APISIX/3.9.1`、`eo-log-uuid`、
   `eo-cache-status`、`set-cookie: tgw_l7_route=…`。⇒ WAF 大概率是 APISIX 插件，
   其拦截面对**机房 IP 段**可能比住宅 IP 更敏感（与 §8.2b 的 EdgeOne 生态观察互相印证）。
3. `www.workbuddy.cn/console/account` 是**只读 GET 端点**，可安全用于探测；
   **不要**用领奖端点做探针（那是写操作）。

**探针自身的质量保证**：判据函数用**真实观测到的响应体**做了 9 条单测
（含 403 带信封不该误判、401/302/500 不该误报），9/9 通过；
`wrangler deploy --dry-run` 构建通过（9.67 KiB / gzip 3.78 KiB）；
探针**串行请求 + 1.2 s 间隔**、上限 10 轮 —— 避免探针自己变成风控触发源。

### 9.3 第 2 步：骨架（✅ 完成）

**部署实测**：Worker + 两个 DO（`AccountPoolDO` 每 realm 一个、`TaskRunnerDO` 每账号一个），
DO 存储后端 **SQLite**（Free 计划唯一可选）；体积 37.34 KiB / gzip 11.57 KiB；启动 **2 ms**；
Cron **1 条**（`0 * * * *`）；单测 **26/26**；类型检查通过。

**已验证的行为**：`/healthz` 免鉴权返回 `{ok:true}`；无密钥访问 `/admin/pool` → **401**；
正确密钥 → DO 计数；**DO 自动建表**（`blockConcurrencyWhile` + `migrate()`）生效；
`POST /admin/tasks/start` 返回 `queued: 3`；**alarm 逐步执行 3 步队列，顺序正确**
（`listTasks → balance → checkin`）；**失败如实上报**（未传 accessToken ⇒ 3 步均报 401
并带**响应原文片段**，不静默）；`/v1/models` 返回空列表 + 明确说明未实现（**不编造数据**）。

**🔴 实测发现的平台约束：cron 配额只剩 1 条。**
原设计声明 3 条 cron（`0 9` / `0 21` / `0 10`），部署失败：
`This account has reached the Workers Free limit of 5 cron triggers per account. [code: 10072]`。
排查后实测该账号 5 个配额**已被其他 Worker 占用**：`cf-server-monitor`（2 条）、
`cloud-mail`（1 条）、`nodewarden`（1 条），**剩余 1 条**。
⇒ 改为 **1 条每小时 cron + Worker 内按 UTC+8 时分发**（`src/index.ts` 的 `SCHEDULE_UTC8`）。
这反而更好：省 4 条配额、改时点不用重新部署、非任务时点**零 DO 调用**（连 DO Duration 都不消耗）。
**代价**：所有任务时点粒度只能是**整点**（Go 侧支持任意分钟）。

**🐛 实测踩到并修复：DO SQLite 的 `.one()` 在零行时抛异常**（不是返回 `undefined`）。
现象：`POST /admin/tasks/start` 传不存在的 uid，返回 `error code: 1101`（Worker 抛异常），
本意是 404「账号不存在」。`wrangler tail` 抓到的真实堆栈是
`Error: Expected exactly one result from SQL query, but got no results.`
**为什么危险**：本项目里「查不到」是**完全正常**的路径（账号不存在、会话未绑定、进度未创建），
用 `.one()` 会把每个正常路径都变成 500。
**修法**：`src/store/db.ts` 加 `firstRow()` 助手（`toArray()` 取首元素），替换全部 5 处调用点。

### 9.4 第 3 步：上游协议层（✅ 完成）

**范围**：`upstream/events.ts`、`auth.ts`、`tasks.ts`、`checkin.ts`、`travel.ts`、`report.ts`、
`store/crypto.ts`；单测 **78/78**；类型检查通过；已部署。

**线上实测**：`POST /admin/login/start` 返回真实 `copilot.tencent.com/login?platform=CLI&state=…`
+ 5 分钟有效期；`GET /admin/login/poll` 未授权时返回 `{done:false}` + **HTTP 200**（不是错误）、
未知 state 返回 **404** + 明确提示重新发起；`GET /admin/credentials` 返回持有凭据的 uid 列表
（**不回 token**）；`POST /admin/tasks/start` 无凭据时报「没有凭据，请先登录」。

**🔴 凭据加密落地（不再明文）**：Go 侧把 token **明文**写进 `auths/*.json`（其 README 自承这是弱点），
本项目**不继承**：

- **AES-GCM** 加密后落 DO SQLite，每次加密用**新 IV**（GCM 下 IV 重用是灾难性的：
  会同时泄漏明文异或值并允许伪造认证标签）；
- 密钥来自 Worker secret `CREDENTIAL_KEY`；
- **未配置密钥时抛错拒绝写入**（fail-closed），不静默降级明文 —— 静默降级是最糟的选择，
  用户会以为「已经加密了」；
- 篡改密文会因认证标签校验失败而抛错，**不返回垃圾明文**。

12 条加密单测锁定这些性质（明文不出现在密文里、两次加密 IV 不同、换密钥无法解密、篡改被检测）。

**🐛 单测发现的两个真实缺陷**：

1. **`parseTasks` 把脏数据变成空任务**：上游返回 `tasks:[null]` 或 `tasks:[{}]` 时产出
   `{taskCode:'', title:'', …}` 的**空任务对象**。空任务会进入执行队列，无法 accept、无法领奖，
   只会污染 `lastError` 并白打上游请求。**修法**：`taskCode` 是唯一标识，**缺它就丢弃该条目**
   （而不是补默认值）。
2. **测试断言了错误的字段名（测试错，不是代码错）**：断言 `chat_request_send` 上同时有
   `parentConversationId` 与 `conversationId` 时失败。回查 Go 侧 `desktop.go` 确认
   `chat_request_send` **只有 `parentConversationId`**，而 `chat_message_response` 两个都有。
   **代码是对的，测试是错的**。已修正测试并把「哪些事件有哪些会话键」显式钉住 ——
   因为**字段名写错不会报错**，只会让服务端 join 不上、任务静默不点亮。

**📌 本步固化的关键协议事实**（实现位置见括号）：

| 事实 | 为什么重要 |
|---|---|
| 领奖走 `{web}/activity/growth/tasks/<code>/claim`（码在路径、无 body、带 `x-client-platform: web`）（`tasks.ts`） | Go 侧曾误用 chat 域 `/v2/…/reward/claim`（码放 body），该路径**不存在**，恒返 400 并长期误诊为「任务没做完」 |
| mp 领奖 chat 域 400 时**降级 web 域**（`tasks.ts:claimRewardMp`） | 实测 web 域可领，只试一个域名会失败 |
| 余额取 `CycleCapacityRemain`（本周期），不是 `CapacityRemain`（终身）（`checkin.ts`） | 同一响应里两者差异巨大（655 vs 155.67），取错会高估余额 |
| 签到状态用 `checkin-activity-status`，**不是** `checkin-status`（`checkin.ts`） | 后者返回占位数据，会误判「活动未开启」而放弃签到 |
| 桌面事件链 6 个，`chat_message_response.isSuccessful` 必须是 `true`（`events.ts`） | 只发前半段或 `isSuccessful:false` 点不亮 |
| 裸数字 `11128` 必须改写（`11-128`）（`report.ts`） | 它出现在请求里**本身就是拦截条件**；零宽空格无效（上游会归一化） |
| uid 只放行 `[A-Za-z0-9_-]` 且 ≤64（`auth.ts:isValidUid`） | uid 来自上游且用作 storage key，是安全边界 |
| `expiresIn` 缺省**不编造**过期时间（`auth.ts`） | 编造会让续期逻辑误判「还有一小时」，然后打到 401 |

**刻意的范围裁剪**：不做真实对话类任务（`NEEDS_REAL_CHAT` 显式拒绝，而非静默跳过）；
不做 zcode 类需浏览器产 captcha 的能力；不做积分保底分层选号（1–3 账号时收益低于复杂度）。
**当时的能力边界**：登录流程可用，但还没有真实账号跑通完整签到（需先浏览器授权一次）。

### 9.5 第 4 步：账号接入（✅ 完成）

**范围**：`src/upstream/import.ts`、`tests/import.test.ts`；单测 **98/98**；类型检查通过。
三条接入路径都打通：设备码登录（第 3 步）、**凭据导入** `POST /admin/import`、
**删除账号** `POST /admin/accounts/remove`（带 `confirm` 守卫）。

**🔑 核心验证：凭据全链路打通**（本步最重要的验证）：

| 环节 | 证据 |
|---|---|
| ① 导入解析 | 嵌套形正确解析，`expiresAt` 秒→毫秒转换正确（`1799999999` → `1799999999000`） |
| ② 加密落盘 | `GET /admin/credentials` 返回该 uid（**不返回 token**） |
| ③ 账号条目建立 | `GET /admin/accounts` 返回昵称等字段 |
| ④ **解密并注入出站请求** | 用导入的**假 token** 启动任务 → 上游返回**真实 HTTP 401** |

**第 ④ 条是关键**：之前（凭据层未做时）报的是「没有凭据」；现在报的是**上游的 401** ——
说明 token 真的被解密、注入到出站请求、并发到了上游。换成真 token 即可直接工作。

**导入格式兼容 Go 侧双形态**（用户可能已在跑 Go 版，账号都在 `auths/`；不兼容就得重新登录每个账号）：
判据是**顶层有没有 `auth` 键**，不是猜字段（扁平形也含 `domain`/`expiresAt`）。
**嵌套形**（插件 OAuth 输出，主形态）：`{auth:{accessToken,refreshToken,expiresAt,domain,realm}, account:{uid,enterpriseId,nickname}, device_token}`；
**扁平形**（手写/旧版）直接铺平。载荷支持**单对象 / 数组 / `{accounts:[…]}`** 三种。
另兼容 DSH 的 snake_case（`access_token` / `user_id` / `expires_at`）。

**⚠️ 单位陷阱：`expiresAt` 是 Unix 秒**。Go 侧存**秒**（`auth.go:302-305` 用 `.Unix()`），
本项目用**毫秒**。⇒ 导入时不 ×1000，过期时间会落到 1970 年，续期逻辑会**永远判定「需要续期」
并反复打上游** —— 表现为「莫名其妙一直在刷新」，而不是一个显眼的报错。
已用启发式归一化（`< 1e12` 视为秒）并单测锁定。

**逐条独立 + 失败必回报**：批量导入时单条失败不影响其他条（账号目录里混一个坏文件很常见），
但失败原因**必须回报**，不静默丢弃：
`{ok:true, imported:[{uid,nickname,realm,expiresAt}], skipped:[{reason, source}]}`。
**报告里不含 token**（会进日志），有单测专门断言「序列化后的报告不含 token 字符串」。

**🔒 本步新增/强化的安全约束**：

| 约束 | 实现 | 理由 |
|---|---|---|
| uid 白名单 | `isValidUid`：`[A-Za-z0-9_-]` 且 ≤64 | uid 来自上游且**用作 storage key**；Go 侧记录过同型风险的严重形态：uid 曾直接被拼进**文件名**，构成路径穿越 |
| 删除需显式确认 | 请求体必须带 `"confirm": true` | 删除**不可逆**（连带凭据），防手滑 |
| 未配密钥拒绝写入 | `requireCredentialKey` 抛错 | 不静默明文落盘 |
| 响应脱敏 | 所有端点只回非敏感字段 | token 绝不回给客户端 |

### 9.6 第 5 步：任务引擎动作（✅ 完成）

**范围**：`taskrunner/verify.ts`、`taskrunner/steps.ts`，扩展 `actions.ts` / `plans.ts`；
单测 **111/111**；线上验证 `growth` 计划入队 **23 步**，全部按序执行完毕。

**线上实测（用假 token 跑，验证编排与错误分层）**：`finished: True | 队列剩: 0 | 已完成: 23`，
其中 `listTasks` / `chat5` / `firstBuddy` 因假 token 报 401（`ok=False`），
而 `richMeow` / `buddyApp` 的**事件上报成功**（`ok=True`，`/v2/report` 200）。
**这个结果恰好验证了分层是正确的**：事件上报端点**不严格校验 token**，故 `ok=True`；
回读/领奖端点**需要有效 token**，故 401 —— 换成真 token 即可工作。

**已实现的 11 个零对话消耗动作**：

| 任务码 | 动作 | 判据要点 |
|---|---|---|
| `chat_5` | `chat5` | CLI `chat_request_send` × 差额（自动补足） |
| `first_buddy` | `firstBuddy` | **前置上报 → 同意协议 → 领养**（顺序不可调换） |
| `RichMeow_Chat` | `richMeow` | 桌面 6 事件链，`isSuccessful:true` 是核心 |
| `Buddy_App` / `Buddy_App_QQ` | `buddyApp` | 桌面 5 事件链（共用实现） |
| `automation_1` | `automationCreate` | 单事件 `automated_task_create_suc` |
| `Library_read` | `libraryRead` | **web 域** + `x-client-platform: web` |
| `template_5` | `templateUse` | 事件组 × 差额 |
| `playbook_prompt` | `playbookPrompt` | 判据是 `playbook_prompt_send`（非曝光/点击） |
| `create_canvas` | `createCanvas` | `wbx_design_canvas_*` 事件组 |
| `Hp_Appearance` | `hpAppearance` | `appearance/set` API + `appearance_skin_apply` 事件 |
| （通用） | `verifyAndClaim` | 回读 + 自动领奖 |

**明确默认不入队**（`NEEDS_REAL_CHAT`，会消耗配额）：`Model_chat_GLM5.2`、`expert_5`、
`Expert_team_use_3`、`skill_1`、`Expert_lighthouse`、`black_cat`。有单测核对这个集合与 §6.4 一致。

**🔑 领奖闭环：为什么必须「回读 → 有界轮询 → 领奖」。**
上游计分是**异步**的（Go 侧实测：上报后立即回读仍是 0/1，**约 5–8 秒后**才变 1/1）。
⇒ 只读一次会误判「未达标」→ **跳过领奖** → 任务做了但积分永远拿不到，**且没有任何报错**。
故实现为固定预算轮询（沿用 Go 侧实测值）：`claimPollAttempts = 4` 次、`claimPollGap = 3 秒`、
总预算 **≈12 秒**。**为什么必须有界**：不能用 `while(!done)` 无限等 ——
上游若永久不达标，会无限占用 DO alarm 并白烧 Free 计划的 Duration 配额。
**为什么轮询期间的查询失败不覆盖已有结果**（Go 侧 `autotask.go:260` 同口径）：
中途失败若覆盖了先前的成功结果，会把「已达标」误判成「未知」。
单测锁定：轮询次数 > 1（不能只读一次）、≤ 10（必须有界）、总预算在 6–30 秒区间。

**🐛 本步踩到并修复的两个问题**：

1. **单测把 DO 代码拽进来，导致 Node 无法加载**：加 `verify.test.ts` 后**整个测试套件崩在加载阶段**
   （`Could not resolve "cloudflare:workers"`）。根因：`plans.ts` / `actions.ts` / `verify.ts`
   原先从 `TaskRunnerDO.ts` import `TaskStep` 与 `GAP`，而后者
   `import { DurableObject } from 'cloudflare:workers'` —— 那是 **Workers 运行时内置模块，Node 下不存在**。
   **修法（架构性，不是打补丁）**：把纯数据（`TaskStep` / `RunState` / `RunContext` / `GAP`）
   抽到新文件 `taskrunner/steps.ts`，依赖方向变成
   `steps.ts（纯数据）← plans/actions/verify/TaskRunnerDO` ⇒ **动作层不再依赖 DO**，
   单测也就不再需要 Workers 运行时（`TaskRunnerDO.ts` 保留 re-export，既有 import 路径不破坏）。
2. **`step` 变量名写错（类型检查抓到）**：`chat5` 的参数命名成 `_step`（表示未使用），
   但函数体里引用了 `step.delayMs`，类型检查直接报 `Cannot find name 'step'`。
   修的时候顺手纠正了一个概念错误：那段代码本意是「步内多条上报之间留间隔」，
   不该看 `step.delayMs`（那是**步间**间隔，由 DO 的 alarm 负责），改为固定 `REPORT_GAP_MS = 1050`。

**✅ 编排正确性（单测锁定的不变式）**：每个业务动作后**必须**跟一次 `verifyAndClaim`
（少了它 → 达标也不领奖，静默失败）；计划里**绝不**包含需要真实对话的任务；
所有 `delayMs ≥ 0`（负数会让 alarm 立即重排，形成忙循环）；计划引用的动作**必须**都已注册。
另有一条：**上报类动作间隔 ≥ 1000 ms** —— 防止有人为「跑快」把这些反风控间隔调小。

**⚠️ 当时留下的观察点**：线上 `Hp_Appearance` 的 `lastError` 是
`领奖失败（auth_error）：任务列表拉取失败（auth_error）：upstream 401` ——
这是**假 token 导致的**；但 `verifyAndClaim` 用 `findTask` 拉任务列表，
若某任务的领奖路径与列表路径口径不一致，可能出现「能做但查不到」。
已实现默认 + mp 口径合并，真实账号验证结果见 §9.12。

### 9.7 第 6 步：OpenAI 兼容聚合网关（✅ 完成）

**范围**：`gateway/payload.ts`、`stream.ts`、`server.ts`、`models.ts`、`http.ts`；
单测 **163/163**；体积 118.99 KiB / gzip 29.97 KiB，启动 1 ms。

**🔗 已接入账号池（不是裸代理）** —— 这是本步最重要的修正。
初版网关直接取「第一个可用账号」，问题很严重：一个号 429 或余额耗尽 → **整个服务立刻不可用**；
而且**不会恢复**（没有任何地方记录「这个号暂时别用」）；池里的冷却/熔断状态机**形同虚设**。
现在形成完整闭环：

```
pick(排除已试) → 转发 → 成功 → noteSuccess（清熔断/降权）
                      ↘ 失败 → applyFailure（按类别落到正确维度）+ 换号重试
```

**两条守住的纪律**：**`tried` 集合跨重试保留** —— 否则会在两个账号之间无限来回
（Go 侧 `account-pool.ts:905-914` 记录过这个缺陷）；**按错误类别罚正确的维度**。

**错误 → 惩罚维度映射**（`mapErrorToPunishment`，9 条单测锁定）：

| 上游错误 | 罚哪个维度 | 换号？ | 理由 |
|---|---|---|---|
| `rate_limited`（6004 细分） | 模型级 / 账号级 | ✅ | 6004 切模型即可用，**不该罚整个账号** |
| `model_unavailable`（11102） | 模型级 | ✅ | 是 (账号,模型) 维度 |
| `credit_exhausted`（402） | 硬冷却至次日 04:00 | ✅ | 换号有用 |
| `waf_blocked`（403 无信封） | 账号软冷却 | ❌ | **可能是 IP 级**，换号无用、只会放大请求 |
| `request_illegal`（11140） | 熔断 | ❌ | 强信号；同样非法请求换号也失败 |
| `session_dead`（12153） | 连续 3 次才禁用 | ✅ | 单次多为网络抖动 |
| `server`（5xx） | 熔断 | ✅ | |
| `auth_error`（401） | **不罚号** | ✅ | 续期凭据即可，不该惩罚账号 |
| `context_exceeded` / `image_invalid` | **不罚号** | ❌ | 是**请求**的问题，不是账号的问题 |
| `network` | **不罚号** | ❌ | 抖动量不构成「这个号坏了」的证据 |

**记账已线上验证**：跑一次成功对话后 `successCount` 从 0 变 **2**，`errTotal` / `fails` 保持 0。
> ⚠️ 为了让这一步**可验证**，把 `successCount` / `errTotal` / `lastSuccess` / `fails` /
> `modelCooldowns` 加进了 `/admin/accounts` 的返回。不暴露它们就无法确认记账有没有发生 ——
> 而**记账失效是静默的**（冷却/熔断形同虚设，但表面一切正常）。

**🏗️ 请求体准备（`payload.ts`，纯函数）—— 四处必须的改写（每处都对应一个真实失败）**：

| 改写 | 不做的后果 |
|---|---|
| `max_completion_tokens` → `max_tokens` | 上游只认旧字段 → 回落默认上限 → **长回答被截断**（无报错） |
| 强制 `stream: true` | 上游按流式处理，语义不符 |
| `tool_choice` 对象 → `'auto'` | **400 `code=11101`**（不说是哪个字段） |
| 补 `stream_options.include_usage` | 末帧没有 usage → 用量统计恒为 0 |

**外加工具配对清理**（Go 侧记录过的严重缺陷）：不完整的 `tool_calls` / `tool` 配对会让上游
**对之后每条消息都返 400** —— 整条会话报废。另剔除**名称为空的 tool_call**
（它会跨 provider 传染，报 `11133` 且不指出字段）。

**流式透传铁律**：绝不 `await response.text()` 上游响应。逐 chunk 解码 → 按行切 SSE 帧 → 转换 → enqueue。
用 `decoder.decode(value, { stream: true })` 处理**跨 chunk 的多字节字符**（不用 stream 选项会解码出乱码）；
正常帧**原样转发**（不 `JSON.parse` 再 `stringify`，省 CPU）；
**只在可能是错误帧时才解析**（先看字符串里有没有 `"error"` / `"code"` / `"statusCodeValue"` / `"stackTrace"`）。

**错误必须显式（不做静默失败）**：Go 侧记录过多个「**客户端看到干净地停止、无任何报错**」的缺陷，
全部源于解析器不认错误帧。故识别 **4 种**错误形态：

| 形态 | 例子 |
|---|---|
| OpenAI 标准 | `{error:{message,type}}` |
| 业务码 | `{code:6004, msg:'模型限流'}` |
| **网关形态**（最易漏） | `{stackTrace:[…], message, statusCodeValue:400}` — **既无 code 也无 error** |
| 非 JSON 数据帧 | `data: <html>…` |

另两条兜底：流结束但**从未产生任何内容** → 推错误帧（「疑似被截断」，而不是假装模型没话说）；
流中途异常 → 推错误帧再收尾（**绝不静默关闭**）。

**🐛 本步踩到并修复的缺陷**：

1. **模型目录路径搞错 → 静默返回空列表（本步最隐蔽的坑）**：`GET /v1/models` 返回
   **HTTP 200 但 `data: []`** —— 没有报错、没有异常、没有日志，表现为「这个账号看起来没有模型」。
   根因：从 global 域的企业端点家族抄的形状，误以为是 `data.data.models`。
   实测抓取 `/v3/config` 骨架，真实形状是 **`data.models[]`（单层，54 个）**，
   同级还有 `agents[]`、`productFeatures{}`、`config{}`。
   ⇒ 修法：**先试 `data.models`（CN 域真实形态），再回落 `data.data.models`**，
   并用**实测抓取的结构**加 3 条测试锁死，防回归。
2. **加密测试有 flakiness（测试写错，不是代码错）**：`篡改密文会被检测到` 间歇性失败。
   根因：原先翻转密文**最后**一个字符，但 base64 末字符若处于非 4 的倍数位置，
   **其低位是填充位、解码器会忽略** —— 翻转后解码出**完全相同的字节**，「篡改」根本没发生。
   实测：翻转**首字符**后解码必定改变（80640 次采样，0 次相同）。
   ⇒ 改为翻转首字符，并补一条「篡改 IV」用例，连跑 3 次全部通过。

**真实账号端到端实测（2026-10-03）**：

- **`GET /v1/models`** —— 从上游 `/v3/config` 拉到 **54 个真实模型**（`auto`/`fast-model`/
  `balanced-model`/`deep-model`/`hy3`… 等）。
- **流式对话** —— **22 帧 + `[DONE]` + `finish_reason: stop`**，
  `usage: {prompt_tokens:10, completion_tokens:19, total_tokens:29}`，正文真实回复。
- **工具调用** —— `tool_choice` 对象形式 + `tools` 数组：**零错误帧、`[DONE]`、
  `finish: tool_calls`、10 个 tool_calls 帧**。这条尤其关键：它证明 `tool_choice` 归一化
  在真实上游生效了 —— 若未归一化，上游会返 **400 `code=11101`**（且不说是哪个字段）。

**本步刻意的范围裁剪**：会话粘性（同一会话可能落不同账号 → 上游 prompt cache 未命中）、
`provider/model` 式命名空间（当时只有 WorkBuddy 一族）、图片入站（Free 计划 10ms CPU 下
base64 解码可能超限）、`/v1/embeddings`（上游无对应能力）、IP 级 WAF 护栏
（当时只有账号级软冷却，真遇到 IP 级拦截会轮转完所有号才停 —— 后来已补，见 §9.10）。

### 9.8 第 7 步：Web 管理面板（✅ 完成）

**范围**：`src/panel/index.ts`（路由 + 安全头）、`src/panel/assets/{index.html,style.css.txt,app.js.txt}`；
单测 **179/179**（其中面板 20 条）；体积 136.52 KiB / gzip 36.27 KiB。

**线上验证**：`/panel/` 200 + `text/html`（2,312 字节）；`/panel/style.css` 200 + `text/css`
（**2,975 字节**，真实样式）；`/panel/app.js` 200 + `application/javascript`（**10,611 字节**，真实代码）；
安全响应头（CSP / `X-Frame-Options: DENY` / `nosniff` / `no-referrer` / `no-store`）全部就位；
`/admin/*` 无密钥 → **401**（面板不泄漏数据）。

**当时的面板功能**：账号池（列表 + 状态标签 / 积分 / 冷却倒计时 / 成功与错误计数 / 模型冷却 + 删除）、
导入凭据、添加账号（设备码登录 + 自动轮询）、任务（选账号 + 选计划 → 自动轮询进度，渲染成
易读的逐步清单）、模型目录。

**🔒 安全设计（这部分比功能更重要）**：

1. **CSP 保持严格：不用 `unsafe-inline`**。取舍：把 JS 内联进 HTML 会迫使 CSP 放开
   `script-src 'unsafe-inline'`，那等于放弃 XSS 防护。Go 侧（`internal/panel/index.go:24-31`）
   记录了同样的取舍，本项目沿用：**脚本走独立文件**，CSP 保持 `script-src 'self'`。
   有单测**静态检查** HTML 里没有内联脚本、CSP 里没有 `unsafe-inline`。
2. **页面免鉴权，但数据接口必须鉴权**。页面**不含任何敏感信息**（不知道有哪些账号、也不知道 token），
   故可免鉴权加载；真正的数据全在 `/admin/*` 与 `/v1/*` 后面，**一律要 Bearer 密钥**。
3. **刻意不用 cookie**。cookie 会被浏览器**自动附带**，因此需要额外的 CSRF 防护（SameSite + token）；
   而 `Authorization` 头**不会被自动附带**，天然免疫 CSRF。密钥存 `localStorage`，每个请求显式带上。
   有单测静态检查前端没有 `document.cookie`、且密钥不出现在 URL query 里（后者会进日志与 Referer）。
4. **不把上游返回的 URL 拼进 innerHTML**。授权 URL 来自上游响应，拼进 `innerHTML` 就有注入风险。
   前端改用 `document.createElement` + `textContent` 构造。有单测静态检查。

**🐛 本步踩到并修复的两个真实渲染坑**：

1. **`.css` 被 Wrangler 当成 CSS module → 线上返回 `[object Object]`**：
   `/panel/style.css` 返回 **200 但只有 15 字节**，内容是 `[object Object]`，面板**完全没有样式**
   （但页面能打开，很容易被忽略）。根因：Wrangler 对 `.css` 有**内建**的模块处理
   （把它当 CSS module 对象而不是字符串），`import css from './style.css'` 拿到的是对象，
   直接塞进 `Response` 就被字符串化。**修法**：CSS 源文件改名 `style.css.txt`，
   只命中本项目的 Text 规则；服务时仍声明 `text/css`，浏览器侧无感。
   > 同类问题：`.js` 也一样（esbuild 有自己的 loader，报
   > `No matching export in "app.js" for import "default"`），故面板 JS 也是 `app.js.txt`。
2. **Text 规则必须标 `fallthrough: true`，否则与内建规则冲突**：构建失败，报
   `The file ./assets/index.html matched a module rule … but was ignored because a previous
   rule with the same type was not marked as 'fallthrough = true'`。
   根因：Wrangler **自带**一条 Text 规则覆盖 `**/*.html` / `**/*.txt` 等，
   另加的规则与它同类型却排在前面，把内建规则挡住了。
   **修法**：只声明真正需要的 glob（`*.js.txt` / `*.css.txt`）并标 `fallthrough: true`。
   **教训**：不要试图覆盖 Wrangler 的内建模块规则，而是**换个文件扩展名**绕开它。

**面板 20 条测试覆盖**：CSP 纪律（不含 `unsafe-inline`、`script-src 'self'`、`connect-src 'self'`、
`frame-ancestors 'none'`、`default-src 'none'`、`base-uri 'none'`）；6 个安全头齐全；
资源路由（带/不带尾斜杠都认）；**渲染正确性**（CSS 不得是 `[object Object]` 且长度 > 500、
JS 需 `application/javascript` 且长度 > 2000）；前端安全（不用 cookie、密钥不进 URL、
`authUrl` 不拼 `innerHTML`、HTML 无内联脚本）。

### 9.9 第 8 步：多供应商接入（✅ 完成）

**范围**：`src/providers/`（**约 14,500 行**）；单测 **383/383**（当步）；
体积 826.70 KiB / gzip 272.44 KiB（Free 计划上限 1 MiB）；**零 `node:` 导入** ——
全部纯 Web 标准（`fetch` / WebCrypto / `TransformStream`）。

**🏗️ 抽象层设计**：供应商差异**全部**收敛到 `Provider` 接口。网关只做
「选号 → 调接口 → 记账 → 换号」这件与供应商无关的事，**没有**一处 `if (provider === 'xxx')`。

**两个必须自己实现的密码学原语**（Workers 的 WebCrypto **只有** AES-CBC/GCM/CTR + SHA-1/SHA-256）：

| 原语 | 用在哪 | 为什么不能绕 |
|---|---|---|
| **MD5**（`md5.ts`） | raccoon 从 token 确定性派生 uid | `parseCredential` **必须同步**（接口签名如此），而 WebCrypto 的 SHA-256 是异步的；此处只需「确定性 + 单向」，不是安全边界。（算法源自 loomy 的 `Content-MD5`，但 loomy 已删除） |
| **AES-128-CFB**（`aes-cfb.ts`） | raccoon 的手机号加密 | CFB 是流模式（密文等长），**CBC 强制 PKCS#7 补位、CTR 反馈源不同**，都拼不出来 |

两者都与 Node/OpenSSL **逐字节对拍**过：MD5 用 RFC 1321 向量 + 填充边界（55/56/57/63/64/65）
+ UTF-8/代理对；AES-CFB 用 14 种长度 + 25 组随机 IV + **NIST SP 800-38A CFB128** + **FIPS-197**。

> 🔴 **移植时真踩到并修掉一个静默错误**：AES 密钥扩展第一列漏了「与上一轮同列异或」。
> 症状是**不抛异常、只是密文全错**，靠 FIPS-197 轮密钥向量抓出来。
> 若没做这层对拍，就会带着「能跑但全错」的加密上线（上游只回一个 `100003 params_encryted_error`）。

**qoder 的 298 KB WASM**：`qoder-auth-wasm.wasm` 用于生成 `Bearer COSY.<载荷>.<签名>`。
参考实现从磁盘 `readFileSync` 读它（Workers 没有文件系统）。**✅ 不需要任何配置**：
wrangler **内建** `CompiledWasm` 规则（`globs: ["**/*.wasm"]`），`import mod from './x.wasm'`
直接得到 `WebAssembly.Module`。已实测：产物 292 KB，`generate_runtime_auth_fields` 返回
`keyLen=172`，20 个签名头齐全。
> ⚠️ 单测用的 esbuild 给的不是 `Module`（它按 ESM 包装），故 `compileWasm()` 做了运行时归一化 ——
> 是 `Module` 就直接用，是字节就 `WebAssembly.instantiate` 编译。两种打包器都能跑。

**🐛 本步过程中修掉的 5 个真实缺陷**：

1. **⚠️ 模型名前缀泄漏到上游（放大器级，最严重）**：客户端发 `workbuddy/deepseek-v4-flash` 后，
   **连裸名 `deepseek-v4-flash` 也全部失败**，报「没有可用账号」。根因链（每一环单独看都不显眼）：
   ```
   ① prepareChatBody 复制整个 body（含 model）但**不改写 model** → 上游收到带前缀的名字
   ② 上游回 `model [workbuddy/deepseek-v4-flash] service info not found`
   ③ 该错误被归类为 `model_unavailable`（11102）
   ④ → 给这个模型写入 **6 小时**模型级冷却
   ⑤ → 此后**裸名**请求也因模型级冷却选不到号
   ⑥ → 对外表现为「没有可用账号」，与真实原因毫无关系
   ```
   **修法**：把 body 里的 `model` 换成去前缀的裸名（**必须在 `prepareChatBody` 之前**做）；
   并加 `POST /admin/cooldowns/clear` 人工解冻入口（模型级退避 6h 起步，修好代码后不该再等）。
   **教训**：**错误分类会放大输入错误** —— 一个纯粹由我方造成的失败，被归到「上游没有这个模型」
   这个语义上，就变成了对健康资源的长期拉黑。
2. **⚠️ 用量统计恒为 0（静默失败）**：对话成功，但 `/admin/usage` 永远是 0，**且没有任何错误日志**。
   根因：记账发生在**响应流结束之后**，而 Worker 在响应结束时会**取消所有未完成的 promise**；
   第一版写成 `.catch(() => {})`，于是被取消这件事连日志都没有。
   **修法**：把 `ExecutionContext` 传进网关，用 `ctx.waitUntil()` 托住记账。
   验证：`successCount` / 用量从 0 变 1（输入 7 / 输出 5 / 214 ms）。
3. **⚠️ minimax 静默无内容**：MiniMax 对话**没有任何报错**，但客户端一帧正文都读不到。
   根因：MiniMax 上游说 **Anthropic 协议**（`{"type":"content_block_delta",…}`，**没有 `choices`**），
   而网关的 `streamResponse` 对 OpenAI 帧是**零解析直通**（刻意如此：Free 计划 10ms CPU，不 parse 才省）。
   两者相遇 → Anthropic 帧被原样转发 → 标准 OpenAI 客户端按 `choices[0].delta.content` 取值
   → 读不到，且不报错。**修法**：在**供应商层**就地转换（出站流统一为 OpenAI SSE）。
   回归测试锁死：`withChoices > 0`、正文落在 `delta.content`、
   `thinking_delta` 进 `reasoning_content`（**不得污染正文**）。
4. **⚠️ 凭据被别家抢走（4 家都犯）**：`{accessToken, uid}` 被 **cline 抢走**，存成永远 401 的
   cline 账号，而用户以为导入的是 WorkBuddy。根因（两层）：**令牌形状无法区分** ——
   WorkBuddy、cline、minimax、zcode 的 access token **都是三段式 JWT**
   （实测 WorkBuddy 的就是标准 `eyJhbGciOiJSUzI1NiIsImtpZCI6…`，1500 字符）；
   **字段名重叠** —— cline 把 `uid`/`user_id` 当 `accountId` 的别名，而 DSH 形态的 WorkBuddy
   凭据恰好有 `user_id`。更糟的是有 4 家支持「直接粘贴令牌字符串」，且**无条件接受任何非空字符串**
   （实测 `parseCredentialAnywhere('str')` 被 minimax 收下）。
   **修法（两把闸门，都加在接口上）**：`bareStringPattern`（裸字符串必须**形状匹配**才收）；
   `matchesShape`（对象必须含**该供应商独有**的字段，如 cline 的 `workos:` 前缀或 `clineUserId`、
   opencode 的 `api_key`）。**默认供应商作为兜底总是参与**。
   验证：9 组输入全部落到正确的家（裸文本/null/数组 → `ProviderError`；
   workbuddy 对象 → workbuddy；cline（`workos:`/`clineUserId`）→ cline；
   minimax（`minimax_user_id`）→ minimax；zcode（`zcode_jwt`）→ zcode；opencode（`api_key`）→ opencode）。
5. **⚠️ 选号未按供应商过滤**：一个「有 cline 账号、没有 workbuddy 账号」的部署，
   会把 cline 的凭据拿去打 WorkBuddy 的端点 → 上游 401（看起来像「凭据坏了」，实际是选错了账号）。
   **修法**：`pick()` 支持 `provider` 字段。
   **⚠️ 修的时候踩了一个二阶坑**：第一版写法是「`pick()` 返回后再筛掉不是该家的」，
   那会让「池里有账号但当前供应商没账号」表现为**`pick()` 返回了号、调用方却拿不到人**
   → 被当成「没有可用账号」。⇒ 过滤**必须在 `pick()` 内部**做，不能在返回后筛。

**面板重做（3 → 7 个视图）**：修掉「没输密钥时页面一片空白」—— 显式区分三种状态
（未填密钥 / 密钥无效 / 正常），**无密钥时也渲染导航与引导卡片**。

| 视图 | 内容 |
|---|---|
| 供应商与账号 | 计数（总/可用/冷却/模型限流/禁用）+ 卡片（状态标签、冷却倒计时、成功/错误计数、积分徽标）+ 导入 + 登录 |
| 任务中心 | 一键签到（全部供应商）、Buddy 每日任务（含真实对话）、扫描全部账号待办 |
| 用量 | 总请求/成功/失败/token/平均耗时 + 按小时柱状图 + 按模型 + 按账号 |
| 积分包 | 逐账号实时查上游余额（**串行**，避免放大风控） |
| 模型 | 模型目录表格 + 按供应商开关模型 |
| 配置 | 运行时状态（池计数、WAF 窗口与阈值、凭据数、cron 时点） |
| 日志 | 请求日志（环形缓冲）+ 清空 |

**用量与日志的存储纪律**：**不逐条写行**，而是**整条环形缓冲存在一个 storage key** 里
（`usage:ring` 500 条 / `log:ring` 200 条）。理由：Free 计划 DO 行写入配额 **100,000/天**，
而一次对话就产生一条记录 —— 逐行写会在正常使用下撞配额。要的是**近期趋势**，不是审计账本。
> ⚠️ 截断必须**按时间排序后再截**：写入顺序 ≠ 时间顺序（并发请求完成有先后），
> 直接 `slice(-N)` 可能丢掉更新的记录而留下旧的。

**本步新增的安全约束**：CSP 保持严格（新增单测静态检查 HTML 无内联脚本、CSP 无 `unsafe-inline`）；
不用 cookie（密钥存 localStorage、每请求带 `Authorization` 头）；
不把上游 URL 拼进 `innerHTML`；**PKCE verifier 绝不回给前端**
（`/admin/providers/login/start` 只回 `{authUrl, state}`，verifier 存在 DO 里，已实测确认不泄漏）；
前端不出现 `innerHTML` 赋值（单测静态检查）。

### 9.10 第 8 步之后的实测修正（分步文档写就后发生，均已核实）

分步文档写完后仍有若干提交改变了结论，**以本节为准**：

1. **`loomy` 已整体删除**（提交 `9ac653f`）。分步文档与旧矩阵里的 11 家含 loomy，
   现在注册表是 **10 家厂商 / 11 个变体**（`src/providers/index.ts` 的 `PROVIDERS` 共 11 项）。
   `md5.ts` 保留（其算法源自 loomy 的 `Content-MD5`，但已无 loomy provider）。
2. **`/v1/models` 一律带 `provider/` 前缀**（提交 `00a09e6`）。早先为默认供应商额外暴露一份**裸名**，
   导致同一模型出现两次（`buddy/glm-5.3-flash` 与 `glm-5.3-flash`），而多家又有同名模型
   （`buddy/`、`codearts/`、`trae/` 都有 `deepseek-v4.1-flash`），裸名根本无从区分。
   **目录里一律带前缀，裸名 0 项**；**请求侧仍接受裸名**（回退默认供应商，`splitModelName` 未动）——
   兼容与无歧义分开处理。有测试锁定（`tests/panel.test.ts`：目录里不得出现裸名）。
3. **`/v1/models` 必须遍历两个 realm**（提交 `2e295ad`）。账号按 `extras.realm` 分片存放
   （国际版在 `global`），而原实现只看 `?realm=`（缺省 `cn`）⇒ 国际版**永远不会出现**，
   表现为「账号登录好了、别处也能用，但 `/v1/models` 里没有它」。且**每个账号要连它的 realm 一起记**
   （取凭据必须回到**同一个分片**的 DO stub）。
4. **codearts 与 trae 的登录：架构上不可行，已如实改回 `login: false`**
   （提交 `bcb140a` → `0a4fa3a` → `6ba627e` → `5ce02b7`）。曾尝试「浏览器回跳 + `auth_callback_url`
   指向本服务」，但实测：
   - **codearts**：登录跳转链在**服务端会死循环**（浏览器被反复送回登录页），
     且其回调**只认本机 `127.0.0.1` 端口** —— Worker 收不到；
   - **trae**：**强制**回调 `127.0.0.1`（本机端口）—— Worker 收不到。
   ⇒ 两家都只能**导入凭据**。这与旧文档「可以指向本服务 URL」的乐观判断相反，**以本节为准**。
5. **cline 设备码登录已接线**（提交 `12df087`，RFC 8628 风格 WorkOS **用户码**式：
   `/admin/providers/login/{start,poll}` 三步 + `/api/v1/auth/register`）。
   ⚠️ 轮询状态（`intervalMs` / `nextPollAt` / `deadline`）**必须持久化在登录会话载荷里** ——
   Workers 无跨请求内存，放模块变量会让 `slow_down` 的累积退避**静默失效**。
   同批修掉「每次请求白续一次期」。
6. **raccoon 登录已接线（微信扫码）**（提交 `bcb140a`）。目的是让本服务拥有自己的凭据 ——
   raccoon 的 `refresh_token` 是**一次性轮换**的，本地 DSH 客户端与本服务共用同一份凭据文件时，
   两边互相续期会把对方顶掉（用户报障「账号用一天就废」）。
7. **IP 级 WAF 护栏已实现**（提交 `2536c30`，§6.7 与 §2.6 对应的待办）。
   `AccountPoolDO` 内：60 秒窗口内 **2 个不同账号**接连命中 403 即判定 IP 级拦截，
   进入激活期后 `pick()` **直接放弃，连一个号都不试**（避免把一次请求放大 `MaxRotate` 倍去撞同一堵墙）。
   提供 `/admin/waf`（状态）与 `/admin/waf/clear`（人工解除），面板有 WAF 横幅。
   有 `tests/waf-realtime.test.ts` 覆盖。
8. **每日任务按钮包含真实对话任务**（提交 `0540ecf`）。`POST /admin/tasks/daily-all` 用
   `includeRealChat: true` 跑 `growth`（签到 → 全部成长任务 → 真实对话任务 → 自动领奖）——
   那些才真正**给积分**。**挂 cron 的自动计划仍然不含它们**，故用户不会被无感知扣配额；
   每次都是 `fast-model` 的极短对话，且**先查进度**，已达标就跳过。
9. **非流式请求返回 SSE 原文（已修，提交 `9ac653f`）**：网关**从不检查客户端要流式还是非流式**，
   一律把上游 SSE 转发回去；非流式客户端拿到 `data: {…}` 文本，`JSON.parse` 报
   `Expected EOF after parsing, but had : instead`（offset 5 正是 `data:` 的冒号）。
   ⇒ 新增 `aggregateSse()` 把 SSE 帧合并成一条 `chat.completion`；
   **工具调用分片必须按 index 合并 `arguments`**，否则客户端拿到截断的 JSON；
   `reasoning_content` 单独成字段，不混进正文。
   ⚠️ `stream` 缺省按 **OpenAI 规范是 false**（非流式）。
10. **续期逻辑曾形同虚设（8 家 provider 都受影响，已修）**：两个独立原因叠加 ——
    **架构不一致**（8 家 `chat()` 在非 200 时抛异常，只有 opencode 返回 Response，
    网关的 `!upstream.ok` 续期分支**永远走不到**，故 catch 分支也补上续期）；
    **判据只看状态码**（`401 || 403`，而 CodeArts 的 security_token 过期报的是
    **HTTP 400** + `APIG.0602`）⇒ 抽成公共 `isAuthLikeFailure(status, detail)`。
    实测恢复：Cline 401 → 正常对话；工具调用两种模式全通。
11. **国际版要求首条消息是 `system`**：`www.workbuddy.ai` 硬要求首条 `role:'system'`，
    否则报 400 + `11128`（**伪装成安全拦截**）。`VariantConfig.requiresSystemFirst` 只在**缺失**时
    补一条默认 system（客户端自己传了就尊重它，不覆盖用户的系统提示词）。

### 9.11 供应商能力矩阵（**10 家厂商 / 11 个变体**）

> **命名口径**（对齐参考项目 `deepseek-harness-codearts/src/product.ts:76` 的
> `id: 'buddy' | 'workbuddy'`）：
> - **`buddy`** = 腾讯**国内版**（`copilot.tencent.com` / `www.codebuddy.cn`）—— **默认供应商**
> - **`workbuddy`** = 腾讯**国际版**（`www.workbuddy.ai`）
>
> ⚠️ 本项目早期只有国内版，且当时的 id 就是 `workbuddy`。接入国际版后该 id 的含义变了，
> 故**必须做数据迁移**（`AccountPoolDO.migrateBuddyIds`，按凭据 `domain` 判据，惰性执行一次、幂等）——
> 否则既有国内账号会被当成国际账号，拿国内凭据打 `www.workbuddy.ai`，**必然 401** 且看不出真实原因。

| id | login | chat | checkin |
|---|---|---|---|
| `buddy`（腾讯国内版，**默认**） | ✓ | ✓ | ✓ |
| `workbuddy`（腾讯国际版） | ✓ | ✓ | ✕ |
| `cline` | ✓ | ✓ | ✕ |
| `minimax` | ✕ | ✓ | ✓ |
| `codearts` | ✕ | ✓ | ✓ |
| `lobsterai` | ✕ | ✓ | ✓ |
| `trae` | ✕ | ✓ | ✓ |
| `qoder` | ✓ | ✓ | ✓ |
| `opencode` | ✕ | ✓ | ✕ |
| `raccoon` | ✓ | ✓ | ✕ |
| `zcode` | ✓ | ✓ | ✕ |

**每个 `✕` 都有可操作的具体原因**（`/admin/providers` 返回 `loginBlockedReason` /
`checkinBlockedReason`），不用「不支持」这种无信息量文案（有单测强制原因 ≥10 字且可指导行动）：

- **codearts**：登录跳转链在服务端死循环，且回调只认本机 `127.0.0.1` 端口 —— 上游协议限制，
  只能从码道 IDE / 桌面端导出凭据后粘贴导入。
- **trae**：**强制**回调 `127.0.0.1`（本机端口），Worker 收不到 —— 上游协议限制，只能导入凭据。
- **lobsterai**：登录把授权回调打回本机 `127.0.0.1` 的临时端口，Workers 无法监听本地端口，
  也没有设备码轮询之类的替代流程；需在桌面客户端完成登录后导出凭据 JSON
  （含 `access_token` / `refresh_token` / `user_id` / `uuid` / `first_keyfrom` / `latest_keyfrom`，
  缺 `uuid` 与 `keyfrom` 会导致之后无法自动续期）。
- **minimax**：协议支持设备码，但本服务**未接线**发起流程；从已登录客户端导出 `access_token` 粘贴导入。
- **opencode**：**没有登录流程**（无 OAuth / 设备码）；到 opencode.ai 登录后复制 Zen 的 API key
  （形如 `sk-…`）粘贴导入；匿名免费通道需显式导入 `{"api_key":"public"}`。
- **zcode**：`login: true`（设备码可用），但**签到**接口始终要求阿里云验证码
  （需 headful Chromium，`--headless=new` 实测过不了风控）；**推理不受影响**。
- **raccoon**：**没有签到端点** —— 每日 300 积分由服务端**按日自动发放**
  （账单 `biz_type: 'daily_grant'`，实测注册后 1 分钟即到账）；有一次性登录奖励（3000 分，幂等），
  由 `grantLoginReward` 独立导出，不登记为 `dailyCheckin`。登录为**微信扫码**。
- **workbuddy（国际版）**：上游**本就没有**每日签到积分接口（积分在 CodeBuddy 侧领）——
  上游产品形态，不是本服务的缺失。
- **cline**：**没有每日签到端点**（对官方客户端做过端点扫描，无命中）；余额可在「积分包」页查看。

**登录方式并非都是标准设备码**（面板标签必须如实区分，否则会误导用户去找不存在的设备码）：
`codearts` / `trae` 曾是「浏览器回跳」式（现均为 `login:false`）；`raccoon` 是**微信扫码**；
`cline` 是**用户码**式（用户要先把一个短码抄进授权页）；
`buddy` / `workbuddy` / `qoder` / `zcode` 是标准设备码轮询。

### 9.12 真实账号端到端验证结果（2026-10-03）

用真实凭据实测，**全部成功**：

| 验证项 | 结果 |
|---|---|
| 凭据全链路（导入→加密→解密→出站） | ✅ |
| 任务自动化 `growth` 计划 | ✅ **23/23 步全部成功，零失败** |
| 其中 `first_buddy` | ✅ **真实领到 +300 积分 +8 能量** |
| 剩余未领任务 | 3 个，**恰好都是确实无法自动化的**（微信关注 / 真实对话 / mp 专家对话）—— 与 Go 项目声称的「17/18 可自动化」吻合 |
| `/v1/models` | ✅ 真实 **54 个模型**（现均带 `provider/` 前缀，且只列有账号的供应商） |
| 流式对话 | ✅ 真实回复，22 帧 + `[DONE]` + usage 完整 |
| 工具调用 | ✅ `finish: tool_calls`，10 个 tool_calls 帧，零错误 |
| 网关记账 | ✅ `successCount` 从 0 → 2（证明回写池状态） |

### 9.13 已实测发现的平台/协议约束（都必须记住）

1. **cron 配额只剩 1 条**（账户 Free 上限 5，被其他 Worker 占 4）
   ⇒ 用「1 条每小时 + Worker 内按 UTC+8 分发」（`src/index.ts` 的 `SCHEDULE_UTC8`，
   时点沿用 Go 侧默认：签到 9/21、活跃上报 10）。
   **代价**：任务时点粒度只能是整点。
2. **DO SQLite 的 `.one()` 在零行时抛异常**（不是返回 undefined）
   ⇒ 统一用 `firstRow()` 助手。**新增 SQL 查询不要直接用 `.one()`**。
3. **DO RPC 不支持泛型透传**（`Expected 0 type arguments`）
   ⇒ 跨 DO 方法返回 `unknown`，调用方在边界断言一次。
4. **DO 不能接收函数**（RPC 只传可结构化克隆的值）
   ⇒ 动作用「字符串名 + 注册表」，不注入执行器。
5. **`expiresAt` 单位**：Go 存**秒**，本项目用**毫秒**，导入时必须 ×1000（否则永远「需要续期」）。
6. **Wrangler 有内建的 `.css` / `.js` 模块规则**：面板资源必须用 `*.css.txt` / `*.js.txt` 绕开，
   自加的 Text 规则必须标 `fallthrough: true`（见 §9.8）。
7. **轮换型 refresh token**：`raccoon` 与 `codearts` 的 refresh token 是**单次使用**的，
   续期成功后旧的立刻作废（codearts 实测报 `STS5.1806 invalid refresh token: 'the refresh token has been used'`）。
   ⇒ 本地客户端与本服务**不能共用同一份凭据文件**，否则互相顶掉。

### 9.14 仍未消除的风险（诚实记录，优先级从高到低）

> ⚠️ 本节在 **2026-10-04 做过一轮「把没做的补上」**，已完成的项移到下方
> 「本节更新记录」；仍列在这里的是**确实还没做**的。

| 项 | 影响 | 状态 |
|---|---|---|
| **带真实凭据的高频请求是否会被 IP 级拦截** | 第 1 步只验证了**无凭据只读**请求；第 8 步的实测也以低频为主 | ⚠️ 未验证（护栏已实现，但触发条件本身未被真实命中过） |
| **opencode 每账号代理丢弃** | 参考实现靠「不同匿名槽配不同出口 IP」扩容免费额度；Workers 的 `fetch` 不接受 `dispatcher` ⇒ 多个匿名槽共享同一出口 IP，**额度不再能通过多开扩容** | ❌ 真实功能损失（平台限制，无法绕过） |
| **流内换号（trae / lobsterai）** | 需先消费整个 SSE 才能决定重发，与逐帧透传（10ms CPU 铁律）冲突 | ❌ 未实现（流内错误转成错误帧；换号由 HTTP 状态驱动） |
| **lobsterai 的登录发起** | 它的登录是 browser-redirect + 本机回调组合，**未接线** | ❌ 未接线（已如实声明 `login:false`） |
| **opencode 的登录发起** | **本就没有登录流程**（只能用 API key） | ✅ 无需接线（如实声明 `login:false`） |
| **codearts / trae 的登录** | 上游协议限制（codearts 服务端死循环；trae 强制 `127.0.0.1` 回调），**架构上不可行** | ❌ 已如实声明 `login:false`，只能导入凭据 |
| **连登兑换 / 抽奖 / 旅行未接入计划表** | — | ✅ **已修**，见下方更新记录 |
| **会话粘性** | — | ✅ **已修**，见下方更新记录 |
| **图片入站** | — | ✅ **实测可用**（见下），旧文档的「未实现」是过时信息 |

#### 本节更新记录（2026-10-06 四）：国内版是**另一套取值**（我上一轮只修了国际版）

**用户追问**：「国内版修了吗」—— 问得对。我上一轮把**国际版的值套到了国内版上**。

参考实现里两个产品是**完全不同的客户端形态**，不是同一个模板换段：

| 项 | 国内版 CodeBuddy（`id:'buddy'`） | 国际版 WorkBuddy |
|---|---|---|
| `userAgent` | **`CodeBuddyIDE/1.106.1`** | `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2` |
| `attributionName`（三个归属头共用） | **`CodeBuddy`** | `WorkBuddy` |
| `clientVersion` | **`1.106.1`** | `5.5.2` |
| `apiDomain` | `copilot.tencent.com` | `www.workbuddy.ai` |
| `productCode` | `codebuddy` | `workbuddy` |

⚠️ 国内版 UA **不是三段式、也不含 `WorkBuddy`** —— 它是 IDE 客户端形态
（`CodeBuddyIDE/1.106.1`，依据 `product.ts:309` / `buddy.ts:89`）。

**同时修掉一处自相矛盾**：国际版 UA 我一度写成
`WorkBuddy/5.5.6 … CLI/2.137.1`（混了国内版段），而 `X-IDE-Version` 是 `5.5.2`
—— **同一请求里两个版本号**，正是「渠道指纹」最容易露馅的地方。
参考实现逐字是三段同值：`WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2`。

**验证**：pi agent 测两个版本 —— 国内版与**国际版都正常返回**。

⚠️ **教训**：「两个变体」不等于「同一个模板换段」。改一个变体时必须
**逐个变体核对参考实现的取值**，不能假定另一个只是参数不同。

#### 本节更新记录（2026-10-06 三）：11128 的真正根因 —— 与参考实现逐行对比后定位

**用户报**：`502 channel_blocked: Illegal API invocation from an unapproved channel`
（国际版与国内版都报），并指出关键线索：

> 「我在 dsh 用 https://gitee.com/iJetLi/deepseek-harness-codearts 这个插件**几乎没失败过**」

**⇒ 同一批账号、同一上游，参考实现不失败而我们失败，差异只可能在请求构造上。**
把该仓库 clone 下来逐行对比后，找到**两个真正的根因**（都不是账号问题）。

##### 根因一：`role: 'developer'` 被原样转发（决定性）

用**本地日志代理**截获 pi（`pi-coding-agent`）发给我们的真实请求体：

```json
{"model":"workbuddy/deepseek-v4.1-flash",
 "messages":[{"role":"developer","content":"You are an expert coding assistant…"}, …]}
```

⚠️ pi 用的是 **`developer`** 角色（OpenAI **新**规范），而**上游只认**
`system` / `user` / `assistant` / `tool`。
我们原样转发 ⇒ 上游判定「**首条不是 system**」⇒ 回
`11128 unapproved channel`，并用 `displayMsg` **伪装成「安全策略拦截」**
（"The request was blocked by security policy"），极易误判成账号被封。

**参考实现的做法**（`src/message-shape.ts:99,125`）：**丢弃** `developer`
（理由：它只承载工具增删元数据 `tool-addition` / `tool-removal`，不是对话内容）。

⚠️ 但 pi 那条 **确实承载系统提示词** —— 直接丢弃会让模型失去行为约束。
故本项目**多做一步**：**有内容就降级为 `system`**，只有空内容（纯元数据）才丢弃。

同时修正 `withSystemFirst`（`buddy.ts`）：它原判据只认 `role === 'system'`，
遇到 `developer` 会**多补一条**「You are a helpful assistant.」并排在
**真正的提示词前面** —— 那会稀释甚至覆盖客户端自己的行为约束。
现在 `developer` 也视同「已有 system」，不补。

##### 根因二：chat 出站头的口径与参考实现不同

逐行对比 `buddy-adapter.ts:1950-1982` 与我们原先的头：

| 头 | 参考实现（不失败） | 我们原先（11128） |
|---|---|---|
| `Accept` | **`text/event-stream`** | `application/json, text/event-stream` |
| `X-Domain` | ✅ `www.workbuddy.ai` | ❌ 缺失 |
| `X-Product-Code` | ✅ `workbuddy` | ❌ 缺失 |
| `Origin` / `Referer` | ❌ 不发 | ✅ 发（**国内**域名打国际版端点） |
| `X-Requested-With` / `X-CodeBuddy-Request` | ❌ 不发 | ✅ 发 |
| `X-Machine-ID` / `X-Session-ID` | ❌ 不发 | ✅ 发 |
| `X-Conversation-Request-ID` 等 4 个 | ❌ 不发 | ✅ 发 |
| UA 中段 | `WorkBuddy **AI**`（国际版） | `WorkBuddy` |

参考实现只发 **11 个**头；我们那批多余的头来自 **Go 侧实现**
（`internal/upstream/headers.go`），而那套口径**在国际版端点上不被认可**。

**修法**：新增 `referenceChatHeaders()` —— 按参考实现**逐字对齐**只发那 11 个，
两条 chat 路径（gateway 的 buddy 路径 + provider 路径）统一使用它。
同时给 `cliChatHeaders` 补上按变体切换的 `X-Domain` / `X-Product-Code` / UA
（中段 ` AI` 只在国际版出现）、`X-IDE-Version`（国际版 `5.5.2`）。

##### 验证

- 直连 curl：国际版 **5/5 通过**（修复前 8/8 全 11128）；
- **pi agent**：国际版与国内版**都正常返回**（修复前两者都失败）。

##### ⚠️ 方法论教训

**「同一批账号，别人的实现能用」是最强的定位线索** ——
它把问题**排除在账号/上游之外**，直接指向请求构造。
我前面几轮一直在账号、冷却、CPU、IP 级 WAF 上打转，
**早就该去读那个"能用"的实现**。

#### 本节更新记录（2026-10-06 二）：我上一轮的修法引入的两个假故障

**用户报**（就在上一轮修复之后）：

```
503: 出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403）…稍后自动恢复
503: 供应商「workbuddy」的 1 个账号都在冷却中（因连续失败触发退避），约 30 分钟后自动恢复
「但两个明明都是正常的啊，有的软件好像可以，有的又不行」
```

**根因：我上一轮把 `11128` 归为 `waf_blocked`，而那会触发 IP 级判定。**

`waf_blocked` 在网关里是**双重身份**：既表示「账号软冷却」，又表示
「**可能是出口 IP 级拦截**」⇒ 会调用 `noteWaf()` 累加「IP 级命中」计数，
凑够 `WAF_IP_THRESHOLD = 2` 就**全局停服 60 秒**。

⚠️ 而 `11128` 与出口 IP **毫无关系** —— 它是**正常的业务码响应**
（`{"code":11128,"msg":"unapproved channel"}`），
不是 `waf_blocked` 所要求的「**HTTP 403 + 无业务信封**」形态。

⇒ 于是每次渠道拦截都被记成「IP 级 403 命中」，
用户有 **3 个账号**，极易凑够阈值 ⇒ **误报全局封锁**。

**这就是「有的软件能用、有的不行」的原因**：
差别在**请求指纹**，不在账号；而我们的错误处置把它变成了账号/IP 级的假故障。

### 修法：新增独立的 `channel_blocked` 类别

| 类别 | 形态 | 是否 IP 级 | 换号 | 罚账号 |
|---|---|---|---|---|
| `waf_blocked` | **HTTP 403 + 无业务信封** | ⚠️ 可能是 | ❌ | ✅ 软冷却 |
| `channel_blocked` | **业务码 11128**（正常响应） | ❌ **无关** | ❌ | ❌ **不罚** |

⚠️ **`channel_blocked` 连软冷却都不做**，理由：`11128` 有两种可能来源
（① 我们的指纹本身有问题 ⇒ **所有账号都会命中**，罚谁都没用；
② 上游对某账号风控升级 ⇒ 那才该罚）。
①是最可能的情形，而罚账号会**制造健康账号的假故障**（用户看到的「都在冷却中」）。

⇒ 正确处置：**如实把错误返回给客户端 + 不再轮转**
（换号无用，只会把同样的渠道判定打给更多账号）。

### 处置

部署后：清除被误累积的冷却（cn/global 各 0 条）+ **解除被误激活的 IP 级封锁**
（`/admin/waf/clear`，两个 realm 都清）。清后 4 个账号均
`fails=0 until=0 breakerUntil=0 disabled=false`，WAF 门 `active=false`。

**实测**：buddy 与 workbuddy 各打一次极短请求 ⇒ **均 200**。

### ⚠️ 教训

**同一个错误类别被两处语义复用时，改动它的归属会同时影响两处。**
我上一轮只想着「11128 不该熔断账号」，就把它塞进了 `waf_blocked`
—— 却没注意 `waf_blocked` 还挂着 **IP 级判定**这个副作用。
**改错误分类前，必须先查清该类别的所有下游消费点。**

#### 本节更新记录（2026-10-06）：11128 渠道拦截被误判为账号故障

**用户报**：「buddy 和 workbuddy 明明账号是好的，但就是用不了」，报错两类：

```
400: {"message":"所有账号均失败，最后一次：request_illegal: Illegal API invocation from an unapproved channel"}
400: {"message":"供应商「WorkBuddy（国际版）」请求失败：{"code":11128,
      "msg":"Illegal API invocation from an unapproved channel",
      "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}"}
```

**三个独立缺陷叠加**，共同造成「账号好的却用不了」：

**① `11128` 被归为 `request_illegal` ⇒ 罚账号（最严重）**

上游原文是 `Illegal API invocation from an **unapproved channel**` ——
这是**请求的渠道指纹不被认可**，与账号好坏**无关**。

但代码把它归成 `request_illegal`，而 `mapErrorToPunishment` 对它的处置是
`dimension: 'breaker'` ⇒ `fails++`，**3 次就熔断账号 30 分钟**。

⇒ **好账号被逐个熔断** —— 这正是用户看到的现象。
实测清除前的状态：两个 buddy 账号 `fails=1` / `fails=2`，**正在往熔断阈值累积**。

⚠️ 与真正该罚账号的 `11140` 的区别：`11140` 是「这个账号发了非法请求」；
`11128` 是「**这个请求的渠道**不被认可」。两者的处置必须不同。

**修法**：`11128 → waf_blocked`（渠道/风控层）⇒ **软冷却 + 不换号**
（换号撞的是同一套渠道判定，只会把风控放大到更多账号上）。

**② 流内错误一律按 `breaker` 记账**

`onError` 回调里拿到流内错误后，**原先一律** `kind: 'breaker'` ⇒ 同样熔断好号。
已改为 `punishmentForStreamError(message)`：文案含
`unapproved channel` / `security policy` / `11128` / `安全策略` ⇒ `soft`；其余仍是 `breaker`。

⚠️ 这里按**文案**判定而非 `kind`：流内错误在回调里只有一句字符串，没有结构化类别。

**③ 上游 400 被原样透传给客户端 ⇒ 伪装成「客户端请求有错」**

用户看到的 `Request failed: **400**` 是**上游的状态码被原样透传**。
而轮转完**所有**账号仍失败时，故障点在**我们与上游之间** ⇒ 正确语义是 **502**。

⚠️ 400 让客户端以为「是我请求写错了」，于是去改请求 —— 而真实原因是上游渠道判定。

**修法**：新增 `clientStatusFor(upstreamStatus, kind)`：
- 上游 5xx / 渠道拦截 / 限流 / 鉴权 ⇒ **502**；
- **例外**：`context_exceeded` / `image_invalid` 是**请求内容**的问题
  ⇒ 如实回 **400**（否则客户端会一直重试必然失败的请求）。

**④ 顺带修掉一个内部不一致：客户端版本号**

`headers.ts` 发 `5.5.4`（抄自 Go 侧**旧**默认值），而本仓库 `realtime.ts:222`
在**同一个端点**（`/v2/chat/completions`）上写的是 `5.5.6`，
且 AGENTS.md §6.1 记录的桌面端实测也是 `5.5.6`。

⚠️ 版本号是上游判定**渠道是否被认可**的输入之一（11128）。
已对齐为 `5.5.6` —— **只对齐到本仓库内已有依据的值，不编造更新的版本**。

### 处置

部署后**清除了被 11128 误累积的熔断计数**（`/admin/cooldowns/clear`，
cn 清 4 条、global 清 1 条）。清后 4 个账号均
`fails=0 breakerUntil=0 disabled=false`。

⚠️ 排查中观察到 `http=000`（连接层）现象 —— 但**对照实验**证明它是
**客户端本机网络抖动**：纯 Worker 的 `/healthz`（完全不碰上游）也出现同样现象，
而 cloudflare.com 5/5 正常。故与本服务无关，不要误判成服务故障。

#### 本节更新记录（2026-10-05 三）：ZCode 长回答被切断 —— 根因与两次误判

**用户报**：「思考 78 秒又断了」（ZCode 客户端）。

### ✅ 已确认修复的根因：会话粘性 key 碰撞（我引入的缺陷）

上一轮我加的会话粘性用**「首条消息指纹」**当 key，理由是「同一会话后续轮次首条不变」。
**这个推断是错的**：「首条消息相同」**不等于**「同一会话」——
任何两个用户发出相同 prompt（或同一用户重发）都会得到**同一个 key**，
于是这些**互相独立的请求**被当成一个会话，**全部粘到同一账号**；
并发时该账号被压垮，**上游把先前的流踢掉** ⇒「长回答中途突然停止」。

**决定性对照实验**：

| 场景 | 结果 |
|---|---|
| 3 个**相同 prompt** 并发 | **1 个被切断** |
| 3 个**不同 `user` 字段**并发 | **3/3 全部完整** |

**修法**：`deriveSessionKey` 只认客户端**显式**给的标识
（`user` 字段 / `conversation_id`）；都没有就返回空串 = **不做粘性**
（回落常规加权随机，自然摊到多个账号）。
⚠️ 「不粘」只是少了 prompt cache 命中率；而「错误地粘」会**弄断用户的流**——
两害相权必须选前者。

**同时补上「防惊群」**（`AccountPoolDO.pick` 的 `SPREAD_WINDOW_MS`）：
3 秒内刚被选中过的账号，下次选号**优先排除**（排除后一个不剩则回落全部候选）。
纯加权随机每次都独立掷骰，完全可能连中同一账号。
⚠️ 刻意**放在 `preferred` 之后**：显式声明会话的客户端优先保 prompt cache，不参与摊开。

### 🔴 两次误判（记录备查，避免重犯）

**误判一：把「CPU 超限」当成根因。**
我连续三轮优化帧净化（JSON 往返 → 正则 → 循环收敛 → 字面量），
每轮都以为找到了根因。**但 `wrangler tail` 抓到的实测指标是**：

```
wallTime=34536ms  cpuTime=1695  outcome=ok  exceptions=[]
```

⇒ Worker **正常结束**、**零异常**、CPU 远未触顶（1.7 秒 vs 各种限额）。
**「CPU 超限」这个假设从一开始就与证据矛盾**，我应该更早就去抓指标。

**误判二：反复优化一条**根本不触发**的代码路径。**

后来实测发现：**上游早已不再发那些非标准空值字段**。
44 万帧抓取里只有 **31 帧**含空值，全部来自 2026-10-05 上午，
**之后（含用户报障的时段）再没出现过**。

⇒ 我围绕「净化」做的全部优化，**对用户的实际场景一次都没走到**。

**⚠️ 教训（已写进 `dropEmptyFields` 的注释）**：
**先确认代码路径会不会被走到，再决定要不要优化它。**
顺序反了会烧掉大量时间与用户额度（我为此跑了三十多次真实长生成）。

### 现在的状态

- **帧净化路径**：定稿为「正确优先」。性能只保证**不退化成二次方**
  （测试断言 2 万帧/1 万帧 耗时比 < 4，而不是锁绝对耗时 ——
  给一条休眠路径定 SLA 没有意义）。真触发时说明上游又改了形状，按实测重做。
- **诊断日志**：`[stream] end reason=… frames=… ms=…` 与
  `[stream] aborted clientGone=…` 保留在生产代码里。
  这是「Worker 掐断」与「客户端断开」的**唯一分界** ——
  下次排查必须**先看这个日志**，不要再从代码猜。
- **仍有未解释的间歇性切断**：抓到过 `http=000`（连接层）与
  少数 `[DONE]=0` 的案例，但服务端日志对应的是 `reason=done`。
  ⚠️ **不是 Worker 的流处理逻辑**。下次出现时按上述日志定位。

#### 本节更新记录（2026-10-05 二）：长思考被切断 + 商汤模型列表

**① 🔴「思考超过 40 秒就突然停止，没有任何输出」—— 我前一天引入的 CPU 回归**

用户报：「buddy 和 workbuddy 的模型思考超过 40 秒就有可能突然停止，没有任何输出，
其它提供商没问题」。**复现成功**（`deep-model`，104 秒 / 3995 帧，结尾无 `[DONE]`）。

**根因是上一轮「帧净化」引入的**：`translateFrame` 对每帧做 `JSON.parse` + `stringify`。
实测（8000 帧）：**26.7ms CPU**，而 **Free 计划只有 10ms/次调用** ⇒ Worker 被强制终止。
（修复前原样转发只要 **0.25ms**。）

⚠️ 排查中被两个假象误导过，记下来：
- 先怀疑「帧数累积」，但 28 帧也断、2000 帧反而完整 —— **不是纯帧数**；
- 再怀疑上游断流，于是**直连上游**测：186 秒 / 8000 帧**完全正常**
  ⇒ 证明切断在**我们这边**。这一步是转折点。

**修法（两处）**：

| 问题 | 原写法 | 成本 | 改法 | 成本 |
|---|---|---|---|---|
| 判据太宽 | 见 `reasoning_content` 键名就解析 | 26.7ms | 只匹配**空值字面量** | **3.76ms** |
| 判据本身贵 | 7 次 `String.includes` | 19.1ms | **一条正则** | **2.4ms** |
| `usage` 探测 | `includes('"usage"')` 命中 `usage:null` | 18.3ms | `"usage":{`（只在有对象时解析） | **3.9ms** |
| 错误探测 | 4 次 `String.includes` | 13.4ms | **一条正则** | **5.0ms** |

⚠️ **`usage:null` 那条是原有代码的缺陷**（不是新引入的）：上游**每帧**都带
`"usage":null`，而判据只找 `"usage"` ⇒ 每帧都 `JSON.parse`。

**另一个必修点**：净化改用**字符串替换**（不再 JSON 往返）。踩到两个坑：
1. 一条正则同时匹配「前置逗号」与「后置逗号」时，删 `"refusal":"",` 会把逗号
   一起吃掉 —— 那本是**后面字段的前置锚点** ⇒ 产出非法 JSON；
2. 上面的残留形态**连收敛循环也救不了**（它前面既无逗号也无前导引号）。

⇒ 最终方案：**两条正则（先删后置逗号、再删前置逗号）+ 循环收敛**，
且前置那条要带 `(?=})` 分支（字段排在对象最末时，删完后 `}` 紧跟上来）。
已用 8 组边角用例验证（空值在首/末位、只有空值、正文含伪文本、真实内容不该动…）。

**② 商汤「又不行了」—— 模型列表与对话的选号策略不一致**

用户报：「商汤账号怎么又不行了，明明是用微信扫码登录的」。

**实测到的矛盾**：同一个账号，**chat 3/3 成功，模型列表 3/3 失败**
（报「refresh_token 已失效」）。这不可能单纯是凭据问题。

**根因**：`/admin/providers/models` 用 `accounts.find(...)` 取**第一个**该供应商账号，
而池里有 **2 个**商汤账号 —— **第一个恰好是坏号**（refresh_token 已失效），
于是整个目录请求失败。而 `chat` 走 `pick()`（会自动跳过坏号），用的正是**好号**。

⚠️ **缺陷形状值得记**：**同一份数据、两条路径、两种选号方式**。
这类缺陷表现为「对话正常但列表报登录过期」，极具误导性 ——
用户会以为整个账号废了。修一处不够，必须让两条路径的判据一致。

**修法**：模型目录改为**逐个候选账号尝试**，并跳过 `disabled` / 冷却中 / 熔断的账号
（判据与 `pick()` 的健康检查一致）。实测修复后正常拉到 **6 个模型**。

⚠️ 那个坏号的 `refresh_token` 确实是**终态失效**，需要用户**重新微信扫码登录**；
但它的存在**不该影响**好号拉取目录。

**③ 顺带修掉一个我自己引入的缺口**

改用字符串级净化后，`tool_calls` 里 `function.name` 的空串**不再被净化**
（原注释说「仍走对象层净化」，但 `translateFrame` 已经不调 `normalizeFrame` 了）。
已补上独立的两条正则 + 收敛循环，并加测试锁住
「首帧保留 name、后续帧删空 name、**arguments 增量必须保留**」。

#### 本节更新记录（2026-10-05）：严格客户端兼容（ZCode 等 agent 工具）

**背景**：用户把本服务接入 **ZCode 客户端**（一个 agent 工具）后报三个现象。
实测后确认其中**两个是真缺陷**，第三个是上游账号状态。

**① buddy 的 v4.1-flash「一直显示思考中，每次思考只有 1 个单词」**

根因：buddy 上游**每帧**都带一批**非标准字段**（即使是空值）：

```json
{"delta":{"role":"assistant","content":"","reasoning_content":"",
          "function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},
 "finish_reason":""}
```

两条都会让严格客户端误判：

1. `reasoning_content: ""` —— 客户端看到**字段存在**就认为「这是思考内容」，
   于是把每帧那一个字的 `content` 当成思考碎片显示 ⇒「一直思考，每次 1 个单词」；
2. **`finish_reason: ""`**（最隐蔽）—— 客户端普遍写
   `if (finish_reason !== null) 流结束`，而 `"" !== null` 为**真**
   ⇒ **每一帧**都被当成结束帧。规范里中间帧必须是 `null`。

修法：`translateFrame` 增加**帧净化**（`normalizeFrame`）——
空串/空数组/null 的非规范字段一律**删除**（不是保留空值），
`finish_reason: ""` → `null`。判据先做**廉价字符串预检**（`needsNormalize`），
只有含非规范字段时才付 `JSON.parse` 代价，保住 10ms CPU 纪律。

**② 工具调用的后续片段 `function.name` 是空串（agent 工具的关键缺陷）**

实测抓取的真实形状：

```jsonc
// 首帧：id / type / name 齐全
{"id":"call_00_bkAcI…","type":"function",
 "function":{"name":"get_weather","arguments":""},"index":0}
// 后续帧：name 是**空串**，只有 arguments 增量
{"function":{"name":"","arguments":"{"},"index":0}
```

OpenAI 规范要求后续片段**省略** `name`。严格客户端在累加片段时若用**赋值**
（`call.function.name = frag.function.name`）而不是「非空才覆盖」，
工具名会被空串**覆盖掉** → 调用失败，而报错完全不指向真正原因。
已加 `normalizeToolCalls` 删除空的 `name`/`arguments`。

⚠️ **不能因为 `name` 为空就丢弃整个片段** —— 那些片段承载 `arguments` 增量，
丢了参数就拼不完整。实测验证：净化后只有 1 帧带 `name`，
拼出的参数仍是完整的 `{"city": "北京"}`。

**③ workbuddy 国际版「一会能用一会不能用」**

根因：**同一条 429 有两种维度，而 provider 路径把它们混为一谈**。

上游 6004 的原话是：
> usage exceeds frequency limit … your usage will reset at 2026-10-05 14:47:23 UTC+8,
> **alternatively, you can switch to the other** models

「可以换用**其它模型**」= **模型级**限流。但 `handleProviderChat` 里硬编码
`429 → soft`（**账号级**冷却）⇒ 而 global 只有 **1 个** workbuddy 账号
⇒ 冷却期内**完全不可用**，真实情况却是「换个模型立刻就能用」。

⚠️ 这个缺陷的形状值得记：**buddy 路径早已有 `refineModelScoped` 细分，
provider 路径没有** —— 同一个 bug 只修了一半，而 report 走的是没修的那半。

修法：provider 路径复用同一判据；并新增 `parseResetAt` 解析上游给的重置时刻
（`reset at … UTC+8`），**按文案里的偏移换算**而不是用运行时本地时区
（Worker 跑在 UTC，直接 `new Date(str)` 会差 8 小时）。

**④ 不是缺陷的一项**：zcode 供应商的 405 `code 3012`「unusual activity」
是他的账号/IP 被上游风控，与请求形状无关（实测：去掉 `Authorization` 回 401，
带上任何 Authorization 都回 405；且官方身份块加不加都一样）。

⚠️ **一条操作纪律（我违反了，记录备查）**：zcode 的代码注释**明确警告**
「3012 有账号冷却惩罚（30 分钟；24h 内第 3 次起 24h；5 次停用）⇒
**不要为了调试反复触发**」，而我为了定位问题对上游打了十几次真请求。
**正确做法**：先读该供应商的错误分类注释，再决定探测策略 ——
对「有惩罚性风控」的上游，探测必须**极其吝啬**，优先靠代码与日志推理。

#### 本节更新记录（2026-10-04）

**1. 图片入站 —— 从来就是通的，旧文档写错了**

旧文档把它列为「❌ 未实现（Free 计划 10ms CPU 下 base64 解码可能超限）」，
并据此认为需要专门实现。**实测澄清：网关把请求体原样透传，图片本来就能用**：

| 实测项 | 结果 |
|---|---|
| 40 KB JPEG（640×480） | ✅ 正确识别（"橙色木板纹理背景"） |
| 1.9 MB JPEG（1600×1200） | ✅ 成功 |
| **6.6 MB JPEG（2400×1800）** | ✅ **成功**（prompt_tokens 正常） |
| PNG 格式 | ✅ 同样可用 |

⇒ **没有 10ms CPU 问题**，无需任何改动。旧结论的错因：
把「自己没有显式处理图片」当成了「不支持图片」——而**透传本身就是处理**。
⚠️ 一次早期测试用**合成渐变 PNG** 得到 `image_invalid`，那是上游的内容校验
（纯色/渐变被判定为无效图片），**不是格式或能力问题**。换真实内容即通过。

**2. 会话粘性 —— 已接线（DO 早有方法，网关一直没有调用点）**

- `AccountPoolDO.pick()` 新增 `preferred` 字段：把粘性账号**排到候选集最前**。
  ⚠️ 语义是「优先」不是「只要」—— 它不可用时**自然回落到**其余候选，
  不会因为「粘性的那个挂了」就报「没有可用账号」。
- 新增 `deriveSessionKey()`：优先用客户端的 `user` 字段，
  否则用**首条消息**的指纹。⚠️ 刻意**不**用「全部消息」的哈希 ——
  那样每加一轮消息 key 就变，粘性等于没有（每轮都当新会话）。
- 绑定在**首帧到达**时做（`ctx.waitUntil`），只**首轮**用粘性
  （换号后还粘回去会死循环）。
- 收益：同一会话固定落同一账号 ⇒ 从第二轮起**命中上游 prompt cache**（更快、更省）。

**3. 旅行 / 连登兑换 / 抽奖 —— 已接入计划表**

`upstream/travel.ts` 的函数早就齐了，但计划表里一直没有。现新增 3 个动作
（`travel` / `redeemStreak` / `lottery`）并放进 `DAILY_ACTIVITY_ACTIONS`：

- **单独一张表**，因为它们**没有 task code** ⇒ **不能**配 `verifyAndClaim`
  （那会去任务列表里找一个不存在的任务，白跑一轮 ~12 秒并留下假的「未达标」）。
- 排在**成长任务之前**：它们是**直接发积分**的，先拿确定性收益，
  万一后面超时/中断，用户至少已经拿到活动的积分。
- ⚠️ `travel` 动作内部**先领取、再出发** —— 顺序不能反（先出发会覆盖「可领取」状态，白丢奖励）。
- ⚠️ `redeemStreak` **逐档**兑换而不是取最高档：取最高档会在
  「高档已兑换、低档还没」时**漏掉低档**；且**单档失败不中断**其余档位。
- 实测（线上任务运行）：`checkin` ✅ / `redeemStreak` ✅「连登 2 天，没有待兑换的档位」/
  `lottery` ✅「没有可抽奖次数」/ `travel` 修正后不再报红色错误。
- ⚠️ **顺带修掉一个真缺陷**：上游对「没有可领奖励」回的是 `no unclaimed travel`，
  而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
  （`unclaimed` 不含 `not`、`travel` 不含 `arriv`）⇒ 被当成未知错误抛出，
  面板上那一步显示**红色 ERR**，而真实情况是**正常**。
  已抽成纯函数 `isNoUnclaimedTravel` / `isAlreadyDeparted` 并加单测
  （判据散在 async 函数里时只能做脆弱的源码正则断言，那种测试锁不住行为）。

**4. minimax 设备码登录 —— 已接线**

- 新增 `startMinimaxLogin` / `pollMinimaxLoginOnce`（PKCE S256 + 设备码轮询）。
- 路由接进 `/admin/providers/login/{start,poll}`，`capabilities.login` 改为 `true`。
- 实测：返回 `userCode: GQX2-78DE` + `https://account.minimax.cn/oauth-authorize`。
- ⚠️ 三处判据与 cline **不同**，写错会得到「用户还没来得及点授权就报失败」：
  1. `pending` 是 **HTTP 200 + status**，而标准 OAuth 是**非 200 + error** —— **两种都要认**；
  2. PKCE 是 **S256**（`crypto.subtle`，无需 `node:crypto`）；
  3. `slow_down` 退避是 **+5 秒**（cline 是 +1），且**累积**。
- ⚠️ 账号域是 `account.minimax.cn`、业务域是 `agent.minimax.cn`，**不可混用**。
- ⚠️ 轮询是**每请求一次**（面板每 3 秒发独立请求）：
  `intervalSec` / `nextPollAt` / `deadline` / `deviceCode` / `codeVerifier`
  **全部持久化在会话载荷**里 —— Workers 无跨请求内存。

**5. ⚠️ 一个高代价的排查教训：`routes` 里的脱敏占位符会让部署失败**

本仓库是公开的，真实域名被替换成 `<你的域名>` / `<你的 zone>`。
但 `wrangler deploy` 会拿 `routes` 的 pattern 去 CF **查 zone** ⇒ 查不到 ⇒ 报：

```
Error Occurred: Unable to fetch bindings, routes, or services metadata
from the dashboard. Please try again later.
```

⚠️ **该报错极具误导性**：它说「稍后重试」，但重试一百次都一样 ——
真实原因是**配置里的域名是占位符**。我在这上面浪费了 5 轮部署。

**修法**：`routes` 默认**注释掉**。自定义域只需在 CF 上**绑一次**
（网页端或 `PUT /workers/domains`），**部署脚本不需要每次带 routes**。

⚠️ 另一个同型教训：Worker 名与线上不一致时，报错是
`Durable Object namespace name 'xxx_AccountPoolDO' already in use [code: 10065]`
—— 那个报错**与 DO 重名毫无关系**，只是「worker 名对不上」的副产物。
排查时别往 DO 配置上找。

### 9.15 面板 UI 修复（2026-10-05 线上实测后）

> ⚠️ **本节修正 §9.8 的一处结论**：§9.8 记录了面板「已上线、功能可用」，
> 但那只验证了**资源可达与安全头**，**没有在浏览器里走一遍登录流程**。
> 实际上从提交 `cd7fd08` 起，面板在登录后就是**一片空白**（见下 P0），
> 一直没有任何测试覆盖到「登录成功后会发生什么」。
>
> **教训**：静态检查（HTTP 200 / content-type / 安全头 / 单测里的字符串断言）
> 全绿，**不等于页面能用**。凡是「用户要在浏览器里点」的流程，必须真的点一遍。

| 级别 | 缺陷 | 根因 |
|---|---|---|
| **P0** | **登录成功后整个面板空白**（桌面与手机都是） | `bootstrap()` 里 `$('setup-hint').hidden = true` 引用的元素已在 cd7fd08 从 index.html 删掉 → 赋值抛 `TypeError`，且恰好在 `setAuth()` / `switchView()` **之前** → 启动流程整个中断，**不报任何错** |
| P1 | 顶栏主题按钮图标不显示（空框），按钮缩成 **20×10px** | `THEME_ICON` 的 SVG 串缺 `xmlns`；`image/svg+xml` 是 **XML** 解析，**不像 HTML 解析那样隐式补 SVG 命名空间** → 根元素是 `namespaceURI: null` 的普通 Element → 渲染成 0×0 |
| P1 | 表格的横向滚动**从未生效**，手机上列被压扁 | 全局 `table { width: 100% }` 让表格永不溢出，`.table-wrap` 的 `overflow-x` 空转 —— 表格不是滚动而是**被压缩**：五列明细表表头被挤成竖排单字（「类/型」），`codearts` 断成 `codea/rts` |
| P2 | 手机上 5 个计数块纵排占 344px，首个供应商卡片被推到 578px | 单列规则挂在 `max-width: 420px`，而 420 覆盖 375/390/393/402/412（实测每行几个：375/390/412→1，仅 430+ 为 2），注释写的却是「极窄屏（老机型/分屏）」 |
| P2 | 积分包页显示 **「可用 undefined」** | 后端对「不支持查余额」回 `{skipped:true, reason}`（既无 `error` 也无 `total`），前端只判 `a.error` → 落到 else 分支把 `undefined` 拼进字符串 |
| P2 | 错误文案被切掉尾巴（`Unauthorized: Please make sure you're`） | `a.error.slice(0, 60)` 硬截断，无省略号、无 `title` |
| P3 | 空的 `.out` 画出 22px 空边框；柱状图时间标签折行；登录卡片顶到屏幕边缘 | 见 `style.css.txt` 对应注释 |

**🔑 两条新增的不变式测试**（这两条是本轮最有价值的产出，其余都是具体修复）：

1. **`$(id)` 引用的每个 id 都必须存在于面板 HTML**
   （`tests/panel.test.ts`）。P0 与「`loadAccounts` 里的 `$('accounts')`」
   是**同一类悬空引用** —— 删了元素没删引用，`$()` 返回 `null`，
   后续操作抛错。这类缺陷**不会自己暴露**（不报错只是不生效），
   只能靠静态不变式拦住。
   > 顺带发现：`loadAccounts` 里的 `$('accounts')` 已被同视图的
   > `loadTaskUids()` 掩盖成**静默失效** —— 任务中心看着正常，但该函数
   > 后续逻辑一行都没执行，而导入 / 登录 / 删除后共 7 个调用点全在空转。

2. **`.table-wrap > table { width: max-content; min-width: 100% }` 必须配
   `main > * { min-width: 0 }`**。只改前者会**反而引入全页横向溢出**：
   `main` 是 `display: grid`，网格项默认 `min-width: auto`（不小于内容最小宽度），
   表格按 max-content 取宽后网格轨道被撑开 —— 实测 390px 视口下
   `docScrollW` 422 > 375。这与既有的 `.count { min-width: 0 }`
   是同一类陷阱（flex/grid 项默认不收缩）。

**验证方式**：单测 406 → **417**；`typecheck` 与 `deploy --dry-run` 通过；
因沙箱内 `wrangler dev` 起不来（workerd tcmalloc `MmapAligned` OOM），
改用「本地静态服务 + 假 API」在真实浏览器 / 手机视口
（320/360/375/390/412/430）逐视图验证，再部署后线上复测。

**⚠️ 部署踩到的环境坑**：`wrangler deploy` 报
`auth token has expired and could not be refreshed because the Cloudflare
auth server could not be reached`。**不是登录失效**（凭据未变），而是
本机 IPv6 不通、而 Node 默认优先 IPv6 去连 `dash.cloudflare.com`
（`UND_ERR_CONNECT_TIMEOUT`；同一时刻 `curl` 走 IPv4 是通的）。
**修法**：`NODE_OPTIONS=--dns-result-order=ipv4first npx wrangler deploy`。

### 9.16 项目结构（最终）

```
src/
├── index.ts              Worker 入口：路由 + 鉴权 + Cron 扇出
├── env.ts                Bindings 与「禁止 parseInt(x) || 默认值」的解析助手
├── gateway/              ① OpenAI 兼容网关
│   ├── server.ts         选号 → 转发 → 记账 → 失败换号（流式透传 + 非流式聚合）
│   ├── payload.ts        请求体准备（4 处必改 + 工具配对清理）
│   ├── stream.ts         SSE 帧解析与转换（4 种错误形态识别）
│   ├── models.ts         模型目录（data.models 单层 + 双层兼容）
│   └── http.ts           JSON 响应助手
├── pool/                 ② 账号池（AccountPoolDO + 四维正交状态机 + IP 级 WAF 护栏）
├── taskrunner/           ③ 任务引擎（TaskRunnerDO + 11 个零消耗动作 + 5 个真实对话动作 + 领奖闭环）
├── upstream/             ④ 上游协议层（四套指纹 / 错误分类 / 登录 / 导入 / 旅行）
├── panel/                ⑤ 管理面板（7 视图 + 严格 CSP + 安全头）
├── providers/            ⑥ **多供应商抽象层（10 家厂商 / 11 变体，约 14.5k 行）**
│   ├── types.ts          Provider 接口 + 能力声明 + 判别式
│   ├── index.ts          注册表 + 自动识别（含顺序纪律）
│   ├── anthropic.ts      Anthropic ↔ OpenAI 转换（共享层）
│   ├── md5.ts            纯 TS MD5（WebCrypto 没有）
│   ├── aes-cfb.ts        纯 TS AES-128-CFB（WebCrypto 没有）
│   ├── buddy.ts          ★ 参考实现（**一套工厂产出 buddy/workbuddy 两个变体**）
│   └── qoder-auth-wasm.wasm  （wrangler 内建 CompiledWasm 规则）
└── store/                ⑦ 存储（DO SQLite + AES-GCM 凭据加密 + 用量/日志环形缓冲）
```

---

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
