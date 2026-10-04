# 第 8 步：多供应商接入（11 家）

> 对应 `../AGENTS.md` §9 第 8 步。把服务从「只有 WorkBuddy」扩到 **11 家**，
> 并记录了移植过程中发现的真实缺陷与哪些能力**刻意不做**。

## ✅ 结论

| 项 | 值 |
|---|---|
| 新增目录 | `src/providers/`（**约 14,500 行**） |
| 供应商 | **11 家**（见下表） |
| 单测 | **231/231 通过** |
| 体积 | 826.70 KiB / gzip 272.44 KiB（Free 计划上限 1 MiB） |
| 零 `node:` 导入 | ✅ 全部纯 Web 标准（`fetch` / WebCrypto / `TransformStream`） |

### 11 家能力矩阵（**线上实测返回**）

| id | login | chat | checkin | 说明 |
|---|---|---|---|---|
| `workbuddy` | ✓ | ✓ | ✓ | 腾讯 CodeBuddy（默认供应商，反斜杠兼容既有用户） |
| `cline` | ✓ | ✓ | ✕ | WorkOS **设备码**（用户码式）：`/admin/providers/login/{start,poll}` 三步闭环 |
| `minimax` | ✕ | ✓ | ✓ | 上游是 **Anthropic Messages** 协议 |
| `codearts` | ✕ | ✓ | ✓ | 华为云码道；登录需 `127.0.0.1` 回调 |
| `lobsterai` | ✕ | ✓ | ✓ | 有道龙虾；登录需 `127.0.0.1` 回调 |
| `trae` | ✕ | ✓ | ✓ | 字节 TRAE；令牌经回调 query 回传 |
| `qoder` | ✓ | ✓ | ✓ | PKCE 设备码；WASM 生成签名头 |
| `opencode` | ✕ | ✓ | ✕ | 无登录流程（粘贴 API key）；每账号代理丢弃 |
| `loomy` | ✕ | ✓ | ✓ | 讯飞；登录函数已实现但未接线 |
| `raccoon` | ✕ | ✓ | ✕ | 商汤；每日额度由服务端自动发放（无签到端点） |
| `zcode` | ✓ | ✓ | ✕ | 签到需 headful Chromium 过阿里云 captcha |

**关键纪律：每个 `✕` 都带可操作的原因**，不用「不支持」这种无信息量文案
（`/admin/providers` 直接返回 `loginBlockedReason`）。

---

## 🏗️ 抽象层设计

```
src/providers/
├── types.ts        Provider 接口 + 能力声明 + 判别式
├── index.ts        注册表 + 自动识别（含顺序纪律）
├── anthropic.ts    Anthropic ↔ OpenAI 双向转换（共享层）
├── md5.ts          纯 TS MD5（WebCrypto 没有）
├── aes-cfb.ts      纯 TS AES-128-CFB（WebCrypto 没有）
├── workbuddy.ts    ★ 参考实现（其它家照此结构）
└── <10 家>.ts
```

**分层纪律**：供应商差异**全部**收敛到 `Provider` 接口。
网关只做「选号 → 调接口 → 记账 → 换号」这件与供应商无关的事，
**没有**一处 `if (provider === 'xxx')`。

### 两个必须自己实现的密码学原语

Workers 的 WebCrypto **只有** AES-CBC/GCM/CTR + SHA-1/SHA-256。
有两家需要它没有的东西：

| 原语 | 用在哪 | 为什么不能绕 |
|---|---|---|
| **MD5** (`md5.ts`) | loomy 的 `Content-MD5` 头 | 它是 9 段签名串的一段，缺了签名不对 |
| **AES-128-CFB** (`aes-cfb.ts`) | raccoon 的手机号加密 | CFB 是流模式（密文等长），**CBC 强制 PKCS#7 补位、CTR 反馈源不同**，都拼不出来 |

两者都与 Node/OpenSSL **逐字节对拍**过：
- MD5：RFC 1321 向量 + 填充边界（55/56/57/63/64/65）+ UTF-8/代理对
- AES-CFB：14 种长度 + 25 组随机 IV + **NIST SP 800-38A CFB128** + **FIPS-197**

> 🔴 **移植时真踩到并修掉一个静默错误**：AES 密钥扩展第一列漏了
> 「与上一轮同列异或」。症状是**不抛异常、只是密文全错**，
> 靠 FIPS-197 轮密钥向量抓出来。若没做这层对拍，
> 就会带着「能跑但全错」的加密上线（上游只回一个 `100003 params_encryted_error`）。

### qoder 的 298 KB WASM

`qoder-auth-wasm.wasm` 用于生成 `Bearer COSY.<载荷>.<签名>`。
参考实现从磁盘 `readFileSync` 读它（Workers 没有文件系统）。

**✅ 不需要任何配置**：wrangler **内建** `CompiledWasm` 规则
（`globs: ["**/*.wasm"]`），`import mod from './x.wasm'` 直接得到
`WebAssembly.Module`。已实测：产物 292 KB，`generate_runtime_auth_fields`
返回 `keyLen=172`，20 个签名头齐全。

