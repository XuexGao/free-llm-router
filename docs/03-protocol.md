# 第 3 步：上游协议层（已完成）

> 对应 `../AGENTS.md` §9 第 3 步。本文件记录实现范围、实测验证结果与踩到的坑。

## ✅ 结论：协议层已实现并部署，78 条单测通过

| 项 | 值 |
|---|---|
| 新增模块 | `upstream/events.ts`、`auth.ts`、`tasks.ts`、`checkin.ts`、`travel.ts`、`report.ts`、`store/crypto.ts` |
| 单测 | **78/78 通过**（`npm test`） |
| 类型检查 | 通过（`npm run typecheck`） |
| 部署 | ✅ `https://workbuddy-gateway.xiegao.workers.dev` |

### 线上实测验证

| 端点 | 行为 | 结果 |
|---|---|---|
| `POST /admin/login/start` | 返回 `state` + `authUrl` + 5 分钟有效期 | ✅ 实测拿到真实 `copilot.tencent.com/login?platform=CLI&state=...` |
| `GET /admin/login/poll`（未授权） | `{done:false}`，**HTTP 200**（不是错误） | ✅ |
| `GET /admin/login/poll`（未知 state） | **HTTP 404** + 明确提示重新发起 | ✅ |
| `GET /admin/credentials` | 返回持有凭据的 uid 列表（**不回 token**） | ✅ `count: 0` |
| `POST /admin/tasks/start`（无凭据） | 明确报「没有凭据，请先登录」 | ✅ |

## 🔴 凭据加密已落地（不再明文）

Go 侧把 token **明文**写进 `auths/*.json`（其 README 自承这是已知弱点）。
本项目**不继承**这一点：

- **AES-GCM** 加密后落 DO SQLite，每次加密用**新 IV**
  （GCM 下 IV 重用是灾难性的：会同时泄漏明文异或值并允许伪造认证标签）；
- 密钥来自 Worker secret `CREDENTIAL_KEY`；
- **未配置密钥时抛错拒绝写入**（fail-closed），不静默降级明文
  —— 静默降级是最糟的选择，用户会以为「已经加密了」；
- 篡改密文会因认证标签校验失败而抛错，**不返回垃圾明文**。

12 条加密单测锁定这些性质（含「明文不出现在密文里」「两次加密 IV 不同」「换密钥无法解密」「篡改被检测」）。

## 🐛 单测发现的两个真实缺陷

### 1. `parseTasks` 把脏数据变成空任务

**现象**：上游返回 `tasks: [null]` 或 `tasks: [{}]` 时，产出
`{taskCode:'', title:'', ...}` 这样的**空任务对象**。

**为什么危险**：空任务会进入执行队列 —— 它无法 accept、无法领奖，
只会污染 `lastError` 并白打上游请求。

**修法**：`taskCode` 是唯一标识，**缺它就丢弃该条目**（而不是补默认值）。

### 2. 我的测试断言了错误的字段名（测试错，不是代码错）

**现象**：断言 `chat_request_send.parentConversationId` → 通过；
断言同事件上还有 `conversationId` → 失败。

**排查**：回查 Go 侧 `desktop.go` 的事件构造，确认
`chat_request_send` **只有 `parentConversationId`，没有 `conversationId`**；
而 `chat_message_response` 两个都有。

**结论**：**代码是对的，测试是错的**。已修正测试，并把「哪些事件有哪些会话键」
显式钉住 —— 因为**字段名写错不会报错**，只会让服务端 join 不上、任务静默不点亮。

## 📌 实现中固化的关键协议事实

| 事实 | 位置 | 为什么重要 |
|---|---|---|
| 领奖走 `{web}/activity/growth/tasks/<code>/claim`（码在路径、无 body、带 `x-client-platform: web`） | `tasks.ts` | Go 侧曾误用 chat 域 `/v2/.../reward/claim`（码放 body），该路径**不存在**，恒返 400 并长期误诊为「任务没做完」 |
| mp 领奖 chat 域 400 时**降级 web 域** | `tasks.ts:claimRewardMp` | 实测 web 域可领，只试一个域名会失败 |
| 余额取 `CycleCapacityRemain`（本周期），不是 `CapacityRemain`（终身） | `checkin.ts` | 同一响应里两者差异巨大（655 vs 155.67），取错会高估余额 |
| 签到状态用 `checkin-activity-status`，**不是** `checkin-status` | `checkin.ts` | 后者返回占位数据，会误判「活动未开启」而放弃签到 |
| 桌面事件链 6 个，`chat_message_response.isSuccessful` 必须是 `true` | `events.ts` | 只发前半段或 `isSuccessful:false` 点不亮 |
| 裸数字 `11128` 必须改写（`11-128`） | `report.ts` | 它出现在请求里**本身就是拦截条件**，不改写必然失败；零宽空格无效（上游会归一化） |
| uid 只放行 `[A-Za-z0-9_-]` 且 ≤64 | `auth.ts:isValidUid` | uid 来自上游且用作 storage key，是安全边界 |
| `expiresIn` 缺省**不编造**过期时间 | `auth.ts` | 编造会让续期逻辑误判「还有一小时」，然后打到 401 |

## ⚠️ 刻意的范围裁剪（AGENTS.md §3.2）

- **不做真实对话类任务**：`actions.ts` 的 `NEEDS_REAL_CHAT` 显式拒绝 6 个需要真实
  对话的任务（会消耗配额）。这是**显式行为**而非静默跳过。
- **不做 zcode 类需浏览器产 captcha 的能力**。
- **不做积分保底分层选号**：1–3 账号时收益低于复杂度。

## 当前能力边界（诚实说明）

**登录流程可用，但还没有真实账号跑通完整签到。** 原因：
1. 需要你在浏览器完成一次授权（`/admin/login/start` 拿到的 URL）；
2. 授权完成后 `/admin/login/poll` 会拿凭据并加密落盘；
3. 之后 `/admin/tasks/start` 才能真正执行签到。

**下一步（第 4 步）要做的**：账号导入（兼容 Go 的 `auths/*.json` 双形态），
让你不必重新登录就能把现有账号迁进来。

## 复现

```bash
npm run typecheck   # 类型检查
npm test            # 78 条单测
npm run deploy      # 部署

# 线上验证登录流程
KEY=$(cat /tmp/wb_api_key.txt)
BASE=https://workbuddy-gateway.xiegao.workers.dev
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/login/start" \
  -H 'content-type: application/json' -d '{"realm":"cn"}'
# → 拿到 authUrl，在浏览器打开授权，再轮询：
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/login/poll?state=<state>"
```
