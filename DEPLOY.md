# 部署说明

## 当前线上状态

| 项 | 值 |
|---|---|
| **对外入口** | <https://<你的域名>> |
| **绑定方式** | **Worker Route**（`<你的域名>/*` → `free-llm-router`），**不是** Custom Domain |
| 备用入口 | <https://free-llm-router.<你的子域>.workers.dev> |
| 管理面板 | <https://<你的域名>/panel/> |

> ⚠️ **绑定方式为什么是 Route 而不是 Custom Domain**（2026-10-11 变更）
>
> **Custom Domain 会由 Cloudflare 自己托管那条 DNS 记录** —— 你改不了它，
> 一改绑定就失效。而 **Route 只按 pattern 匹配，DNS 记录完全归你**。
>
> ⇒ 若要做**优选 IP / 优选域名**，**必须**用 Route：优选的前提就是你
> 自己控制那条 DNS 记录（指到自己选的 IP / CNAME）。
>
> ⚠️ 迁移步骤（已执行）：
> 1. 删除 Custom Domain 绑定
>    （`DELETE /accounts/{id}/workers/domains/{domain_id}`）
>    —— ⚠️ 它**会连带删掉 CF 自动建的那条 DNS 记录**，故必须先准备好替代记录，
>    否则域名会立刻解析失败；
> 2. 自己加一条 DNS 记录指向 Worker；
> 3. Route 保持不动（本例中它**早已存在**，无需新建）。
>
> ⚠️ **Route 通常要求 DNS 记录是「已代理」（橙云）** ——
> Worker Route 只在**经过 Cloudflare 网络**的流量上触发。
> 实测：本域名在特定优选配置下（未开橙云）**仍然可用且返回 200**，
> 但 `cf-ray` / `server: cloudflare` 仍在，说明流量确实经过 CF。
> 若你的优选方案改成灰云后 Route 不触发（表现为 404 / 连不上），
> 那就必须开橙云，或改用 Custom Domain 放弃优选。

> `/` 根路径返回 **401**（需密钥）—— 这是刻意的，避免被扫到。
> 面板在 `/panel/`，它本身不含敏感数据，但所有数据接口都要 `Authorization`。

## 重新部署

```bash
# 认证（二选一）
npx wrangler login
# 或
export CLOUDFLARE_API_TOKEN=<token>   # 需 "Edit Cloudflare Workers" 权限

npm install
npm run deploy
```

**secret 已设置**，重新部署不需要重设。

## ⚠️ 两个容易踩的坑（都实测踩过）

### 1. 一旦配置里出现 `routes`，`workers.dev` 会被默认关闭

若此时自定义域的 DNS 还没生效，服务会**完全不可达**（workers.dev 404 + 域名解析失败）。
故 `wrangler.jsonc` 里**显式保留** `"workers_dev": true` 作为兜底入口。不要删。

### 2. 自定义域用 `PUT` 而不是 `POST`

绑定域名时 `POST /accounts/{id}/workers/domains` 返回
`405 Method not allowed for this authentication scheme`，
**改用 `PUT` 同一个端点即可成功**：

```bash
curl -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/domains" \
  -d "{\"zone_id\":\"$ZONE\",\"hostname\":\"<你的域名>\",\"service\":\"workbuddy-gateway\",\"environment\":\"production\"}"
```

**用自定义域 API 不需要 DNS 写权限** —— Cloudflare 会自动创建对应的 DNS 记录。
（本项目 token 没有 DNS 权限，用 `routes` 配置时就得手工建 DNS；用自定义域 API 则不需要。）

## secret 说明

| secret | 用途 | 未设置的后果 |
|---|---|---|
| `API_KEY` | 面板与全部 API 的口令 | 所有请求 401（fail-closed） |
| `CREDENTIAL_KEY` | 凭据 AES-GCM 加密密钥 | **拒绝写入凭据**（不静默明文落盘） |

```bash
openssl rand -base64 32 | npx wrangler secret put API_KEY
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY
```

## 绑定 GitHub 自动部署（可选）

Dashboard → Workers & Pages → `free-llm-router` → **Settings** → **Build** →
Connect to Git → 选 `XuexGao/free-llm-router`。

> ⚠️ **Worker 名是 `free-llm-router`，必须与 `wrangler.jsonc` 的 `name` 一致** ——
> 它是 Worker 在 Cloudflare 上的身份，而 Durable Object 存储**按 Worker 隔离**。
> 在这里改名的后果见 `wrangler.jsonc` 开头的说明（**会新建一个空 Worker，
> 账号池里的全部账号读不到**）。改名请在网页端做，然后同步那一行。

- Build command：`npm ci`（**不要用 `npm install`**，理由见下）
- Deploy command：`npx wrangler deploy`

### ⚠️ 构建环境用 `npm ci` —— 一次真实的构建失败（2026-10-17）

Cloudflare 的构建默认执行 `npm clean-install`（即 `npm ci`），
它在 **npm 10.9.2** 下会做**严格的 peer 依赖校验**：

```
npm error code ERESOLVE
npm error While resolving: wrangler@4.147.0
npm error Found: @cloudflare/workers-types@4.20260702.1
npm error Could not resolve dependency:
npm error peerOptional @cloudflare/workers-types@"^5.20261001.1" from wrangler@4.147.0
npm error Conflicting peer dependency: @cloudflare/workers-types@5.20261016.1
```

**根因**：`wrangler@4.147.0` 把 `@cloudflare/workers-types` 的 peer 要求提到了
**主版本 `^5`**，而项目当时锁的是 `^4` ⇒ **主版本不相容**。

⚠️⚠️ **两个值得记住的点**：

1. **它标着 `peerOptional`，但 `npm ci` 照样报错** ——
   「optional」不等于「不校验」。我一度因为看到 `optional: true` 而以为无关。
2. **本地 `npm ci` 通过，Cloudflare 却失败** —— 本地是 **npm 11**（行为更宽松），
   Cloudflare 是 **npm 10.9.2**。
   ⇒ **验证构建问题的唯一可靠办法是用同款 npm 版本复现**：
   ```bash
   npx -y npm@10.9.2 ci        # 与 Cloudflare 构建环境一致
   ```

**修法**：把 `@cloudflare/workers-types` 升到 `^5`（`wrangler` 要求的主版本）。
升级后 typecheck 0 错误、单测全过 —— 说明 v5 对本项目**无破坏性变更**
（它只经 `tsconfig.json` 的 `types` 数组全局引入，代码里没有直接 import）。

⚠️ **secret 不会随 Git 部署带入**，需在 **Settings → Variables and Secrets** 手工加。

## 自检

```bash
BASE=https://<你的域名>
KEY=<你的 API_KEY>

curl -s "$BASE/healthz"                                          # {"ok":true}
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=cn"
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/waf?realm=cn"   # IP 级护栏状态
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 200
```

## 移除

```bash
npx wrangler delete workbuddy-gateway
# 验证探针（不需要可删）
npx wrangler delete workbuddy-egress-probe
```
