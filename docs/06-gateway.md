# 第 6 步：OpenAI 兼容聚合网关（已完成）

> 对应 `../AGENTS.md` §9 第 6 步。本文件记录网关实现、**真实账号端到端验证**与踩到的坑。

## ✅ 结论：网关已打通，真实账号实测可用

| 项 | 值 |
|---|---|
| 新增模块 | `gateway/payload.ts`、`gateway/stream.ts`、`gateway/server.ts`、`gateway/models.ts`、`gateway/http.ts` |
| 单测 | **163/163 通过** |
| 类型检查 | 通过 |
| 体积 | 118.99 KiB / gzip 29.97 KiB，启动 1 ms |

### 🔗 已接入账号池（不是裸代理）

**这是本步最重要的修正。** 初版网关直接取「第一个可用账号」，问题很严重：

- 一个号 429 或余额耗尽 → **整个服务立刻不可用**；
- 而且**不会恢复** —— 因为没有任何地方记录「这个号暂时别用」；
- 池里的冷却/熔断状态机（第 2 步就实现了）**形同虚设**。

现在形成完整闭环：

```
pick(排除已试) → 转发 → 成功 → noteSuccess（清熔断/降权）
                      ↘ 失败 → applyFailure（按类别落到正确维度）+ 换号重试
```

**两条守住的纪律**：

1. **`tried` 集合跨重试保留** —— 否则会在两个账号之间无限来回
   （Go 侧 `account-pool.ts:905-914` 记录过这个缺陷）。
2. **按错误类别罚正确的维度**（详见下方映射表）。

**记账已线上验证**：跑一次成功对话后 `successCount` 从 0 变 **2**，
`errTotal` / `fails` 保持 0 —— 证明成功路径确实回写了池状态。

> ⚠️ 为了让这一步**可验证**，我把 `successCount` / `errTotal` / `lastSuccess` /
> `fails` / `modelCooldowns` 加进了 `/admin/accounts` 的返回。
> 不暴露它们就无法确认记账有没有发生 —— 而**记账失效是静默的**
> （冷却/熔断形同虚设，但表面一切正常）。

### 错误 → 惩罚维度映射（`mapErrorToPunishment`，有 9 条单测锁定）

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

---

### 真实账号端到端实测（2026-10-03）

**① `GET /v1/models`** —— 从上游 `/v3/config` 拉到 **54 个真实模型**：

```
HTTP 200，模型数 54
  - auto | Auto
  - fast-model | 快速
  - balanced-model | 均衡
  - deep-model | 极致
  - hy3 / hy3-b / hy3-c / hy3-x
  - hy4-preview / hy4-preview-f
  ...
```

**② `POST /v1/chat/completions`（流式）** —— 真实模型回复：

```
帧数 22 | [DONE] ✅ | finish_reason: stop
usage: {prompt_tokens:10, completion_tokens:19, total_tokens:29, ...}
正文: "我是 DeepSeek 最新版模型，由深度求索公司开发的 AI 助手。"
```

**③ 工具调用** —— `tool_choice` 对象形式 + `tools` 数组：

```
错误帧: None | [DONE]: True | finish: tool_calls
tool_calls 帧数: 10
```

**第 ③ 条尤其关键**：它证明 `tool_choice` 归一化在真实上游生效了 ——
若未归一化，上游会返 **400 `code=11101`**（且错误信息**不说是哪个字段**）。

---

## 🐛 本步踩到并修复的缺陷

### 1. 模型目录路径搞错 → 静默返回空列表（本步最隐蔽的坑）

**现象**：`GET /v1/models` 返回 **HTTP 200 但 `data: []`**。

**为什么难查**：
- 没有报错、没有异常、没有日志；
- 表现为「这个账号看起来没有模型」，而不是「代码坏了」；
- 我最初是从 global 域的企业端点家族抄的形状，误以为是 `data.data.models`。

**真实形状**（实测抓取 `/v3/config` 骨架）：

```
data
├── agents[]        (1)    name / models[17] / tools[35]
├── models[]        (54)   ← ★ 模型在这里（单层！）
│   ├── id / name / vendor / maxInputTokens / maxOutputTokens
│   └── supportsImages / supportsToolCall / supportsReasoning / reasoning
├── productFeatures {}     (50)
├── config {}
└── …
```

⇒ 修法：**先试 `data.models`（CN 域真实形态），再回落 `data.data.models`**（兼容另一端点家族）。
并新增 3 条测试用**实测抓取的结构**锁死，防回归。

### 2. 我的加密测试有 flakiness（测试写错，不是代码错）

**现象**：`篡改密文会被检测到` 这条**间歇性失败**。

**根因**：我原先是「翻转密文**最后**一个字符」。但 base64 的末字符若处于非 4 的倍数位置，
**其低位是填充位、解码器会忽略** —— 于是翻转后解码出**完全相同的字节**，
「篡改」根本没发生。

实测验证：翻转**首字符**后解码必定改变（80640 次采样，0 次相同）。

⇒ 修法：改为翻转首字符，并补一条「篡改 IV」的用例。连跑 3 次全部通过。

---

## 🏗️ 网关架构

### 请求体准备（`payload.ts`，纯函数）

四处必须的改写（每处都对应一个真实失败）：

