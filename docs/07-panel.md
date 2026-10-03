# 第 7 步：Web 管理面板（已完成）

> 对应 `../AGENTS.md` §9 第 7 步。本文件记录面板实现、安全设计、与踩到的两个渲染坑。

## ✅ 结论：面板已上线

**访问地址**：`https://workbuddy-gateway.<你的子域>.workers.dev/panel/`

| 项 | 值 |
|---|---|
| 新增模块 | `src/panel/index.ts`（路由+安全头）、`src/panel/assets/{index.html,style.css.txt,app.js.txt}` |
| 单测 | **179/179 通过**（面板 20 条） |
| 类型检查 | 通过 |
| 体积 | 136.52 KiB / gzip 36.27 KiB |

### 线上验证

| 项 | 结果 |
|---|---|
| `/panel/` | ✅ 200，`text/html`，2,312 字节 |
| `/panel/style.css` | ✅ 200，`text/css`，**2,975 字节**（真实样式） |
| `/panel/app.js` | ✅ 200，`application/javascript`，**10,611 字节**（真实代码） |
| 安全响应头 | ✅ CSP / `X-Frame-Options: DENY` / `nosniff` / `no-referrer` / `no-store` 全部就位 |
| `/admin/*` 无密钥 | ✅ **401**（面板不泄漏数据） |

### 面板功能

- **账号池**：列表（状态标签 / 积分 / 冷却倒计时 / 成功与错误计数 / 模型冷却）+ 删除（带确认）；
- **导入凭据**：粘贴 JSON（支持 Go 双形态 + DSH snake_case + 单对象/数组/`{accounts:[]}`）；
- **添加账号**：设备码登录（给出授权链接 + 自动轮询，无需手动查）；
- **任务**：选账号 + 选计划（`daily` / `growth`）→ 执行 → **自动轮询进度**（渲染成易读的逐步清单，而不是原始 JSON）；
- **模型目录**：一键加载，表格展示。

---

## 🔒 安全设计（这部分比功能更重要）

### 1. CSP 保持严格：不用 `unsafe-inline`

**取舍**：把 JS 内联进 HTML 会迫使 CSP 放开 `script-src 'unsafe-inline'` ——
那等于放弃 XSS 防护（任何注入的 `<script>` 都会执行）。
Go 侧（`internal/panel/index.go:24-31`）记录了同样的取舍，本项目沿用：
**脚本走独立文件 `/panel/app.js`**，CSP 保持 `script-src 'self'`。

有单测**静态检查** HTML 里没有内联脚本、CSP 里没有 `unsafe-inline`。

### 2. 页面免鉴权，但数据接口必须鉴权

页面**不含任何敏感信息**（不知道有哪些账号、也不知道 token），故可免鉴权加载。
真正的数据全在 `/admin/*` 与 `/v1/*` 后面，**一律要 Bearer 密钥**。

### 3. 刻意不用 cookie

cookie 会被浏览器**自动附带**，因此需要额外的 CSRF 防护（SameSite + token）。
而 `Authorization` 头**不会被自动附带**，天然免疫 CSRF。
密钥存 `localStorage`，每个请求显式带上。

有单测静态检查前端没有 `document.cookie`、且密钥不出现在 URL query 里
（后者会进日志与 Referer）。

### 4. 不把上游返回的 URL 拼进 innerHTML

授权 URL 来自上游响应。拼进 `innerHTML` 就有注入风险。
前端改用 `document.createElement` + `textContent` 构造。
有单测静态检查这一点。

---

## 🐛 本步踩到并修复的两个真实渲染坑

### 1. `.css` 被 Wrangler 当成 CSS module → 线上返回 `[object Object]`

**现象**：`/panel/style.css` 返回 **200 但只有 15 字节**，内容是 `[object Object]`。
面板因此**完全没有样式**（但页面能打开，所以很容易被忽略）。

**根因**：Wrangler 对 `.css` 有**内建**的模块处理（把它当 CSS module 对象而不是字符串），
`import css from './style.css'` 拿到的是对象，直接塞进 `Response` 就被字符串化成 `[object Object]`。

**修法**：CSS 源文件改名 `style.css.txt`，让它只命中本项目的 Text 规则；
服务时仍声明 `text/css`，浏览器侧无感。

> 同类问题：`.js` 也一样（esbuild 有自己的 loader，报
> `No matching export in "app.js" for import "default"`）。故面板 JS 也是 `app.js.txt`。

### 2. Text 规则必须标 `fallthrough: true`，否则与内建规则冲突

**现象**：构建失败，报

```
The file ./assets/index.html matched a module rule in your configuration
({"type":"Text","globs":["**/*.txt","**/*.html","**/*.sql"]}), but was ignored
because a previous rule with the same type was not marked as `fallthrough = true`.
```

**根因**：Wrangler **自带**一条 Text 规则覆盖 `**/*.html` / `**/*.txt` 等。
我另加的规则与它同类型却排在前面，把内建规则挡住了。

**修法**：只声明真正需要的 glob（`*.js.txt` / `*.css.txt`）并标 `fallthrough: true`，
让内建规则继续生效。

**教训**：不要试图覆盖 Wrangler 的内建模块规则，而是**换个文件扩展名**绕开它。

---

## 测试覆盖（面板 20 条）

| 类别 | 断言 |
|---|---|
| CSP 纪律 | 不含 `unsafe-inline`；`script-src 'self'`；`connect-src 'self'`；`frame-ancestors 'none'`；`default-src 'none'`；`base-uri 'none'` |
| 安全头 | 6 个响应头齐全 |
| 资源路由 | 页面带/不带尾斜杠都认；未知路径返回 undefined |
| **渲染正确性** | CSS 不得是 `[object Object]` 且长度 > 500；JS 需 `application/javascript` 且长度 > 2000 |
| 前端安全 | 不用 cookie；密钥不进 URL；`authUrl` 不拼 `innerHTML`；HTML 无内联脚本 |

---

## 📊 项目最终状态

| 步骤 | 状态 |
|---|---|
| 1. 出口 IP 验证 | ✅ 25 次请求 0 WAF 拦截 |
| 2. 骨架（DO + SQLite + 鉴权 + alarm） | ✅ |
| 3. 上游协议层 | ✅ 四套指纹 / 错误分类 / 设备码登录 / AES-GCM 凭据加密 |
| 4. 账号接入 | ✅ 双形态导入 + 删除 |
| 5. 任务引擎 | ✅ 11 个零消耗动作 + 领奖闭环（真实账号 23/23 成功） |
| 6. 聚合网关 | ✅ 54 个模型 + 流式对话 + 工具调用 + 接入账号池 |
| 7. Web 面板 | ✅ 本步 |

**测试 179/179 通过。**

## ⚠️ 仍未消除的风险（诚实记录）

| 项 | 状态 |
|---|---|
| **IP 级 WAF 护栏**（`wafIPGate` 等价物） | ❌ 未实现。当前只有账号级软冷却；真遇到 IP 级拦截会轮转完所有号才停 |
| **会话粘性** | ❌ 未实现。同一会话可能落不同账号 → 上游 prompt cache 未命中（多花钱、更慢） |
| **图片入站** | ❌ 未实现。Free 计划 10ms CPU 下图片解码可能超限（AGENTS.md §8.2.2） |
| **带真实凭据的高频请求是否会被 IP 级拦截** | ⚠️ 未验证。第 1 步测的是**无凭据只读**请求 |
| **连登兑换 / 抽奖 / 旅行** | ❌ `travel.ts` 已实现但**未接入计划表**（当前 `growth` 计划只覆盖 11 个任务动作） |
