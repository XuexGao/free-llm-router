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
| **OpenAI 兼容网关** | `GET /v1/models` + `POST /v1/chat/completions`，**流式与非流式**均支持，含**工具调用**。已接入账号池（选号 / 记账 / 失败换号） |
| **多供应商** | **10 家厂商 / 11 个变体**，统一 `Provider` 接口；模型名用 `provider/model` 前缀路由 |
| **凭据加密** | AES-GCM 落 DO SQLite，**不继承** Go 版明文存盘的做法；未配置密钥时**拒绝写入** |
| **账号接入** | 设备码登录（浏览器授权）+ 凭据导入（兼容 Go 的 `auths/*.json` 双形态与 DSH 的 snake_case） |
| **管理面板** | 7 个视图：供应商与账号 / 任务中心 / 用量 / 积分包 / 模型 / 配置 / 日志 |

### 支持的供应商（10 家厂商 / 11 个变体）

> 腾讯有**国内版**（`buddy`）与**国际版**（`workbuddy`）两个变体，同源但端点与模型池不同，
> 故「厂商数」与「变体数」不一致。

| 供应商 | id | 面板登录 | 说明 |
|---|---|---|---|
| Buddy（腾讯国内版） | `buddy` | ✅ 设备码 | **默认供应商** |
| WorkBuddy（腾讯国际版） | `workbuddy` | ✅ 设备码 | 无签到接口（上游形态） |
| Cline | `cline` | ✅ 用户码 | RFC 8628 设备码 |
| Qoder | `qoder` | ✅ 设备码 | |
| Raccoon（商汤） | `raccoon` | ✅ 微信扫码 | 无签到端点 |
| ZCode（智谱） | `zcode` | ✅ 设备码 | 签到需浏览器过 captcha |
| CodeArts（华为云码道） | `codearts` | ✕ | 见下 |
| TRAE（字节跳动） | `trae` | ✕ | 见下 |
| MiniMax Code（中国版） | `minimax` | ✕ | 协议支持，未接线 |
| LobsterAI（有道龙虾） | `lobsterai` | ✕ | 需本机回调 |
| OpenCode Zen | `opencode` | ✕ | 只能用 API key |

**打 ✕ 的都能正常对话**，只是不能从本服务发起登录，**粘贴凭据导入即可**。
每个 ✕ 都有可操作的具体原因（面板会显示），不是笼统的「不支持」：

- **codearts / trae**：回调被上游**强制**指向本机 `127.0.0.1`，而 Worker 收不到用户本机的端口。
  实测过：TRAE 强制本机回调；华为的登录跳转链在**服务端就会死循环**（浏览器被反复送回登录页）。
  **这是上游的协议限制，不是本服务的缺失。**
- **minimax / lobsterai / opencode**：协议支持但未接线（`opencode` 本就没有登录流程）。

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

### 模型路由（`provider/model` 前缀）

```jsonc
"model": "buddy/deepseek-v4-flash"   // 带前缀 → 指定供应商
"model": "deepseek-v4-flash"         // 裸名 → 回落到默认供应商（buddy），保持兼容
```

- `GET /v1/models` 的目录里**一律带 `provider/` 前缀**（因为多家有同名模型，裸名分不清是哪一家）；
  **只列「有账号」的供应商**的模型，避免选到必然失败的模型。
- 请求侧**仍接受裸名**，回落到默认供应商。

### 添加账号

**① 面板登录**（支持的供应商）：点「添加账号」，按提示在浏览器完成授权，
面板会自动轮询并加密保存。`buddy` / `workbuddy` / `qoder` / `zcode` 是标准设备码；
`cline` 是**用户码**式；`raccoon` 是**微信扫码**。

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

也接受数组或 `{"accounts":[...]}`。系统会**自动识别**是哪一家（无需声明供应商）。

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
| **带真实凭据的高频请求未验证过 WAF** | 前置验证只测了**无凭据只读**请求。IP 级护栏已实现（60 秒内 2 个不同账号接连 403 即 fail-fast），但触发条件本身未被真实命中过 |
| **会话粘性未接线** | `AccountPoolDO` 已有绑定读写方法，但网关侧**没有调用点** ⇒ 同一会话可能落不同账号 → 上游 prompt cache 未命中（多花钱、更慢） |
| **图片入站未实现** | Free 计划 10ms CPU 下 base64 图片解码可能超限 |
| **连登兑换 / 抽奖 / 旅行未接线** | `src/upstream/travel.ts` 已实现，但未接入计划表或动作表 |
| **流内换号未实现**（trae / lobsterai） | 需先消费整个 SSE 才能决定重发，与逐帧透传（10ms CPU 铁律）冲突 |
| **codearts / trae / lobsterai 的登录** | 上游**强制**回调 `127.0.0.1`（codearts 还会在服务端死循环），Workers 收不到 —— 只能导入凭据 |
| **minimax / opencode 的登录** | minimax 协议支持但未接线；opencode **本就没有登录流程**（只能用 API key）。已如实声明 `login: false` |
| **opencode 每账号代理** | Workers `fetch` 不接受 `dispatcher` ⇒ 多个匿名槽共享同一出口 IP，免费额度**不再能通过多开扩容** |
| **zcode 签到** | 需 headful Chromium 过阿里云 captcha（推理不受影响） |

---

## 文档

| 文件 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **唯一权威设计文档**：项目目标、可行性、架构、协议事实、实施记录与踩坑。§9 是完整的实施进度与实测发现 |
| [DEPLOY.md](DEPLOY.md) | 部署细节：自定义域、GitHub 自动部署、自检、移除 |
| [probe/](probe/) | 独立的出口 IP / WAF 验证探针（可单独部署复用） |

## License

MIT
