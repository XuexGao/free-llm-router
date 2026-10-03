# 第 5 步：任务引擎动作（已完成）

> 对应 `../AGENTS.md` §9 第 5 步。本文件记录动作清单、领奖闭环、编排验证与踩到的坑。

## ✅ 结论：11 个零对话消耗动作 + 领奖闭环已实现并线上验证编排

| 项 | 值 |
|---|---|
| 新增模块 | `taskrunner/verify.ts`、`taskrunner/steps.ts`、扩展 `actions.ts` / `plans.ts` |
| 单测 | **111/111 通过** |
| 类型检查 | 通过 |
| 线上验证 | `growth` 计划入队 **23 步**，全部按序执行完毕 |

### 线上实测（用假 token 跑，验证编排与错误分层）

```
finished: True | 队列剩: 0 | 已完成: 23
  1. _probe        listTasks        ok=False   ← 401（假 token）
  2. chat_5        chat5            ok=False
  3. chat_5        verifyAndClaim   ok=False
  4. first_buddy   firstBuddy       ok=False
  5. first_buddy   verifyAndClaim   ok=False
  6. RichMeow_Chat richMeow         ok=True    ← 事件上报成功（/v2/report 200）
  7. RichMeow_Chat verifyAndClaim   ok=False   ← 回读需鉴权 → 401
  8. Buddy_App     buddyApp         ok=True
  ... 共 23 步
```

**这个结果恰好验证了分层是正确的**：
- 事件上报端点（`/v2/report`）**不严格校验 token**，故 `ok=True`；
- 回读/领奖端点**需要有效 token**，故 401 —— 换成真 token 即可工作。

---

## 📋 已实现的 11 个零对话消耗动作

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

**明确不做**（`NEEDS_REAL_CHAT`，会消耗配额）：
`Model_chat_GLM5.2`、`expert_5`、`Expert_team_use_3`、`skill_1`、`Expert_lighthouse`、`black_cat`
—— 有单测核对这个集合与 `AGENTS.md` §6.4 一致。

---

## 🔑 领奖闭环：为什么必须「回读 → 有界轮询 → 领奖」

**上游计分是异步的**（Go 侧实测：上报后立即回读仍是 0/1，**约 5–8 秒后**才变 1/1）。

⇒ 只读一次会误判「未达标」→ **跳过领奖** → 任务做了但积分永远拿不到，**且没有任何报错**。

故实现为固定预算轮询（沿用 Go 侧实测值）：

```
claimPollAttempts = 4 次
claimPollGap      = 3 秒
总预算            ≈ 12 秒
```

**为什么必须有界**：不能用 `while(!done)` 无限等 —— 上游若永久不达标，
会无限占用 DO alarm 并白烧 Free 计划的 Duration 配额。

**为什么轮询期间的查询失败不覆盖已有结果**（Go 侧 `autotask.go:260` 同口径）：
中途失败若覆盖了先前的成功结果，会把「已达标」误判成「未知」。

单测锁定：轮询次数 > 1（不能只读一次）、≤ 10（必须有界）、总预算在 6–30 秒区间。

---

## 🐛 本步踩到并修复的两个问题

### 1. 单测把 DO 代码拽进来，导致 Node 无法加载

**现象**：加了 `verify.test.ts` 后，**整个测试套件崩在加载阶段**：

```
[ERROR] Could not resolve "cloudflare:workers"
[ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with scheme file, data, node are supported
```

**根因**：`plans.ts` / `actions.ts` / `verify.ts` 原先从 `TaskRunnerDO.ts` import
`TaskStep` 与 `GAP`，而后者 `import { DurableObject } from 'cloudflare:workers'`
—— 那是 **Workers 运行时内置模块，Node 下不存在**。

**修法（架构性，不是打补丁）**：把纯数据（`TaskStep` / `RunState` / `RunContext` / `GAP`）
抽到新文件 `taskrunner/steps.ts`，依赖方向变成：

```
steps.ts（纯数据）  ←  plans.ts / actions.ts / verify.ts
                   ←  TaskRunnerDO.ts
```

**动作层不再依赖 DO**，单测也就不再需要 Workers 运行时。

> 顺带：`TaskRunnerDO.ts` 保留 re-export，既有 import 路径不破坏。

### 2. `step` 变量名写错（类型检查抓到）

`chat5` 的参数命名成 `_step`（表示未使用），但函数体里引用了 `step.delayMs`。
类型检查直接报 `Cannot find name 'step'`。

**修的时候顺手纠正了一个概念错误**：那段代码本意是「步内多条上报之间留间隔」，
不该看 `step.delayMs`（那是**步间**间隔，由 DO 的 alarm 负责）。
改为固定使用 `REPORT_GAP_MS = 1050`。

---

## ✅ 编排正确性（单测锁定）

`plans.growth` 的编排有 4 条不变式，全部有单测：

| 不变式 | 为什么重要 |
|---|---|
| 每个业务动作后**必须**跟一次 `verifyAndClaim` | 少了它 → 达标也不领奖（静默失败） |
| 计划里**绝不**包含需要真实对话的任务 | 会真的消耗配额 |
| 所有 `delayMs ≥ 0` | 负数会让 alarm 立即重排，形成忙循环 |
| 计划引用的动作**必须**都已注册 | 否则运行时才报「未注册的动作」 |

另有一条：**上报类动作间隔 ≥ 1000ms** —— 防止有人为「跑快」把这些反风控间隔调小。

---

## ⚠️ 仍有例外：`Hp_Appearance` 的领奖失败

线上 `lastError` 是：

```
Hp_Appearance 领奖失败（auth_error）：任务列表拉取失败（auth_error）：upstream 401
```

这是**假 token 导致的**（真 token 下应正常）。但**留一个观察点**：
`verifyAndClaim` 会用 `findTask` 拉任务列表，如果某任务的领奖路径与列表路径口径不一致
（如 mp 任务只在 mp 口径下发），可能出现「能做但查不到」。已实现默认+mp 口径合并，
但需要**真实账号验证一次**。

---

## 复现

```bash
npm run typecheck
npm test              # 111 条单测
npm run deploy

# 导入一个真实凭据后跑 growth 计划
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/tasks/start" \
  -H 'content-type: application/json' -d '{"uid":"...","realm":"cn","plan":"growth"}'
# 预期：queued=23

curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/tasks/status?uid=..."
# 预期：23 步逐条出现在 done[] 里
```

---

## 下一步（第 6 步）

OpenAI 兼容聚合网关：

- `GET /v1/models` —— 模型目录（上游 `/v3/config` + 企业端点并集）；
- `POST /v1/chat/completions` —— **流式 SSE 透传**。

⚠️ 关键纪律（`AGENTS.md` §8.2.2 第 3 条）：**必须流式，禁止整包缓冲** ——
Free 计划只有 10ms CPU，`await response.json()` 式整包解析会超限。
⚠️ 上游是 `/v2/chat/completions`（注意不是 `/v1`），且需在出站头里带会话头族。
