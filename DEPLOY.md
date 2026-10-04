# 部署说明

## 当前线上状态

| 项 | 值 |
|---|---|
| **对外入口** | <https://<你的域名>> |
| 备用入口 | <https://workbuddy-gateway.<你的子域>.workers.dev> |
| 管理面板 | <https://<你的域名>/panel/> |
| 账号 | 2 个（CN 域），已导入 |

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

Dashboard → Workers & Pages → `workbuddy-gateway` → **Settings** → **Build** →
Connect to Git → 选 `XuexGao/hivegate`。

> ⚠️ 仓库已从 `workbuddy-serverless` 改名为 `hivegate`（GitHub 会自动重定向旧地址，
> 但**建议改成新名** —— 否则 Dashboard 里可能一直显示旧名）。
>
> ⚠️ **Worker 名仍是 `workbuddy-gateway`，不要改** —— 它是 Worker 在 Cloudflare 上的
> 身份，而 Durable Object 存储**按 Worker 隔离**。改名等于部署新 Worker，
> 账号池里的全部账号会读不到。详见 `wrangler.jsonc` 开头的说明。

- Build command：`npm install`
- Deploy command：`npx wrangler deploy`

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
