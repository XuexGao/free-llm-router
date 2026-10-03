# 第 4 步：账号接入（已完成）

> 对应 `../AGENTS.md` §9 第 4 步。本文件记录导入格式兼容、凭据全链路验证与安全约束。

## ✅ 结论：两条接入路径都打通

| 路径 | 端点 | 状态 |
|---|---|---|
| **设备码登录**（第 3 步实现） | `POST /admin/login/start` → `GET /admin/login/poll` | ✅ 线上实测可用 |
| **凭据导入**（本步实现） | `POST /admin/import` | ✅ 线上实测可用 |
| **删除账号**（本步新增） | `POST /admin/accounts/remove` | ✅ 带 `confirm` 守卫 |

| 项 | 值 |
|---|---|
| 新增模块 | `src/upstream/import.ts`、`tests/import.test.ts` |
| 单测 | **98/98 通过** |
| 类型检查 | 通过 |

---

## 🔑 核心验证：凭据全链路打通

这是本步最重要的验证 —— **证明凭据从导入到出站请求真的通了**：

| 环节 | 证据 |
|---|---|
| ① 导入解析 | 嵌套形 auth 文件正确解析，`expiresAt` 秒→毫秒转换正确（`1799999999` → `1799999999000`） |
| ② 加密落盘 | `GET /admin/credentials` 返回该 uid（**不返回 token**） |
| ③ 账号条目建立 | `GET /admin/accounts` 返回昵称等字段 |
| ④ **解密并注入出站请求** | 用导入的**假 token** 启动任务 → 上游返回**真实 HTTP 401** |

**第 ④ 条是关键**：之前（凭据层未做时）报的是「没有凭据」；
现在报的是**上游的 401** —— 说明 token 真的被解密、注入到出站请求、并发到了上游。
换成真 token 即可直接工作。

---

## 📥 导入格式：兼容 Go 侧双形态

**为什么必须兼容**：用户可能已在跑 Go 版 `workbuddy2api-panel`，账号都在 `auths/` 里。
不兼容就得**重新登录每个账号**（每个都要浏览器授权）—— 这是最影响迁移意愿的摩擦点。

判据是**顶层有没有 `auth` 键**，不是猜字段（扁平形也含 `domain`/`expiresAt`）：

**嵌套形**（插件 OAuth 输出，主形态）：
```json
{
  "auth":    { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000,
               "domain": "copilot.tencent.com", "realm": "cn" },
  "account": { "uid": "...", "enterpriseId": "...", "nickname": "..." },
  "device_token": "..."
}
```

**扁平形**（手写 / 旧版）：
```json
{ "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000,
  "domain": "...", "realm": "cn", "uid": "...", "enterpriseId": "...", "nickname": "..." }
```

**载荷形态**支持三种：单对象、数组、`{accounts:[...]}` 包裹。

### ⚠️ 单位陷阱：`expiresAt` 是 Unix **秒**

Go 侧存的是**秒**（`auth.go:302-305` 用 `.Unix()`），本项目用**毫秒**。
⇒ 导入时若不 ×1000，过期时间会落到 1970 年，续期逻辑会**永远判定「需要续期」
并反复打上游** —— 表现为「莫名其妙一直在刷新」，而不是一个显眼的报错。

已用启发式归一化（`< 1e12` 视为秒），并单测锁定。

### 逐条独立 + 失败必回报

批量导入时**单条失败不影响其他条**（账号目录里混一个坏文件很常见），
但失败原因**必须回报**，不静默丢弃：

```json
{
  "ok": true,
  "imported": [{ "uid": "…", "nickname": "…", "realm": "cn", "expiresAt": 1799999999000 }],
  "skipped":  [{ "reason": "缺少 uid（auths/bad.json）", "source": "auths/bad.json" }]
}
```

### ⚠️ 报告里不含 token

导入报告会进日志，故**只回 uid/nickname/realm/expiresAt**。
有单测专门断言「序列化后的报告不含 token 字符串」。

---

## 🔒 安全约束（本步新增/强化）

| 约束 | 实现 | 理由 |
|---|---|---|
| uid 白名单 | `isValidUid`：`[A-Za-z0-9_-]` 且 ≤64 | uid 来自上游且**用作 storage key**。Go 侧记录过同型风险的严重形态：uid 曾直接被拼进**文件名**，构成路径穿越 |
| 删除需显式确认 | 请求体必须带 `"confirm": true` | 删除**不可逆**（连带凭据），防手滑 |
| 未配密钥拒绝写入 | `requireCredentialKey` 抛错 | 不静默明文落盘 |
| 响应脱敏 | 所有端点只回非敏感字段 | token 绝不回给客户端 |

---

## 端点一览（本步结束时的完整面）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/healthz` | 存活探针（免鉴权） |
| GET | `/admin/pool?realm=` | 账号池计数 |
| GET | `/admin/accounts?realm=` | 账号列表（脱敏） |
| POST | `/admin/import` | **导入凭据（双形态）** |
| GET | `/admin/credentials?realm=` | 凭据 uid 列表（**不含 token**） |
| POST | `/admin/accounts/remove` | **删除账号（需 confirm）** |
| POST | `/admin/login/start` | 发起设备码登录 |
| GET | `/admin/login/poll?state=` | 轮询登录结果 |
| POST | `/admin/tasks/start` | 启动任务（需已导入/登录凭据） |
| GET | `/admin/tasks/status?uid=` | 查任务进度 |
| GET | `/v1/models` | OpenAI 兼容（占位，第 6 步） |
| POST | `/v1/chat/completions` | OpenAI 兼容（占位，第 6 步） |

---

## 复现

```bash
# 导入（嵌套形）
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/import" \
  -H 'content-type: application/json' \
  -d '{"auth":{"accessToken":"...","expiresAt":1799999999,"realm":"cn"},"account":{"uid":"...","nickname":"..."}}'

# 确认凭据已加密落盘
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/credentials?realm=cn"

# 启动任务（会真的用凭据打上游）
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/tasks/start" \
  -H 'content-type: application/json' -d '{"uid":"...","realm":"cn","plan":"daily"}'

# 看结果（401 说明 token 是假的；换成真 token 应看到签到成功）
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/tasks/status?uid=..."

# 清理（不可逆，需 confirm）
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/accounts/remove" \
  -H 'content-type: application/json' -d '{"uid":"...","realm":"cn","confirm":true}'
```

---

## 下一步（第 5 步）

任务引擎的行为事件动作。当前 `actions.ts` 只有 `listTasks` / `balance` / `checkin`
三个动作，其余报未实现。第 5 步要补齐：

- **零对话消耗**的行为上报动作（`chat_5` / `first_buddy` / 桌面事件链类）；
- **进度回读 + 自动领奖**（`taskrunner/verify.ts`）——
  注意上游计分**异步**（实测 5–8s 才落定），需有界轮询；
- 增量幂等（已 `claimed` 跳过、只补差额）。

⚠️ 动领奖前必读 `AGENTS.md` §6.3（路径历史坑）。
⚠️ **不得为了「跑快」调小反风控间隔**（`AGENTS.md` §2.4）。
