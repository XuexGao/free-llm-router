# free-llm-router

**把多个大模型供应商的账号池，聚合成一个 OpenAI 兼容的 API** ——
外加任务自动化（签到 / 成长任务 / 自动领奖）。
部署在 **Cloudflare Workers** 上，**Free 计划即可**。

> 名字直白说明它是什么：**多个免费/自持账号 → 一个统一的 LLM 路由入口**。

> ⚠️ **仅限本人授权账号自用。** 见 [使用边界](#使用边界)。

- **服务**：`https://<你的域名>`
- **管理面板**：`https://<你的域名>/panel/`

---

## 功能

| 能力 | 说明 |
|---|---|
| **任务自动执行** | 成长任务（11 个零对话消耗动作）+ 每日签到 + 自动领奖。真实账号实测 **growth 计划 23/23 步全成功**，其中 `first_buddy` 真实领到 +300 积分 |
| **OpenAI 兼容网关** | `GET /v1/models` + `POST /v1/chat/completions`，**流式与非流式**均支持，含**工具调用**。已接入账号池（选号 / 记账 / 失败换号 / 会话粘性） |
| **Responses API** | `POST /v1/responses`（Codex CLI 等新一代客户端用），含流式 SSE 与工具调用。**内部复用 Chat 路径**，故 Chat 侧修好的缺陷它自动受益 |
| **多供应商** | **12 家厂商 / 12 个变体**，统一 `Provider` 接口；模型名用 `provider/model` 前缀路由 |
| **凭据自动续期** | 8 家支持续期。**每小时 cron 在过期前 1 小时主动换新**（不是等 401 才补救），并在 401 时兜底续期重放 |
| **凭据加密** | AES-GCM 落 DO SQLite，**不继承** Go 版明文存盘的做法；未配置密钥时**拒绝写入** |
| **账号接入** | 设备码登录（浏览器授权）+ 凭据导入（兼容 Go 的 `auths/*.json` 双形态与 DSH 的 snake_case） |
| **管理面板** | 7 个视图：供应商与账号 / 任务中心 / 用量 / 积分包 / 模型 / 配置 / 日志 |

### 支持的供应商（12 家）

> 腾讯有**国内版**（`buddy`）与**国际版**（`workbuddy`）两个变体，同源但端点与模型池不同。

| 供应商 | id | 面板登录 | 签到 | 续期 | 说明 |
|---|---|---|---|---|---|
| Buddy（腾讯国内版） | `buddy` | ✅ 设备码 | ✅ | ✕ | **默认供应商**（裸模型名的兜底） |
| WorkBuddy（腾讯国际版） | `workbuddy` | ✅ 设备码 | ✕ | ✕ | 上游无签到接口 |
| Cline | `cline` | ✅ 用户码 | ✅ | ✅ | WorkOS 设备码（用户码式） |
| Qoder | `qoder` | ✅ 设备码 | ✅ | ✅ | 会**排队**，实测 11–27s |
| MiniMax Code（中国版） | `minimax` | ✅ 设备码 | ✅ | ✅ | OAuth 设备码 + PKCE |
| Loomy（讯飞） | `loomy` | ✅ **短信验证码** | ✅ | ✕ | 微信扫码需本机回调，故只提供短信登录 |
| Raccoon（商汤） | `raccoon` | ✅ 微信扫码 | ✕ | ✅ | 上游无签到端点 |
| ZCode（智谱） | `zcode` | ✅ 设备码 | ⚠️ | ✕ | 签到需浏览器过阿里云 captcha；推理受上游风控（见下） |
| CodeArts（华为云码道） | `codearts` | ✕ | ✅ | ✅ | 登录回调被上游**强制**指向 `127.0.0.1` ⇒ 只能导入凭据 |
| TRAE（字节跳动） | `trae` | ✕ | ✅ | ✅ | 同上（强制本机回调） |
| LobsterAI（有道龙虾） | `lobsterai` | ✕ | ✅ | ✅ | 同上 |
| OpenCode Zen | `opencode` | ✕ | ✕ | ✕ | 本就没有登录流程，只能用 API key |

**打 ✕ 的都能正常对话**（`opencode` 的 ✕ 只影响登录与签到）。
不能从本服务发起登录的 4 家，原因都是**上游的协议限制**，不是本服务的缺失：

- **codearts / trae / lobsterai**：登录回调被上游**强制**指向本机 `127.0.0.1`，
  而 Worker **收不到用户本机的端口**（没有 listen socket）。
  实测过：TRAE 强制本机回调；华为的登录跳转链在**服务端就会死循环**（浏览器被反复送回登录页）。
  ⇒ 用**粘贴凭据导入**（见下）。
- **opencode**：上游只有匿名槽与 API key 两种用法，没有登录流程。

> `GET /admin/providers` 返回完整能力矩阵（`login` / `listModels` / `chat` / `balance` / `checkin`）。

> `GET /admin/providers` 返回完整能力矩阵与每项不可用的具体原因。

---

## 部署

### 前置条件

- **Node.js**（用于 `npm install` 与 `wrangler`）
- **Cloudflare 账号** —— **Free 计划足够**（Durable Objects 在 Free 计划可用，仅 SQLite 后端）
- 首次部署需要认证：`npx wrangler login`，或 `export CLOUDFLARE_API_TOKEN=<token>`
  （需 "Edit Cloudflare Workers" 权限）

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 设置两个必须的 secret
#    未设置时凭据层会**拒绝写入**（不静默明文落盘）
openssl rand -base64 32 | npx wrangler secret put API_KEY        # 面板与 API 的口令
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY # 凭据加密密钥

# 3. 部署
npm run deploy
```

| secret | 用途 | 未设置的后果 |
|---|---|---|
| `API_KEY` | 面板与全部 API 的口令 | 所有请求 401（fail-closed） |
| `CREDENTIAL_KEY` | 凭据 AES-GCM 加密密钥 | **拒绝写入凭据**（不静默明文落盘） |

### 打开面板

浏览器访问 `https://<你的域名>/panel/`，把 `API_KEY` 填进右上角的输入框即可。

> `/` 根路径返回 **401**（需密钥）—— 这是刻意的，避免被扫到。
> 面板页面本身不含敏感数据，但所有数据接口都要 `Authorization`。

### 完整细节

自定义域绑定、`workers.dev` 兜底、GitHub 自动部署、自检命令、移除服务等，
见 [DEPLOY.md](DEPLOY.md)。

---

## 快速上手

### 调用 API

```bash
curl -N https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

### Responses API

新一代客户端（Codex CLI 等）不发 `messages` 而是发 `input`：

```bash
curl -N https://<你的域名>/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4-flash","input":"你好"}'
```

⚠️ 不支持 `previous_response_id` 与 `store: true`（本服务无状态），传了会**明确报 400**
而不是静默忽略 —— 静默忽略会让客户端以为有上下文，进而答非所问。

### 模型路由（`provider/model` 前缀）

```jsonc
"model": "buddy/deepseek-v4-flash"   // 带前缀 → 指定供应商
"model": "deepseek-v4-flash"         // 裸名 → 回落到默认供应商（buddy），保持兼容
```

- `GET /v1/models` 的目录里**一律带 `provider/` 前缀**（因为多家有同名模型，裸名分不清是哪一家）；
  **只列「有账号」的供应商**的模型，避免选到必然失败的模型。
- 请求侧**仍接受裸名**，回落到默认供应商。

### 添加账号

**① 面板登录**（8 家支持）：点「添加账号」，按提示完成授权，面板会自动加密保存。
`buddy` / `workbuddy` / `minimax` / `qoder` / `zcode` 是**设备码**（浏览器授权）；
`cline` 是**用户码**式；`raccoon` 是**微信扫码**；`loomy`（讯飞）是**短信验证码**。

**② 导入凭据**（所有供应商都可用）：粘贴 JSON。支持三种形态：

```jsonc
// 嵌套形（Go 版 auths/*.json）
{ "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000, "realm": "cn" },
  "account": { "uid": "...", "nickname": "..." } }

// 扁平形 camelCase
{ "accessToken": "...", "uid": "...", "expiresAt": 1700000000 }

// 扁平形 snake_case（DSH 插件 .credentials.yaml）
{ "access_token": "...", "user_id": "...", "expires_at": 1793427699000 }
```

也接受数组或 `{"accounts":[...]}`。系统会**自动识别**是哪一家（无需声明供应商）——
识别靠每家供应商的 `matchesShape` 判别式。也可以显式指定 `"provider":"codearts"` 覆盖。

> ⚠️ 自动识别对**形状重叠**的家有顺序依赖：例如 `lobsterai` 与 `raccoon` 的
> `user_id` 都是纯数字，故各家的判别式必须**互相排除对方的独有字段**。
> 若导入后账号出现在**别家**名下，那就是判别式缺陷，请反馈。

---

## 使用边界

本项目**仅限本人授权账号自用**，继承参考项目（`workbuddy2api-panel`）的立场并明确反对：

- 批量注册小号 / 收购账号；
- 账号池出租、对外提供付费 API、二次加壳售卖。

技术方案不阻止这些用法，但**本项目的开发意图不包含它们**。
批量注册与转售接口配额违反目标平台服务条款。

---

## 已知限制（诚实记录）

已修掉的不再列在这里；下面全部是**当前仍然存在**的限制。

| 项 | 影响 |
|---|---|
| **带真实凭据的高频请求未验证过 WAF** | 前置验证只测了**无凭据只读**请求。IP 级护栏已实现（60 秒内 2 个不同账号接连 403 即 fail-fast），但触发条件本身未被真实命中过 |
| **图片入站未实现** | Free 计划 10ms CPU 下 base64 图片解码可能超限 |
| **连登兑换 / 抽奖 / 旅行未接线** | `src/upstream/travel.ts` 已实现、动作也已注册，但**没有计划表用到它**（当前只有 `daily` 与 `growth` 两个计划） |
| **流内换号未实现**（trae / lobsterai） | 需先消费整个 SSE 才能决定重发，与逐帧透传（10ms CPU 铁律）冲突 |
| **codearts / trae / lobsterai 的登录** | 上游**强制**回调 `127.0.0.1`（codearts 还会在服务端死循环），Workers 收不到 ⇒ 只能导入凭据 |
| **opencode 的登录** | 上游**本就没有登录流程**（只有匿名槽与 API key）。已如实声明 `login: false` |
| **opencode 每账号代理** | Workers `fetch` 不接受 `dispatcher` ⇒ 多个匿名槽共享同一出口 IP，免费额度**不再能通过多开扩容** |
| **zcode 签到** | 需 headful Chromium 过阿里云 captcha（推理不受影响） |
| **zcode 推理受上游风控** | 间歇性返回 `405 / code 3012 unusual activity`。**官方身份块已逐字对齐且实测正确**（3 个块、3149 字符），参考实现亦记录「身份块达标仍 3012 目前没有已知解释」⇒ 判为**账号/IP 级风控**，非本服务缺陷 |
| **codearts 的 `deepseek-v4.1-flash` 间歇不可用** | 上游回 `InferHub.4004.200 benefit not found`（权益未生效）。本服务会**如实报错**并附上游原文，不会静默返回空回复 |

### 关于「空回复」

本服务**绝不用空回复掩盖失败**：上游若返回没有正文、没有思考内容、也没有可识别错误帧的
响应，会明确报 502 `upstream_error` 并附上游原文片段。
（唯一的例外是**只调用工具**的响应 —— 那时正文本来就是空的。）

---

## 文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **唯一权威设计文档**：项目目标、可行性、架构、协议事实、实施记录与踩坑。§9 是完整的实施进度与实测发现 |
| [DEPLOY.md](DEPLOY.md) | 部署细节：自定义域、GitHub 自动部署、自检、移除 |
| [probe/](probe/) | 独立的出口 IP / WAF 验证探针（可单独部署复用） |

## License

MIT
