# 部署说明

## 一键部署

```bash
# 1. 认证（二选一）
npx wrangler login                      # 浏览器授权
# 或
export CLOUDFLARE_API_TOKEN=<你的 token>  # 需要 Workers Scripts:Edit 权限

# 2. 部署
npm install
npm run deploy

# 3. 设置两个 secret（**不设置则凭据层拒绝写入**，不会静默明文落盘）
openssl rand -base64 32 | npx wrangler secret put API_KEY
openssl rand -base64 32 | npx wrangler secret put CREDENTIAL_KEY
```

部署完访问 `https://workbuddy-gateway.<你的子域>.workers.dev/panel/`，
把 `API_KEY` 的值粘进页面顶部的输入框。

## 创建 API Token 的步骤

访问 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
使用 **"Edit Cloudflare Workers"** 模板（包含所需权限）。

需要的权限：
- `Account` → `Workers Scripts` → **Edit**
- `Account` → `Workers KV Storage` → Edit（DO 相关）

## 绑定 GitHub 自动部署（可选）

Cloudflare Dashboard → Workers & Pages → 你的 Worker → **Settings** →
**Build** → Connect to Git → 选 `XuexGao/workbuddy-serverless`。

- Build command：留空（或 `npm install`）
- Deploy command：`npx wrangler deploy`

⚠️ **secret 不会随 Git 部署自动带入**，需在 Dashboard 的
**Settings → Variables and Secrets** 里手工添加 `API_KEY` 与 `CREDENTIAL_KEY`。

## 部署后自检

```bash
BASE=https://workbuddy-gateway.<你的子域>.workers.dev
KEY=<你的 API_KEY>

curl -s "$BASE/healthz"                                    # {"ok":true}
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/pool?realm=cn"
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/waf?realm=cn"
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | head -c 300
```

## 移除

```bash
npx wrangler delete workbuddy-gateway
npx wrangler delete workbuddy-egress-probe   # 验证探针，不需要了可删
```