| 改写 | 不做的后果 |
|---|---|
| `max_completion_tokens` → `max_tokens` | 上游只认旧字段 → 回落默认上限 → **长回答被截断**（无报错） |
| 强制 `stream: true` | 上游按流式处理，语义不符 |
| `tool_choice` 对象 → `'auto'` | **400 `code=11101`**（不说是哪个字段） |
| 补 `stream_options.include_usage` | 末帧没有 usage → 用量统计恒为 0 |

**外加工具配对清理**（Go 侧记录过的严重缺陷）：
不完整的 `tool_calls` / `tool` 配对会让上游**对之后每条消息都返 400** —— 整条会话报废。
另剔除**名称为空的 tool_call**（它会跨 provider 传染，报 `11133` 且不指出字段）。

### 流式透传（`stream.ts` + `server.ts`）

**铁律**：绝不 `await response.text()` 上游响应。

```
上游 body.getReader() → 逐 chunk 解码 → 按行切 SSE 帧 → 转换 → enqueue
```

- 用 `decoder.decode(value, { stream: true })` 处理**跨 chunk 的多字节字符**（不用 stream 选项会解码出乱码）；
- 正常帧**原样转发**（不 `JSON.parse` 再 `stringify`）—— 省 CPU；
- **只在可能是错误帧时才解析**（先看字符串里有没有 `"error"` / `"code"` / `"statusCodeValue"` / `"stackTrace"`）。

### 错误必须显式（不做静默失败）

Go 侧记录过多个「**客户端看到干净地停止、无任何报错**」的缺陷，
全部源于解析器不认错误帧。故这里识别 **4 种**错误形态：

| 形态 | 例子 |
|---|---|
| OpenAI 标准 | `{error:{message,type}}` |
| 业务码 | `{code:6004, msg:'模型限流'}` |
| **网关形态**（最易漏） | `{stackTrace:[...], message, statusCodeValue:400}` — **既无 code 也无 error** |
| 非 JSON 数据帧 | `data: <html>...` |

另外两条兜底：
- 流结束但**从未产生任何内容** → 推错误帧（「疑似被截断」，而不是假装模型没话说）；
- 流中途异常 → 推错误帧再收尾（**绝不静默关闭**）。

---

## 📊 当前完整端点面

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针（免鉴权） |
| GET | `/v1/models` | **OpenAI 兼容模型目录**（真实 54 个） |
| POST | `/v1/chat/completions` | **OpenAI 兼容对话（流式 SSE）** |
| GET | `/admin/pool` | 账号池计数 |
| GET | `/admin/accounts` | 账号列表（脱敏） |
| POST | `/admin/import` | 导入凭据（双形态 + snake_case） |
| GET | `/admin/credentials` | 凭据 uid 列表（**不含 token**） |
| POST | `/admin/accounts/remove` | 删除账号（需 confirm） |
| POST | `/admin/login/start` | 发起设备码登录 |
| GET | `/admin/login/poll` | 轮询登录结果 |
| POST | `/admin/tasks/start` | 启动任务（daily / growth） |
| GET | `/admin/tasks/status` | 查任务进度 |

---

## ⚠️ 刻意的范围裁剪（诚实说明）

| 未做 | 原因 |
|---|---|
| **会话粘性** | 同一会话可能落到不同账号，导致上游 prompt cache 未命中（多花钱、更慢）。Go 侧有完整实现（`internal/session`）；1–3 账号时收益较小，故裁剪 |
| **模型名路由** | 未做 `provider/model` 式命名空间（本项目只有 WorkBuddy 一族） |
| **图片入站** | 未做 base64 图片的多模态转换。**风险已知**：Free 计划 10ms CPU 下，图片解码可能超限（AGENTS.md §8.2.2 第 4 条） |
| **`/v1/embeddings` 等** | 上游无对应能力 |
| **IP 级 WAF 护栏**（`wafIPGate` 等价物） | 短窗内多号接连 403 时应在**进程级** fail-fast（而非逐号冷却）。当前只有账号级软冷却 —— 真的遇到 IP 级拦截时，会轮转完所有号才停 |

> ⚠️ 最后一条是本项目**已知的、未消除**的风险（对应 AGENTS.md §2.6）。
> 第 1 步的出口验证未检出 WAF，但那测的是**无凭据只读**请求；
> 带真实凭据的高频请求是否会被 IP 级拦截，仍未验证。

---

## 复现

```bash
npm run typecheck
npm test              # 154 条单测
npm run deploy

# 1. 导入真实凭据（DSH 的 .credentials.yaml 形态也支持）
curl -s -H "Authorization: Bearer $KEY" -X POST "$BASE/admin/import" \
  -H 'content-type: application/json' --data-binary @cred.json

# 2. 模型目录
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | jq '.data | length'

# 3. 流式对话
curl -sN -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}' \
  "$BASE/v1/chat/completions"
```

---

## 下一步（第 7 步）

Web 管理面板：账号运维 + 任务触发 + 日志查看。

但**先补两个更该做的事**（见下方"建议优先级"）：
1. **多账号轮转 + 冷却接入** —— 当前网关不换号，某个号 429 就直接失败；
2. **网关侧的错误记账** —— `handleChatCompletions` 返回了 `meta`，但 Worker 还没用它更新池状态
   （Go 侧的 `applyErrorPolicy` 等价物）。
