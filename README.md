# workbuddy-serverless

把腾讯 **WorkBuddy / CodeBuddy** 账号变成「任务自动执行 + OpenAI 兼容 API」的 serverless 服务，
部署在 **Cloudflare Workers（Free 计划）** 上。

> ⚠️ **仅限本人授权账号自用。** 见 [使用边界](#使用边界)。

- **服务**：<https://api.xiegao.top>
- **管理面板**：<https://api.xiegao.top/panel/>

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **任务自动执行** | 成长任务（11 个零对话消耗动作）+ 每日签到 + 余额查询 + **自动领奖**。真实账号实测 **23/23 步全成功** |
| **OpenAI 兼容网关** | `/v1/models`（108 条：54 裸名 + 54 带前缀）+ 流式 `/v1/chat/completions`（含工具调用），已接入账号池（选号 / 记账 / 失败换号） |
| **11 家供应商** | workbuddy / cline / minimax / codearts / lobsterai / trae / qoder / opencode / loomy / raccoon / zcode，统一 `Provider` 接口 |
| **凭据加密** | AES-GCM 落 DO SQLite，**不继承** Go 版明文存盘的做法 |
| **账号接入** | 设备码登录（浏览器授权）+ 凭据导入（兼容 Go 的 `auths/*.json` 双形态与 DSH 的 snake_case） |
| **管理面板** | 8 个视图：账号池 / 任务中心 / 用量 / 积分包 / 模型 / **供应商** / 配置 / 日志 |

---

## 快速开始

```bash
npm install
npm run typecheck    # 类型检查
npm test             # 231 条单测
npm run deploy       # 部署（需先 npx wrangler login）

# 必须设置两个 secret（未设置时凭据层会**拒绝写入**，不静默明文落盘）
openssl rand -base64 32 | npx wrangler secret put API_KEY        # 面板与 API 的口令
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY # 凭据加密密钥
```

然后打开 `https://<你的域名>/panel/`，把 `API_KEY` 粘进去即可。

### 选供应商（`provider/model` 前缀）

模型名支持两种写法，**都可用**：

```bash
"model": "deepseek-v4-flash"            # 裸名 → 默认供应商（WorkBuddy），保持既有兼容
"model": "qoder/xxx"                    # 带前缀 → 指定供应商
```

看 `GET /admin/providers` 可拿到 11 家的能力矩阵与**每项不可用的具体原因**。

### 添加账号（两种方式）

**① 设备码登录**（面板「添加账号」）：点击后给出授权链接 → 浏览器打开授权 → 面板自动轮询并加密保存。

**② 导入凭据**（面板「导入凭据」）：粘贴 JSON。支持三种形态：

```jsonc
// 嵌套形（Go 版 auths/*.json）
{ "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000, "realm": "cn" },
  "account": { "uid": "...", "nickname": "..." } }

// 扁平形 camelCase
{ "accessToken": "...", "uid": "...", "expiresAt": 1700000000 }

// 扁平形 snake_case（DSH 插件 .credentials.yaml）
{ "access_token": "...", "user_id": "...", "expires_at": 1793427699000 }
```

也接受数组或 `{"accounts":[...]}`。

### 用 OpenAI 客户端接入

```bash
curl -N https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

`model` 直接填上游模型 id（如 `deepseek-v4-flash` / `glm-5.2`）——
本项目只有 WorkBuddy 一个 provider，故**不需要 `provider/model` 前缀**。

---

## 架构

```
        客户端 / SDK ─────────►┌──────────────────────────┐
        (OpenAI 兼容)          │  Worker: fetch handler   │
                               │  /v1/models  /v1/chat/…  │
                               │  /admin/*    /panel/*    │
                               └───┬──────────────────┬───┘
                    选号/记账 RPC │                  │ 任务控制 RPC
                                  ▼                  ▼
                  ┌────────────────────┐  ┌──────────────────────┐
                  │ DO: AccountPool    │  │ DO: TaskRunner        │
                  │ (每 realm 一个)    │  │ (每账号一个)          │
                  │ · 冷却/熔断/降权   │  │ · 任务状态机          │
                  │ · 会话粘性         │  │ · alarm 步进          │
                  │ · 凭据(加密)       │  │ · per-account 串行    │
                  └─────────┬──────────┘  └──────────┬───────────┘
                            └────────┬───────────────┘
                                     ▼
                         DO SQLite（凭据密文 / 池状态 / 任务进度）
                                     ▲
                                     │ 1 条每小时 cron（只唤起，不执行）
```

**三个关键设计决定**（都有实测依据，详见 `AGENTS.md`）：

1. **任务引擎必须用 Durable Object + alarm 步进**。
   单账号跑完全部任务要**数分钟**（实测 mp 任务间隔 45s），而 Workers 的普通请求
   handler **没有跨请求的后台执行**（`waitUntil` 只延长 30 秒）。
   每次 alarm 只做一步 → 存进度 → `setAlarm()` 续期。
   DO 的单线程语义**天然等价**于 Go 版的 per-account 锁，还免费获得抗重启能力。

2. **Free 计划的 10ms CPU 是唯一硬约束**。
   ⇒ 网关**必须流式**（绝不 `await response.text()` 上游响应）；
   ⇒ 任务**必须一次调用一步**；
   ⇒ 存储**只用 DO SQLite**（KV Free 仅 1,000 写/天，且最终一致）。

3. **cron 只占 1 条配额**。
   Free 上限 5 条，实测本账号已被其他 Worker 占 4 条。
   故用「1 条每小时 + Worker 内按 UTC+8 分发」。**代价**：时点粒度只能是整点。

---

## 测试

```bash
npm test    # 231 条
```

覆盖的都是**踩过坑的语义**，不是「代码能跑」：

| 测试文件 | 锁住什么 |
|---|---|
| `state.test.ts` | 四维正交惩罚状态机（模型级冷却不拦其他模型、审计条目不参与判定…） |
| `classify.test.ts` | 错误分类（**403 无信封才是 WAF**；401/302 不是） |
| `events.test.ts` | 四套指纹的事件形状（字段名错一个就静默不点亮） |
| `protocol.test.ts` | 任务解析 / 余额双层信封 / `11128` 脱敏 / uid 安全边界 |
| `crypto.test.ts` | AES-GCM（明文不出现、IV 不重用、篡改被检测、未配密钥拒绝写入） |
| `import.test.ts` | 双形态 + snake_case + **`expiresAt` 秒/毫秒单位陷阱** |
| `verify.test.ts` | 领奖闭环（**必须有界轮询**，只读一次会漏领）+ 计划编排不变式 |
| `gateway.test.ts` | 请求体 4 处必改 + 工具配对清理 + **4 种错误帧识别** |
| `panel.test.ts` | 面板安全（CSP 无 `unsafe-inline`、不用 cookie、不拼 innerHTML） |
| `providers.test.ts` | 多供应商（模型名路由不残留前缀、凭据判别不串家、Anthropic SSE 必须转出 `choices`） |

---

## 使用边界

本项目**仅限本人授权账号自用**，继承参考项目（`workbuddy2api-panel`）的立场并明确反对：

- 批量注册小号 / 收购账号；
- 账号池出租、对外提供付费 API、二次加壳售卖。

技术方案不阻止这些用法，但**本项目的开发意图不包含它们**。
批量注册与转售接口配额违反目标平台服务条款。

---

## 已知限制（诚实记录）

| 项 | 影响 |
|---|---|
| **IP 级 WAF 护栏未实现** | 只有账号级软冷却；真遇到 IP 级拦截会轮转完所有号才停。**这是最高优先级的待办** |
| **带真实凭据的高频请求未验证过 WAF** | 前置验证只测了**无凭据只读**请求 |
| **会话粘性未实现** | 同一会话可能落不同账号 → 上游 prompt cache 未命中（多花钱、更慢） |
| **图片入站未实现** | Free 计划 10ms CPU 下 base64 图片解码可能超限 |
| **连登兑换 / 抽奖 / 旅行未接入计划表** | `src/upstream/travel.ts` 已实现，但当前计划只覆盖 11 个任务动作 |
| **6 个需真实对话的任务已做，但默认不入队** | 必须显式 `includeRealChat`（会消耗配额） |
| **codearts / lobsterai / trae 的登录** | 需 `127.0.0.1` 回调监听，Workers 无监听 socket；只能导入凭据 |
| **zcode 签到** | 需 headful Chromium 过阿里云 captcha（推理不受影响） |
| **opencode 每账号代理** | Workers `fetch` 不接受 `dispatcher` ⇒ 多个匿名槽共享同一出口 IP，免费额度**不再能通过多开扩容** |

---

## 文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **唯一权威设计文档**：可行性、架构、协议事实、实施纪律 |
| [docs/01-egress-probe.md](docs/01-egress-probe.md) | 出口 IP / WAF 前置验证（方法与结论） |
| [docs/02-skeleton.md](docs/02-skeleton.md) | 骨架：DO + SQLite + alarm 步进 |
| [docs/03-protocol.md](docs/03-protocol.md) | 上游协议层 + 凭据加密 |
| [docs/04-accounts.md](docs/04-accounts.md) | 账号接入（双形态导入） |
| [docs/05-task-engine.md](docs/05-task-engine.md) | 任务引擎（11 个动作 + 领奖闭环） |
| [docs/06-gateway.md](docs/06-gateway.md) | OpenAI 兼容网关 |
| [docs/07-panel.md](docs/07-panel.md) | 管理面板与安全设计 |
| [docs/08-providers.md](docs/08-providers.md) | **多供应商（11 家）**：抽象层、自实现的密码学原语、踩到的 5 个真实缺陷 |
| [probe/](probe/) | 独立的出口验证探针（可单独部署复用） |

## License

MIT