> ⚠️ 单测用的 esbuild 给的不是 `Module`（它按 ESM 包装），
> 故 `compileWasm()` 做了运行时归一化 —— 是 `Module` 就直接用，
> 是字节就 `WebAssembly.instantiate` 编译。两种打包器都能跑。

---

## 🐛 过程中修掉的 5 个真实缺陷

### 1. ⚠️ 模型名前缀泄漏到上游（**放大器级**，最严重）

**现象**：客户端发 `workbuddy/deepseek-v4-flash` 后，
**连裸名 `deepseek-v4-flash` 也全部失败**，报「没有可用账号」。

**根因链**（每一环单独看都不显眼，串起来才致命）：
```
① prepareChatBody 复制整个 body（含 model）但**不改写 model**
   → 上游收到带前缀的名字
② 上游回 `model [workbuddy/deepseek-v4-flash] service info not found`
③ 该错误被归类为 `model_unavailable`（11102）
④ → 给这个模型写入 **6 小时**模型级冷却
⑤ → 此后**裸名**请求也因模型级冷却选不到号
⑥ → 对外表现为「没有可用账号」，与真实原因毫无关系
```

**修法**：把 body 里的 `model` 换成去前缀的裸名（**必须在 `prepareChatBody`
之前**做）；并加 `POST /admin/cooldowns/clear` 人工解冻入口
（模型级退避 6h 起步，修好代码后不该再等）。

**教训**：**错误分类会放大输入错误**。一个纯粹由我方造成的失败，
被归到「上游没有这个模型」这个语义上，就变成了对健康资源的长期拉黑。

### 2. ⚠️ 用量统计恒为 0（静默失败）

**现象**：对话成功，但 `/admin/usage` 永远是 0，**且没有任何错误日志**。

**根因**：记账发生在**响应流结束之后**，而 Worker 在响应结束时
会**取消所有未完成的 promise**。第一版写成 `.catch(() => {})`，
于是被取消这件事连日志都没有 —— 正是本项目一直在警告的静默失败形态。

**修法**：把 `ExecutionContext` 传进网关，用 `ctx.waitUntil()` 托住记账。
验证：`successCount` / 用量从 0 变 1，输入 7 / 输出 5 / 214ms。

### 3. ⚠️ minimax 静默无内容

**现象**：MiniMax 对话**没有任何报错**，但客户端一帧正文都读不到。

**根因**：MiniMax 上游说 **Anthropic 协议**
（`{"type":"content_block_delta",...}`，**没有 `choices` 字段**），
而网关的 `streamResponse` 对 OpenAI 帧是**零解析直通**
（刻意如此：Free 计划 10ms CPU，不 parse 才省）。
两者相遇 → Anthropic 帧被原样转发 → 标准 OpenAI 客户端按
`choices[0].delta.content` 取值 → 读不到，且不报错。

**修法**：在**供应商层**就地转换（出站流统一为 OpenAI SSE，
网关无需知道供应商差异）。已有回归测试锁死：
`withChoices > 0`、正文落在 `delta.content`、
`thinking_delta` 进 `reasoning_content`（**不得污染正文**）。

### 4. ⚠️ 凭据被别家抢走（4 家都犯）

**现象**：`{accessToken, uid}` 被 **cline 抢走**，存成永远 401 的 cline 账号，
而用户以为导入的是 WorkBuddy。

**根因（两层）**：
1. **令牌形状无法区分**：WorkBuddy、cline、minimax、zcode 的 access token
   **都是三段式 JWT**（实测 WorkBuddy 的就是标准 `eyJhbGciOiJSUzI1NiIsImtpZCI6…`，1500 字符）；
2. **字段名重叠**：cline 把 `uid`/`user_id` 当 `accountId` 的别名，
   而 DSH 形态的 WorkBuddy 凭据恰好有 `user_id`。

更糟的是有 4 家支持「直接粘贴令牌字符串」，且**无条件接受任何非空字符串** ——
实测 `parseCredentialAnywhere('str')` 被 minimax 收下。

**修法（两把闸门，都加在接口上）**：
- `bareStringPattern`：裸字符串必须**形状匹配**才收；
- `matchesShape`：对象必须含**该供应商独有**的字段（如 cline 的 `workos:` 前缀
  或 `clineUserId`、opencode 的 `api_key`）。**默认供应商作为兜底总是参与**。

**验证**（9 组输入全部落到正确的家）：
```
裸文本/null/数组 → ProviderError ✓
workbuddy 对象(DSH/camel) → workbuddy ✓
cline(workos 前缀 / clineUserId) → cline ✓
minimax(minimax_user_id) → minimax ✓
zcode(zcode_jwt) → zcode ✓
opencode(api_key) → opencode ✓
```

### 5. ⚠️ 选号未按供应商过滤

**现象**：一个「有 cline 账号、没有 workbuddy 账号」的部署，
会把 cline 的凭据拿去打 WorkBuddy 的端点 → 上游 401
（看起来像「凭据坏了」，实际是选错了账号）。

**修法**：`pick()` 支持 `provider` 字段。

