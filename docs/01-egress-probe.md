# 出口 IP / WAF 前置验证（第 1 步）

> 对应 `../AGENTS.md` §2.6 与 §9 第 1 步。本文件记录验证方法、观测事实与**结论**。

## ✅ 验证结论（2026-10-03）：通过

已从 Cloudflare 出口实测，**未检出 WAF 拦截**。

| 项 | 值 |
|---|---|
| 探针地址 | `https://workbuddy-egress-probe.<你的子域>.workers.dev` |
| **Cloudflare 出口 IP** | **`2a06:98c0:3600::103`**（IPv6；`loc=SG`、`colo=SIN`） |
| 请求总数 | 5 轮 × 3 目标 + 10 轮加压 = **25 次**，**0 次 WAF 拦截** |
| `cn-auth-state` | **15/15 = HTTP 200 + `code:0`**，耗时 253–973 ms |
| `cn-billing` | 5/5 = 401（正常鉴权拒绝） |
| `cn-web` | 5/5 = 302（正常鉴权拒绝） |
| 完整原始输出 | [`01-egress-probe-result.json`](./01-egress-probe-result.json) |

**⇒ 判定：可行。可以进入第 2 步（骨架）。**

⚠️ **仍需留意的边界**：本次测的是**无凭据的只读请求**，
未覆盖「带真实凭据 + 真实对话」的完整链路。WAF 判据（IP 级、多号接力）在带凭据场景下
是否同样宽松，需在第 3–5 步实现后**用真实账号复核一次**。
设计上仍必须保留 Go 侧的 `wafIPGate` 等价物（多号短窗计数 → fail-fast），不能因为这次通过就把护栏去掉。

---

## 为什么这一步必须先做

设计文档把「出口 IP 被上游 WAF 拦」列为**最高风险**：Go 参考实现在 `internal/server/wafip.go`
里记录了真实的 IP 级拦截 —— 60 秒内 2 个不同账号接连命中 403 即判定出口 IP 被封。
Cloudflare Workers 从**共享 IP 段**出网，Free 计划**无法指定出口 IP**。
若上游对 CF 网段有额外关照，整个项目在写第一行业务代码前就已不成立。

## 探针做了什么

`probe/` 是一个独立的最小 Worker，只发**只读、零配额**请求：

| 目标 id | 请求 | 用途 |
|---|---|---|
| `cn-auth-state` | `POST copilot.tencent.com/v2/plugin/auth/state?platform=CLI` | **本项目登录第一步**；无凭据、不签 token、不写状态 |
| `cn-billing` | `POST www.codebuddy.cn/v2/billing/meter/get-user-resource` | 负向探针（无凭据 ⇒ 预期鉴权拒绝） |
| `cn-web` | `GET www.workbuddy.cn/console/account` | 负向探针，web 域（领奖权威域） |

出站头**逐字对齐** Go 侧 `internal/panel/login.go:54-64` 的 `commonHeaders`，
否则风控看到的客户端指纹与生产不同，验证就失去意义。

### WAF 判据（关键）

严格照抄 Go 的 `IsWafBlocked`（`internal/upstream/client.go:337-340`）：

| 形态 | 判定 |
|---|---|
| HTTP 200 + `{code:0,...}` | ✅ 通 |
| HTTP 4xx 但**带业务信封** `{code,msg}` | ✅ 通（上游业务层在正常应答） |
| **HTTP 403 且无业务信封**（HTML/空体/纯文本） | ❌ **WAF 拦截** |
| HTTP 401 / 302 且无信封 | ✅ 通（APISIX 对缺凭据的标准应答；见下） |
| 网络层错误 | ⚠️ 不确定 |

⚠️ **只把 403 判为 WAF**：实测 APISIX 对「缺 Authorization」回的是 **401**，对
`www.workbuddy.cn/console/account` 甚至回 **302**（跳登录页）。把 401/302 也当 WAF
会产生**假警报**，误导决策。

## 已观测到的事实（2026-10-03）

> 说明：以下协议行为最初从**本工作沙箱**出站观测（用于确认判据正确性），
> 随后**已在 Cloudflare 出口复现并确认**（见文首结论）。两处观测一致。

### ✅ 上游协议行为（可直接用于实现）

1. **登录第一步可用，且零配额**
   `POST /v2/plugin/auth/state?platform=CLI` 稳定返回 **HTTP 200**：
   ```json
   {"code":0,"msg":"OK","requestId":"30a5de2f-...","data":{
     "state":"0443bd6c-a2fc-4b0a-960d-1066484a8073",
     "authUrl":"https://copilot.tencent.com/login?platform=CLI&state=0443bd6c-..."}}
   ```
   连续 3 轮均 200，`state` 每次不同 ⇒ **确认轮询式设备码流程无需本地回调，
   天然适配 Workers**（印证设计文档 §2.5 第 2 条）。

2. **🔴 上游网关是 EdgeOne + APISIX**（新发现，影响架构）
   响应头实证：
   ```
   server: APISIX/3.9.1
   eo-log-uuid: 749823936410459580
   eo-cache-status: MISS
   set-cookie: tgw_l7_route=...
   ```
   ⇒ 上游同样跑在**腾讯 EdgeOne** 上。这解释了两件事：
   - 与设计文档 §8.2b 记录的「EdgeOne Pages 是 WorkBuddy 配套生态」互相印证；
   - **WAF 大概率是 APISIX 插件**，其拦截面对「机房 IP 段」可能比面对住宅 IP 更敏感。

3. **无凭据请求的标准应答形态**（用于负向探针判据）
   ```
   POST www.codebuddy.cn/v2/billing/meter/get-user-resource  → 401, text/html (openresty/APISIX)
   GET  www.workbuddy.cn/console/account                     → 302, text/html (openpress/APISIX)
   ```
   都是**裸 HTML、无 JSON 信封**。这正是「必须靠 403 判 WAF、不能靠『无信封』判 WAF」的原因。

4. **`www.workbuddy.cn/console/account` 是只读端点**（GET），
   可安全用于探测；**不要**用领奖端点做探针（那是写操作）。

### ✅ 已完成的验证

**已从 Cloudflare 出口实测通过**（见文首结论）。原始输出存于 `01-egress-probe-result.json`。

### 复现方式（探针仍在线上）

```bash
curl -s "https://workbuddy-egress-probe.<你的子域>.workers.dev/probe?rounds=5"
curl -s "https://workbuddy-egress-probe.<你的子域>.workers.dev/probe?only=cn-auth-state&rounds=10"
```

如需重新部署（改判据或换账号）：

```bash
cd probe
npm install
npx wrangler login      # 或 export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

> ⚠️ 这一节原本写的是「如何完成验证」的待办指令；**它已经执行完毕**，故改写为复现方式。

## 探针自身的质量保证

- 判据函数用**真实观测到的响应体**做了 9 条单测（含 403 带信封不该误判 WAF、
  401/302 不该误报 WAF、500 不该误报 WAF），9/9 通过。
- `wrangler deploy --dry-run` 构建通过（9.67 KiB / gzip 3.78 KiB）。
- 探针串行请求 + 1.2s 间隔，上限 10 轮 —— **避免探针自己变成风控触发源**。

## 验证通过后的下一步

按 `../AGENTS.md` §9 进入第 2 步：骨架（`wrangler.toml` + Worker 入口 +
AccountPool DO + schema）。