**⚠️ 修的时候踩了一个二阶坑**：第一版写法是「`pick()` 返回后再筛掉不是该家的」。
那会让「池里有账号但当前供应商没账号」表现为
**`pick()` 返回了号、调用方却拿不到人** → 被当成「没有可用账号」。
⇒ 过滤**必须在 `pick()` 内部**做，不能在返回后筛。

---

## 🎯 面板重做（3 → 8 个视图）

### 修掉「进去之后啥也干不了」

**问题**：没输密钥时页面**一片空白** —— 什么都不加载，用户以为坏了。

**修法**：显式区分三种状态，**无密钥时也渲染导航与引导卡片**：
- 未填密钥 → 显示「请先在右上角填入 API_KEY」卡片 + 视图骨架
- 密钥无效 → 同上（并明确说是密钥问题）
- 正常 → 加载数据

### 8 个视图

| 视图 | 内容 |
|---|---|
| 账号池 | 计数（总/可用/冷却/模型限流/禁用）+ 卡片（状态标签、冷却倒计时、成功/错误计数）+ 导入 + 登录 |
| 任务中心 | 单账号执行 daily/growth、**扫描全部账号待办**、**一键对全部账号跑 daily** |
| 用量 | 总请求/成功/失败/token/平均耗时 + **按小时柱状图** + 按模型 + 按账号 |
| 积分包 | 逐账号实时查上游余额（**串行**，避免放大风控） |
| 模型 | 模型目录表格 |
| 供应商 | **11 家能力矩阵** + 不可用原因 + 按供应商标识导入 |
| 配置 | 运行时状态（池计数、WAF 窗口与阈值、凭据数、cron 时点） |
| 日志 | 请求日志（环形缓冲）+ 清空 |

### 用量与日志的存储纪律

**不逐条写行**，而是**整条环形缓冲存在一个 storage key** 里
（`usage:ring` 500 条 / `log:ring` 200 条）。

理由：Free 计划 DO 行写入配额 **100,000/天**，而一次对话就产生一条记录 ——
逐行写会在正常使用下撞配额。要的是**近期趋势**，不是审计账本。

> ⚠️ 截断必须**按时间排序后再截**：写入顺序 ≠ 时间顺序（并发请求完成有先后），
> 直接 `slice(-N)` 可能丢掉更新的记录而留下旧的。

---

## 🔒 安全（新增部分）

- **CSP 保持严格**（无 `unsafe-inline`）：JS 走独立文件；新增单测**静态检查**
  HTML 无内联脚本、CSP 无 `unsafe-inline`。
- **不用 cookie**：密钥存 localStorage、每请求带 `Authorization` 头
  （cookie 会自动附带，需额外 CSRF 防护；`Authorization` 头不会）。
- **不把上游 URL 拼进 `innerHTML`**：授权链接用 `document.createElement` 构造。
- **PKCE verifier 绝不回给前端**：`/admin/providers/login/start` 只回
  `{authUrl, state}`，verifier 存在 DO 里（已实测确认不泄漏）。
- **前端不出现 `innerHTML` 赋值**（单测静态检查）。

---

## ⚠️ 刻意不做 / 仍未消除（诚实记录）

| 项 | 原因 | 状态 |
|---|---|---|
| **codearts / lobsterai / trae 的登录** | 需 `127.0.0.1:<port>` 本地回调监听，Workers **没有监听 socket**。且三家都**没有轮询替代路径**（codearts 的 `secret` 只能从回调拿到；trae 的令牌直接放在回调 query 里） | 只能导入凭据 |
| **zcode 签到** | `billing/claim` **始终**索要阿里云 captcha，需 **headful** Chromium（`--headless=new` 实测过不了风控） | 推理不受影响 |
| **raccoon 短信登录** | 需阿里云滑块 `captcha_param` | 仅扫码可用 |
| **opencode 每账号代理** | 参考实现用 undici + 自实现 SOCKS5；Workers 的 `fetch` 不接受 `dispatcher` | **真实功能损失**：多个匿名槽共享同一出口 IP，免费额度**不再能通过多开扩容** |
| **minimax / loomy 登录未接线** | 协议可移植（或函数已实现），但本服务未实现发起流程 | 已**如实声明** `login: false` |
| **cline 设备码登录** | ✅ 已接线（WorkOS 三步：设备码 → 轮询 → `/api/v1/auth/register`）。⚠️ 轮询状态（间隔/下次轮询时刻/期限）**持久化在登录会话载荷**里 —— 面板每 3 秒发独立请求，Workers 无跨请求内存 | 已实现 |
| **流内换号**（trae / lobsterai） | 需先消费整个 SSE 才能决定重发，而本项目逐帧透传（10ms CPU 铁律） | 流内错误转成错误帧；换号由 HTTP 状态驱动 |

---

## 复现验证

```bash
npm run typecheck && npm test        # 231 条

BASE=https://<你的域名>; KEY=<API_KEY>
curl -s -H "Authorization: Bearer $KEY" "$BASE/admin/providers" | jq '.providers | length'   # 11
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" | jq '.data | length'              # 108（54 裸名 + 54 前缀）
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"provider":"qoder"}' "$BASE/admin/providers/login/start"                              # 设备码登录
```
