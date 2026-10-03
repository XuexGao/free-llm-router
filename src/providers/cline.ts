/**
 * Cline 供应商适配器（OpenAI 兼容协议）。
 *
 * ## 本供应商与 WorkBuddy 的差异（三处，都会踩）
 *
 * 1. **鉴权头是 `Bearer workos:<jwt>`，前缀不可剥**（见 {@link clineBearerValue}）；
 * 2. **思考字段是 `delta.reasoning`**（不是 `reasoning_content`，
 *    见参考 `openai-compat.ts:24-26` 与 `:781-788`）—— 本层只转发原始
 *    `Response`，不需要解析，故这里**只记录事实**，由网关的流翻译负责；
 * 3. **模型目录来自两个端点**（`recommended-models` 给免费集合、`/models`
 *    给全量 id），且**必须合并内嵌兜底表** —— 单打任一端点都会得到错误目录。
 *
 * ## 数据来源（全部为参考项目对本机 Cline 桌面端的逆向 + 实测）
 *
 * - 端点与客户端头：`src/cline-product.ts:262-307`；
 * - 前缀陷阱：`src/cline.ts:159-182`、`AGENTS.md` 的「坑 1」；
 * - 目录合并与免费判定：`src/cline-models.ts:20-35`、`:192-235`；
 * - 余额与签到事实：`src/cline-credits.ts:5-56`、`src/cline-quota.ts`。
 *
 * ## 登录（本轮**不实现**，但状态机已定，供后续 `loginStart`/`loginPoll` 照抄）
 *
 * Cline 走 **WorkOS 设备码轮询**（无本地回调监听 ⇒ 可在 Workers 跑，
 * 故 `capabilities.login = true`）。三步（`src/cline-oauth.ts:18-38`）：
 *
 * ```
 * 1) POST {workOsBase}/user_management/authorize/device   body: client_id=…
 *    → { device_code, user_code, verification_uri, verification_uri_complete,
 *        expires_in, interval }
 * 2) 轮询 POST {workOsBase}/user_management/authenticate
 *    body: grant_type=urn:ietf:params:oauth:grant-type:device_code
 *          &device_code=…&client_id=…
 *    → 200 { access_token, refresh_token }  |  错误体 { error: "…" }
 * 3) POST {apiBase}/api/v1/auth/register  body: { accessToken, refreshToken }
 *    → { success, data: { accessToken, refreshToken, expiresAt, tokenInfo… } }
 * ```
 *
 * ⚠️ **实现时必须照抄的五个判据**（都来自实测，写错会得到极难排查的失败）：
 *
 * 1. **`authorization_pending` 是响应体的 `error` 字段，不是 HTTP 状态码**
 *    （`src/cline-oauth.ts:40-44`）。按状态码判失败会把「用户还没点授权」
 *    误报成登录失败 —— 与 Qoder「404 = 尚未授权」同型，但判据形态完全不同。
 * 2. **`slow_down` 必须累积退避**：`intervalMs += 1000` 后**继续**轮询，
 *    而不是重置回原间隔（源码 `intervalSeconds += 1`，`cline-oauth.ts:227-229`）。
 *    用固定间隔会在服务端要求降速后持续被限流。
 * 3. 终态只有 `access_denied` / `expired_token` / `invalid_grant`
 *    （`cline-oauth.ts:279-286`），其余非 2xx 也是终态失败。
 * 4. 轮询间隔**下限 1 秒**（服务端可能下发 0 或负数），网络失败容忍
 *    **5 次连续失败**（`cline-oauth.ts:236-302`）。
 * 5. 注册响应的 `accessToken` **自带 `workos:` 前缀**，仍要幂等补齐
 *    （`cline-oauth.ts:408-412`）。
 *
 * ## 本轮刻意不做的事（避免「假装支持」）
 *
 * - **不解析 SSE**：`chat()` 返回上游原始 `Response`，由网关逐帧透传
 *   （Workers Free 只有 10ms CPU，这一层禁止缓冲，见 `gateway/stream.ts` 头注释）；
 * - **不做 token 续期**：`Provider` 接口没有续期方法，凭据过期由调用方重新导入
 *   （续期协议是 `POST /api/v1/auth/refresh` + 驼峰 `{refreshToken, grantType}`，
 *   见 `src/cline.ts:250-268` —— 将来加时要照抄这两个**非标准**字段名）。
 */

import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

// ─────────────────────────── 协议常量 ───────────────────────────

/** 供应商 id（注册表键、`provider/model` 前缀）。 */
const ID = 'cline'

/**
 * API 基址（`src/cline-product.ts:265` 的 `CLINE.apiBase`）。
 *
 * 推理、模型目录、账号信息、注册与续期**全部**挂它下面；只有 WorkOS
 * 设备码那两个端点挂 `https://api.workos.com`（本文件暂不涉及）。
 */
const API_BASE = 'https://api.cline.bot'

/** 推理路径（标准 OpenAI 兼容，实测标准 SSE）。 */
const CHAT_PATH = '/api/v1/chat/completions'
/** 全量模型 id 列表（**需要认证**，460 个条目、只有 id，无 name/上下文）。 */
const MODELS_PATH = '/api/v1/models'
/** 推荐模型（含**唯一权威的 `free` 数组**，**不需要认证**）。 */
const RECOMMENDED_MODELS_PATH = '/api/v1/ai/cline/recommended-models'

/** 单次目录请求超时（对齐参考 `CLINE_MODELS_TIMEOUT_MS = 20_000`）。 */
const MODELS_TIMEOUT_MS = 20_000
/** 单次余额请求超时（对齐参考 `CLINE_CREDITS_TIMEOUT_MS = 30_000`）。 */
const BALANCE_TIMEOUT_MS = 30_000

/**
 * 访问令牌前缀。**必须原样保留**。
 *
 * 官方 `resolveApiKey` 原样使用存储值，而 Cline 磁盘上存的就是 `workos:eyJ…`；
 * 该前缀只在**解码 JWT** 时被剥掉（`decodeJwtPayload(token.replace(/^workos:/, ""))`），
 * **从不出现在请求头构造里**（`src/cline-product.ts:99-113`）。
 *
 * ⚠️ 实测（同一凭据，`src/cline.ts:167-172`）：
 * - `Authorization: Bearer workos:eyJ…` → `/api/v1/users/me` **200**
 * - `Authorization: Bearer eyJ…`（剥掉前缀）→ **401**
 *
 * 该 401 的文案是 "make sure you're using the latest version of Cline" ——
 * 与真实原因**毫不相干**，剥前缀会让人误判成「客户端版本过旧」。
 */
const TOKEN_PREFIX = 'workos:'

/**
 * 客户端标识头（`src/cline-product.ts:269-274` 的 `DEFAULT_CLINE_REQUEST_HEADERS`）。
 *
 * ⚠️ **推理与账号端点都带上**：只带 `Authorization` 实测虽可通，但这些头是官方
 * 客户端的身份声明，缺失可能在某些网关策略下被拒或降级，故照官方原样下发。
 */
const CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
}

/**
 * 余额原始值的换算系数。
 *
 * ⚠️ **这是全模块唯一的不确定点**（`src/cline-credits.ts:25-79`）：实测
 * `balance: 500000`，按 1e-5 解释为 $5.00（与 Cline 新账号赠额量级一致）。
 * 参考实现把系数收敛为单个具名常量，这里沿用 —— 若核对后单位不同，
 * **只改这一个常数**，不要在别处再写换算。
 */
const BALANCE_SCALE = 100_000

// ─────────────────────────── 小工具 ───────────────────────────

/** 数组/null 一律不当对象（避免把 `[]` 当记录读）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 从记录里读第一个非空字符串字段（去空白）。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 沿嵌套路径读非空字符串（路径上任一层不是对象即返回 undefined）。 */
function readNested(
  source: Record<string, unknown>,
  path: readonly string[],
  keys: readonly string[],
): string | undefined {
  let current: Record<string, unknown> | undefined = source
  for (const segment of path) {
    if (current === undefined) return undefined
    current = asRecord(current[segment])
  }
  return current === undefined ? undefined : readString(current, keys)
}

/** 读有限数字（同时接受数字字符串 —— 上游改型不该让整块失效）。 */
function readNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * 把各种时间形态归一为**毫秒**时间戳。
 *
 * `expiresAt` 实测是 **ISO 8601 字符串**（`src/cline.ts:81-99`），但数字形态
 * （秒 / 毫秒）也要认：上游格式一变就整块失效，不值得。
 */
export function parseClineTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 1e12 毫秒 ≈ 2001 年；1e12 秒 ≈ 33658 年 —— 分界足够安全。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim()
    // 纯数字串也按上面的口径处理（`"1700000000"` 这种形态真的出现过）。
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed < 1e12 ? Math.round(parsed * 1000) : Math.round(parsed)
      }
      return undefined
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** base64url → UTF-8 文本；失败返回 undefined（**绝不让它抛进主流程**）。 */
function base64UrlToText(segment: string): string | undefined {
  try {
    const normalized = segment.replaceAll('-', '+').replaceAll('_', '/')
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(normalized + padding)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** 解出 JWT 载荷（仅用于读 `sub` / `email` / `exp`，**不参与鉴权**）。 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (payload === undefined || payload.length === 0) return undefined
  const text = base64UrlToText(payload)
  if (text === undefined) return undefined
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * 由令牌派生一个稳定的短主键（**仅兜底**）。
 *
 * ⚠️ 这里刻意用 FNV-1a 而不是 `crypto.subtle.digest`：
 * `parseCredential` 是**同步**接口（`types.ts:152`），而 WebCrypto 只有异步
 * API —— 在同步函数里拿不到它。该值**只作本地主键**（不鉴权、不上行、
 * 不参与任何安全判定），令牌本身仍只存在 `accessToken` 字段里（由存储层加密）。
 */
function stableKeyOf(secret: string): string {
  // 两轮不同 offset 的 FNV-1a 拼成 16 位 hex，降低取号时的碰撞概率。
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < secret.length; i += 1) {
    const code = secret.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
  }
  return `cline-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

// ─────────────────────── 令牌与请求头（协议核心） ───────────────────────

/**
 * 确保访问令牌带 `workos:` 前缀（**幂等补齐**，不是无脑加）。
 *
 * ⚠️ **这是本供应商最容易踩的坑**（细节见 {@link TOKEN_PREFIX} 的注释）。
 * 之所以实现为「缺了才补」而不是「强制加」：服务端下发时**自带**前缀
 * （源码 `toClineCredentials` 直接 `access = responseData.accessToken`），
 * 正常路径下 `startsWith` 即命中；补前缀分支是为了对「上游某天改回不带前缀」
 * 保持鲁棒（实测续期返回的就是**裸** JWT，见 `AGENTS.md:2761-2763`）。
 */
export function clineBearerValue(accessToken: string): string {
  const token = accessToken.trim()
  if (token.length === 0) return ''
  return token.startsWith(TOKEN_PREFIX) ? token : `${TOKEN_PREFIX}${token}`
}

/** 构造鉴权与身份头（`Authorization` 用**带前缀**的值）。 */
function clineHeaders(accessToken: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${clineBearerValue(accessToken)}`,
    Accept: 'application/json',
    ...CLIENT_HEADERS,
    ...extra,
  }
}

/** 凭据里的访问令牌（缺了就抛错 —— 不让空令牌去打上游换一个莫名其妙的 401）。 */
function accessTokenOf(credential: ProviderCredential): string {
  const token = credential.accessToken.trim()
  if (token.length === 0) {
    throw new ProviderError({
      provider: ID,
      message: 'Cline 凭据缺少访问令牌（accessToken），请重新导入或登录',
    })
  }
  return token
}

/** 凭据里的 Cline 账号 id（`usr-…`；余额端点必须要它）。 */
function accountIdOf(credential: ProviderCredential): string | undefined {
  const value = credential.extras.accountId
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined
}

// ─────────────────────────── 凭据解析 ───────────────────────────

/**
 * 从用户粘贴的任意形状里解析出 Cline 凭据。
 *
 * ## 认识的形态（都来自真实产物）
 *
 * ```jsonc
 * // ① 官方桌面端 `~/.cline/data/settings/providers.json`（驼峰）
 * { "accessToken": "workos:eyJ…", "refreshToken": "tmgEeM…",
 *   "expiresAt": "2026-09-25T05:23:47.000Z",
 *   "accountId": "usr-01M3BCV4FYCGJKAWD3MJG3DBQM", "email": "…" }
 *
 * // ② 本插件/DSH 形态（蛇形）
 * { "access_token": "workos:eyJ…", "refresh_token": "…", "expire_time": 1790000000000,
 *   "account_id": "usr-…", "email": "…", "nickname": "…" }
 *
 * // ③ 嵌套形态（插件导出的整包 / 续期响应信封）
 * { "auth": { "accessToken": "…" }, "account": { "uid": "usr-…" } }
 * { "success": true, "data": { "accessToken": "…", "userInfo": { "clineUserId": "usr-…" } } }
 *
 * // ④ 只粘贴一个令牌字符串（裸 JWT 或 `workos:` 前缀串）
 * "workos:eyJ…"
 * ```
 *
 * ## 为什么宽容，又为什么严格
 *
 * - **宽容**：Cline 的凭据在不同入口（官方 providers.json / 本插件 / 续期响应）
 *   字段命名不一致，只认一种会让用户「导入成功但字段全空」；
 * - **严格**：**访问令牌绝不用空串兜底** —— 那会产出一份永远 401 的凭据，
 *   而 401 的文案（"use the latest version of Cline"）指向完全错误的方向。
 *
 * ## ⚠️ `uid` 的取值口径（会决定余额能不能查）
 *
 * 优先 **`account_id` / `clineUserId`（`usr-…`）**，因为余额端点
 * `/api/v1/users/{userId}/balance` **只认它**；传 JWT 的 `sub`
 * （`user_01M3…`）实测返回 `400 {"error":"Invalid request format"}`
 * （`src/cline-credits.ts:15-18`）—— 两者形态完全不同，极易混用。
 *
 * 只有在拿不到 `usr-…` 时才退回 JWT 的 `sub` / `email` / 令牌派生值：
 * 那样**对话仍可用**，但余额会明确报「凭据缺少账号 id」而不是给一个假的 0。
 */
/**
 * 一个字符串**像不像**真实的 Cline 访问令牌。
 *
 * ## ⚠️ 这个闸门是必须的（实测踩到）
 *
 * 原先「任意非空字符串即当作令牌」，后果有两层：
 *
 * 1. **产生必然 401 的假账号**：用户误粘贴一段文字（或把别的供应商的令牌
 *    粘错地方）会「导入成功」，但一用就 401，且错误来自上游、看不出根因。
 * 2. **破坏自动识别**：`parseCredentialAnywhere` 按顺序试各家，
 *    cline 这条「什么都收」的分支会把**所有**字符串输入吞掉，
 *    导致别的供应商（乃至错误提示）永远轮不到。
 *
 * 真实令牌的形状（二选一）：
 * - 带 `workos:` 前缀（服务端下发的形态，见文件头）；
 * - JWT：`header.payload.signature` 结构（三段、首段 base64url 解出 `{`）。
 *
 * 这里刻意**只做形状判别、不校验签名** —— 目的是挡住明显的误粘贴，
 * 不是做安全边界（真正的验证由上游完成）。
 */
function looksLikeClineToken(raw: string): boolean {
  const t = raw.trim()
  if (t.length < 20) return false
  if (t.startsWith('workos:')) return t.length > 'workos:'.length + 20
  const parts = t.split('.')
  const header = parts[0]
  if (parts.length !== 3 || header === undefined || header === '') return false
  // JWT 首段必是 base64url 编码的 JSON 头（以 `{` 开头）
  try {
    const padded = header.replace(/-/g, '+').replace(/_/g, '/')
    return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)).startsWith('{')
  } catch {
    return false
  }
}

export function parseCredential(input: unknown): ProviderCredential {
  // 形态 ④：直接把令牌当字符串粘贴。
  if (typeof input === 'string') {
    // ⚠️ 必须是**看起来像令牌**的字符串（理由见 looksLikeClineToken）。
    // 否则抛错让其它供应商（或明确的错误提示）接手。
    if (!looksLikeClineToken(input)) {
      throw new ProviderError({
        provider: ID,
        message:
          'Cline 凭据字符串不像访问令牌（应为带 `workos:` 前缀的值，或三段式 JWT）。'
          + '请粘贴完整凭据 JSON，或官方 `providers.json` 里的 `accessToken`。',
      })
    }
    const token = clineBearerValue(input)
    return buildCredential(token, undefined, undefined, undefined, undefined)
  }

  const record = asRecord(input)
  if (record === undefined) {
    throw new ProviderError({
      provider: ID,
      message: 'Cline 凭据必须是一个 JSON 对象或令牌字符串（可粘贴官方 providers.json 里的条目）',
    })
  }

  const accessTokenRaw =
    readString(record, ['accessToken', 'access_token', 'access', 'token', 'apiKey', 'api_key'])
    ?? readNested(record, ['auth'], ['accessToken', 'access_token', 'access', 'token'])
    ?? readNested(record, ['credentials'], ['accessToken', 'access_token', 'access', 'token'])
    ?? readNested(record, ['data'], ['accessToken', 'access_token', 'access', 'token'])
    ?? readNested(record, ['data', 'credentials'], ['accessToken', 'access_token'])
    ?? readNested(record, ['auth', 'auth'], ['accessToken', 'access_token'])

  if (accessTokenRaw === undefined) {
    throw new ProviderError({
      provider: ID,
      message:
        '未能从凭据里读到 Cline 访问令牌（`accessToken` / `access_token` / `token`）。'
        + '请粘贴 `~/.cline/data/settings/providers.json` 里的 `accessToken`，'
        + '或本插件登录后导出的完整凭据 JSON。',
    })
  }

  // ⚠️ 读到了令牌也要校验**形状**（与字符串分支同一判据）。
  // 不校验的后果：`{accessToken:'x'}` 会被收下，产出一个永远 401 的账号，
  // 而用户看到的是「导入成功」—— 失败被推迟到第一次用它的时候。
  if (!looksLikeClineToken(accessTokenRaw)) {
    throw new ProviderError({
      provider: ID,
      message:
        `读到 Cline 访问令牌但形状不合法（长度 ${accessTokenRaw.trim().length}，`
        + '应以 `workos:` 开头或是三段式 JWT）。'
        + '常见原因：粘贴了别的供应商的凭据，或字段名对但值被截断。',
    })
  }

  const accountId =
    readString(record, ['accountId', 'account_id', 'clineUserId', 'cline_user_id', 'userId', 'user_id', 'uid'])
    ?? readNested(record, ['account'], ['uid', 'accountId', 'account_id', 'clineUserId'])
    ?? readNested(record, ['userInfo'], ['clineUserId', 'accountId', 'id'])
    ?? readNested(record, ['data', 'userInfo'], ['clineUserId', 'accountId', 'id'])
    ?? readNested(record, ['data'], ['accountId', 'account_id', 'clineUserId'])
    ?? readNested(record, ['auth', 'account'], ['uid', 'accountId'])

  const refreshTokenRaw =
    readString(record, ['refreshToken', 'refresh_token', 'refresh'])
    ?? readNested(record, ['auth'], ['refreshToken', 'refresh_token'])
    ?? readNested(record, ['data'], ['refreshToken', 'refresh_token'])

  const email =
    readString(record, ['email', 'mail'])
    ?? readNested(record, ['userInfo'], ['email'])
    ?? readNested(record, ['data', 'userInfo'], ['email'])
    ?? readNested(record, ['account'], ['email'])

  const nickname =
    readString(record, ['nickname', 'displayName', 'name', 'username'])
    ?? readNested(record, ['userInfo'], ['name', 'displayName', 'firstName'])
    ?? readNested(record, ['account'], ['nickname', 'name'])

  const expiresRaw =
    readNumber(record, ['expiresAt', 'expires_at', 'expire_time', 'expireTime', 'expiry'])
    ?? readNumber(asRecord(record.auth) ?? {}, ['expiresAt', 'expires_at', 'expire_time'])
    ?? readNumber(asRecord(record.data) ?? {}, ['expiresAt', 'expires_at', 'expire_time'])
  // 时间字段也可能是 ISO 字符串，`readNumber` 拿不到时再走通用解析。
  const expiresAt = expiresRaw !== undefined
    ? parseClineTimestamp(expiresRaw)
    : parseClineTimestamp(record.expiresAt ?? record.expires_at ?? record.expire_time)

  return buildCredential(
    clineBearerValue(accessTokenRaw),
    accountId,
    refreshTokenRaw,
    expiresAt,
    { email: email ?? '', nickname: nickname ?? '' },
  )
}

/** 把解析出的碎片组装成 `ProviderCredential`（uid 的兜底链在这里收口）。 */
function buildCredential(
  accessToken: string,
  accountId: string | undefined,
  refreshToken: string | undefined,
  expiresAt: number | undefined,
  profile: { email: string; nickname: string } | undefined,
): ProviderCredential {
  // JWT 只用来补元数据（sub / email / exp），**绝不参与鉴权**。
  const claims = decodeJwtClaims(accessToken.replace(/^workos:/, ''))
  const jwtSub = claims === undefined ? undefined : readString(claims, ['sub'])
  const jwtEmail = claims === undefined ? undefined : readString(claims, ['email'])
  const jwtExp = claims === undefined ? undefined : readNumber(claims, ['exp'])

  // ⚠️ **绝不能产出空 uid**：uid 同时是存储主键与面板标识，空串会让所有
  // 「没有 accountId」的账号**塌成同一条记录**（后导入的覆盖先导入的）。
  //
  // ⚠️ 这里**必须**逐项判非空，不能写成 `accountId ?? jwtSub ?? profile?.email ?? …`：
  // 那个写法在 `profile.email` 是**空串**时（调用方传的就是 `''`）不会继续回落
  // —— `??` 只挡 `null`/`undefined`，空串是「有值」—— 于是 uid 恒为空串。
  // 这是实测出来的真实缺陷，不是理论风险。
  const candidates = [accountId, jwtSub, profile?.email, jwtEmail]
  let uid = ''
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) {
      uid = candidate
      break
    }
  }
  if (uid === '') uid = stableKeyOf(accessToken)

  const email = profile?.email !== undefined && profile.email.length > 0
    ? profile.email
    : (jwtEmail ?? '')
  const nickname = profile?.nickname !== undefined && profile.nickname.length > 0
    ? profile.nickname
    : (email.length > 0 ? email : uid)

  // 过期时间优先用显式字段；没有再退回 JWT 的 `exp`（秒）。
  const resolvedExpiry = expiresAt ?? (jwtExp !== undefined ? parseClineTimestamp(jwtExp) : undefined)

  return {
    provider: ID,
    uid,
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAt: resolvedExpiry ?? 0,
    nickname,
    // ⚠️ `accountId` 缺失时**留空**而不是填 uid：余额端点要的是 `usr-…`，
    // 填一个 JWT 的 `user_…` 进去只会换来一个 400，不如让 `balance()` 明确报错。
    extras: { accountId: accountId ?? '', email },
  }
}

// ─────────────────────────── 模型目录 ───────────────────────────

/** 兜底目录条目（内嵌 `BUILTIN_MODEL_CATALOG.cline` 段）。 */
interface FallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
  isFree: boolean
}

/**
 * 内嵌兜底目录（`src/cline-product.ts:146-204`）。
 *
 * ⚠️ 本表**只是兜底**，且**不足以覆盖免费集合**：它原本缺
 * `cline-free/gemini-3.8-flash`（远端 `free` 数组有），参考实现已手工补进表里，
 * 这里照抄（否则离线时用户看不到那个模型）。
 *
 * ⚠️ `gemini-3.8-flash` 的输出上限是 **65536**，**不要**照抄其它免费模型的
 * 131072：给该模型发 `max_tokens=131072` 会被上游 vertex provider 以 400 拒绝
 * （`supported range is from 1 (inclusive) to 65537 (exclusive)`）。
 */
const FALLBACK_MODELS: readonly FallbackModel[] = [
  {
    id: 'stealth/space-bunny-alpha',
    name: 'Space Bunny Alpha',
    contextWindow: 1_000_000,
    maxTokens: 524_288,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: true,
    isFree: true,
  },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    supportsImage: true,
    isFree: true,
  },
]

/** 一个目录条目（兜底与远端共用形状）。 */
interface CatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxOutput: number
  supportsImage: boolean
  isFree: boolean
}

/** `recommended-models` 里的一个条目。 */
interface RecommendedEntry {
  id: string
  name?: string
}

/** 解析后的 `recommended-models`（`clinePass` **不是**免费集合）。 */
interface RecommendedModels {
  free: RecommendedEntry[]
  recommended: RecommendedEntry[]
  clinePass: RecommendedEntry[]
}

/**
 * 免费模型 id 的**后缀**约定（内嵌目录里的 `:free` 条目）。
 *
 * ⚠️ 用**后缀**而非 `includes(':free')`：`openrouter/free` 这类 id 不含冒号，
 * 而 `nvidia/…-reasoning:free` 含。后缀判定恰好覆盖两者，且不会误伤
 * `foo:freebar`（`src/cline-models.ts:68-77`）。
 */
const FREE_ID_SUFFIX = ':free'
/** 免费模型 id 的**前缀**约定（`cline-free/` 命名空间）。 */
const FREE_ID_PREFIX = 'cline-free/'

/**
 * 判定某 id 是否免费（并集，**不硬编码模型名**）。
 *
 * ```
 * isFree = 远端 free 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表 isFree
 * ```
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
 * `deepseek/deepseek-v4.1-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 deepseek」这类模糊匹配 —— 那会让用户按免费预期使用却被计费。
 */
function isFreeModel(id: string, remoteFreeIds: ReadonlySet<string>, fallback?: FallbackModel): boolean {
  if (remoteFreeIds.has(id)) return true
  if (id.endsWith(FREE_ID_SUFFIX)) return true
  if (id.startsWith(FREE_ID_PREFIX)) return true
  return fallback?.isFree === true
}

/** 把远端 id 派生为可读兜底展示名（远端只给 id 时用）。 */
function nameFromId(id: string): string {
  const slash = id.indexOf('/')
  const tail = slash >= 0 ? id.slice(slash + 1) : id
  return tail
    .replace(FREE_ID_SUFFIX, '')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** 把远端数组归一（丢弃无 id 的垃圾项）。 */
function parseEntryList(value: unknown): RecommendedEntry[] {
  if (!Array.isArray(value)) return []
  const out: RecommendedEntry[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (record === undefined) continue
    const id = readString(record, ['id'])
    if (id === undefined) continue
    const name = readString(record, ['name'])
    out.push({ id, ...(name === undefined ? {} : { name }) })
  }
  return out
}

/**
 * 解析 `recommended-models` 响应（`{recommended[], free[], clinePass[]}`）。
 *
 * ⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型（`cline-pass/*`），
 * 按订阅额度计费而非免费，把它当免费会误导用户（`src/cline-models.ts:151-153`）。
 * 这里仍然收录它的**条目**（保证模型可被发现），但 `isFree` 一律为 false
 * —— 判定完全由 {@link isFreeModel} 的并集决定，与它来自哪个数组无关。
 */
function parseRecommendedModels(value: unknown): RecommendedModels {
  const record = asRecord(value)
  if (record === undefined) return { free: [], recommended: [], clinePass: [] }
  return {
    free: parseEntryList(record.free),
    recommended: parseEntryList(record.recommended),
    clinePass: parseEntryList(record.clinePass),
  }
}

/** 解析 `/api/v1/models` 响应（`{data: [{id,…}]}`），取出 id 列表。 */
function parseRemoteModelIds(value: unknown): string[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const data = record.data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const id = readString(entry, ['id'])
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/**
 * 合并三个来源为最终目录（顺序即展示顺序，`src/cline-models.ts:192-235`）。
 *
 * 1. **远端 `free` 数组在前**（用户最关心，且远端本身有序）；
 * 2. 兜底表（含补进去的 `gemini-3.8-flash`，离线时也可见）；
 * 3. `recommended` / `clinePass` 里新出现的条目；
 * 4. 远端 `/models` 的其余 id（**放最后**：它们只有裸 id、无元数据，且多达 460 个，
 *    放前面会把免费模型挤到看不见）。
 *
 * 元数据优先级：兜底表（有窗口 / 输出上限 / 图片能力）> 远端 `name` > 由 id 派生。
 */
function mergeCatalog(input: {
  freeIds: readonly string[]
  remoteIds: readonly string[]
  entries: readonly RecommendedEntry[]
}): CatalogEntry[] {
  const fallbackIndex = new Map(FALLBACK_MODELS.map((model) => [model.id, model]))
  const nameIndex = new Map(input.entries.map((entry) => [entry.id, entry.name]))
  const remoteFreeIds = new Set(input.freeIds)
  const seen = new Set<string>()
  const out: CatalogEntry[] = []

  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const fallback = fallbackIndex.get(id)
    const remoteName = nameIndex.get(id)
    out.push({
      id,
      name: fallback?.name ?? remoteName ?? nameFromId(id),
      // 未知时给 0（=「不知道」），**不编造**数值 —— 编造会让客户端算出错误的上下文预算。
      contextWindow: fallback?.contextWindow ?? 0,
      maxOutput: fallback?.maxTokens ?? 0,
      supportsImage: fallback?.supportsImage === true,
      isFree: isFreeModel(id, remoteFreeIds, fallback),
    })
  }

  for (const id of input.freeIds) push(id)
  for (const model of FALLBACK_MODELS) push(model.id)
  for (const entry of input.entries) push(entry.id)
  for (const id of input.remoteIds) push(id)

  return out
}

/**
 * 拉取模型目录（两个远端端点 + 内嵌兜底表）。
 *
 * ⚠️ **两个端点必须都打，且各自独立容错**：
 * - `recommended-models` 是**唯一权威的免费集合**（`/models` 的 460 个 id 里
 *   `cline-free/*` **零命中**）—— 只调 `/models` 会「一个免费模型都看不到」；
 * - `/models` 提供全量 id —— 只调 `recommended-models` 会看不到绝大多数模型。
 *
 * 任一端点失败不使另一端失效（目录服务抖动不该让模型列表整个消失）；
 * **两个都失败**才抛错：此时只剩 5 条兜底表，用它冒充「目录」正是本项目
 * 最忌讳的静默失败形态（`types.ts` 的「不假装支持」）。
 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const token = accessTokenOf(credential)
  const failures: string[] = []

  const recommendedPromise = (async (): Promise<RecommendedModels> => {
    try {
      const res = await fetch(`${API_BASE}${RECOMMENDED_MODELS_PATH}`, {
        method: 'GET',
        // 该端点**不需要认证**（实测匿名 200），故只带身份头。
        headers: { Accept: 'application/json', ...CLIENT_HEADERS },
        signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
      })
      if (!res.ok) {
        failures.push(`recommended-models http=${res.status}`)
        return { free: [], recommended: [], clinePass: [] }
      }
      return parseRecommendedModels(await res.json())
    } catch (error) {
      failures.push(`recommended-models ${error instanceof Error ? error.message : String(error)}`)
      return { free: [], recommended: [], clinePass: [] }
    }
  })()

  const modelsPromise = (async (): Promise<string[]> => {
    try {
      const res = await fetch(`${API_BASE}${MODELS_PATH}`, {
        method: 'GET',
        headers: clineHeaders(token),
        signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
      })
      if (!res.ok) {
        failures.push(`models http=${res.status}`)
        return []
      }
      return parseRemoteModelIds(await res.json())
    } catch (error) {
      failures.push(`models ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })()

  const [recommended, remoteIds] = await Promise.all([recommendedPromise, modelsPromise])

  if (recommended.free.length === 0 && recommended.recommended.length === 0
    && recommended.clinePass.length === 0 && remoteIds.length === 0) {
    throw new ProviderError({
      provider: ID,
      httpStatus: 502,
      message: `Cline 模型目录两个来源都失败：${failures.join('；')}`,
    })
  }

  const catalog = mergeCatalog({
    freeIds: recommended.free.map((entry) => entry.id),
    remoteIds,
    entries: [...recommended.free, ...recommended.recommended, ...recommended.clinePass],
  })

  return catalog.map((entry) => ({
    id: entry.id,
    // ⚠️ 参考实现在展示名里拼 ` · 免费`，那是因为 DSH 的模型菜单**只渲染 name**。
    // 本项目不同：`ProviderModel` 有独立的 `isFree` 字段（`types.ts:101`），
    // 再由面板决定怎么显示 —— 拼进 name 会让同一信息出现两次。
    name: entry.name,
    contextWindow: entry.contextWindow,
    maxOutput: entry.maxOutput,
    supportsImage: entry.supportsImage,
    isFree: entry.isFree,
  }))
}

// ─────────────────────────── 对话 ───────────────────────────

/**
 * 发起流式对话，返回**上游原始响应**（由网关逐帧透传）。
 *
 * 与 WorkBuddy 的区别：Cline 是**标准 OpenAI 兼容端点**，请求体不需要那 4 处
 * 改写（`max_completion_tokens` / `tool_choice` 对象形式 / `stream_options` 都由
 * 官方端点自行处理），故这里只做两件事：
 *
 * 1. **把 `model` 覆写成路由解出的裸模型名**（网关传来的是 `cline/xxx` 拆开后的值）；
 * 2. **强制 `stream: true`**：网关恒定以 SSE 回客户端，若客户端传 `stream:false`，
 *    上游会回一个整体 JSON，而网关只认 `data:` 帧 —— 客户端会看到一坨裸 JSON
 *    且**永远等不到 `[DONE]`**（属于静默故障，必须在这一层堵住）。
 *
 * ⚠️ 非 2xx **抛 `ProviderError` 并带原文片段**，绝不把失败响应交给网关冒充成功流。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const token = accessTokenOf(credential)
  const body: Record<string, unknown> = { ...request.body, model: request.model, stream: true }

  const res = await fetch(`${API_BASE}${CHAT_PATH}`, {
    method: 'POST',
    headers: clineHeaders(token, {
      'Content-Type': 'application/json',
      // Cline 只支持 SSE（与官方客户端一致）。
      Accept: 'text/event-stream',
    }),
    body: JSON.stringify(body),
    signal: request.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `Cline 对话失败（http=${res.status}）：${detailOf(text)}`,
      retryable: shouldRotate(res.status, text),
    })
  }
  return res
}

/** 提取上游错误文案（Cline 的失败体是 `{error:"…", success:false}`，不是 OpenAI 的嵌套 error）。 */
function detailOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '(空响应体)'
  try {
    const record = asRecord(JSON.parse(trimmed))
    if (record !== undefined) {
      const text_ = readString(record, ['error', 'message', 'msg', 'detail', 'error_description'])
      if (text_ !== undefined) return text_
      const nested = asRecord(record.error)
      const nestedMessage = nested === undefined ? undefined : readString(nested, ['message'])
      if (nestedMessage !== undefined) return nestedMessage
    }
  } catch {
    // 不是 JSON（可能是 HTML 错误页）—— 直接用原文片段。
  }
  return trimmed.slice(0, 300)
}

/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy 系一致（429 频率限制 / 402 额度耗尽），外加文案兜底
 * （错误体里出现 credit / balance / quota 等词）。三条例外：
 * - **403 若是地域限制，换号无用**（`src/cline-adapter.ts:911-949` 记录的真实缺陷：
 *   该 403 与凭据无关，续期/换号都没用，只能换模型）；
 * - 5xx 是所有账号共用的服务端问题，换号无用；
 * - 400 是请求本身的问题。
 */
function shouldRotate(status: number, bodyText: string): boolean {
  if (status === 401) return true // 凭据问题：换号可能有效（本层不做续期）
  if (status === 403) return !isRegionForbidden(bodyText)
  if (status === 429 || status === 402) return true
  const lower = bodyText.toLowerCase()
  return CREDIT_MARKERS.some((marker) => lower.includes(marker))
}

/** 额度 / 限流文案标记（中英双通道）。 */
const CREDIT_MARKERS: readonly string[] = [
  'insufficient',
  'quota',
  'rate limit',
  'too many requests',
  'balance',
  'credit',
  'payment required',
  'exceeded',
  '积分不足',
  '额度不足',
  '余额不足',
  '频率限制',
  '超出限制',
]

/**
 * 是否是**与凭据无关**的访问限制（地域封锁）。
 *
 * ⚠️ 必须按**响应体文案**识别，不能按状态码一刀切：同一批 403 里既有真的凭据
 * 问题，也有地域限制。实测原文（`AGENTS.md` 的「坑 6」）：
 * `403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor is not
 * available in your region","success":false}`。
 */
function isRegionForbidden(bodyText: string): boolean {
  const lower = bodyText.toLowerCase()
  return REGION_MARKERS.some((marker) => lower.includes(marker))
}

/** 地域限制文案标记（小写比对）。 */
const REGION_MARKERS: readonly string[] = [
  'not available in your region',
  'access forbidden',
  'region not supported',
  'not available in your country',
]

// ─────────────────────────── 余额 ───────────────────────────

/**
 * 查询账户余额。
 *
 * `GET {API_BASE}/api/v1/users/{userId}/balance`
 * → `{ "data": { "userId": "usr-…", "balance": 500000 }, "success": true }`
 *
 * ⚠️ **`userId` 必须用凭据里的 `account_id`（`usr-…`），不能用 JWT 的 `sub`**：
 * 实测传 `sub`（`user_01M3…`）返回 `400 {"error":"Invalid request format"}`
 * （`src/cline-credits.ts:11-18`）。缺 `account_id` 时这里**明确抛错**，
 * 而不是拿 `uid` 去试一个必然失败的请求。
 *
 * ⚠️ **单位不确定**：按 {@link BALANCE_SCALE} 换算（见其注释）。失败形态两种都要认
 * ——业务层 `{success:false,error}` 与网关层 `{error}`（HTTP 401，**没有 `success`**），
 * 后者只在 `error` 里说明原因，丢掉它就丢掉了排查鉴权问题唯一的线索。
 */
async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const accountId = accountIdOf(credential)
  if (accountId === undefined) {
    throw new ProviderError({
      provider: ID,
      message:
        '凭据缺少 Cline 账号 id（形如 `usr-01M3…`），无法查询余额。'
        + '请重新导入官方 `providers.json`（其中的 `accountId` 字段）。',
    })
  }
  const token = accessTokenOf(credential)
  const res = await fetch(
    `${API_BASE}/api/v1/users/${encodeURIComponent(accountId)}/balance`,
    {
      method: 'GET',
      headers: clineHeaders(token),
      signal: AbortSignal.any([signal, AbortSignal.timeout(BALANCE_TIMEOUT_MS)]),
    },
  )

  const text = await res.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `Cline 余额响应不是 JSON（http=${res.status}）：${text.slice(0, 160)}`,
    })
  }
  const record = asRecord(parsed) ?? {}

  // 失败形态优先：`success:false` 或「带 error 且未声明成功」。
  const serverError = readString(record, ['error'])
  if (record.success === false || (serverError !== undefined && record.success !== true)) {
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `Cline 余额查询失败（http=${res.status}）：${serverError ?? detailOf(text)}`,
    })
  }
  if (!res.ok) {
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `Cline 余额查询失败（http=${res.status}）：${detailOf(text)}`,
      retryable: shouldRotate(res.status, text),
    })
  }

  const data = asRecord(record.data)
  const raw = data === undefined ? undefined : readNumber(data, ['balance'])
  if (raw === undefined) {
    throw new ProviderError({
      provider: ID,
      httpStatus: res.status,
      message: `Cline 余额响应缺少 data.balance 字段：${text.slice(0, 160)}`,
    })
  }

  const total = raw / BALANCE_SCALE
  return {
    total,
    expiring: 0,
    earliestExpiry: 0,
    // Cline 的余额是**单一数字**，没有资源包概念。给一个汇总条目，
    // 让面板的明细区显示「账户余额」而不是空白（与参考实现同口径）。
    packages: [{ name: 'Cline 账户余额', amount: total, expiry: 0 }],
  }
}

// ─────────────────────────── 导出 ───────────────────────────

export const clineProvider: Provider = {
  /**
   * 对象判别式：**只有 cline 独有的字段**才算命中。
   *
   * ⚠️ 刻意**不认** `uid` / `user_id` / `accessToken` 这些通用字段 ——
   * 那正是最初把 WorkBuddy 凭据抢走的原因（两者都有这些字段，
   * 且令牌都是三段式 JWT，形状无法区分）。
   *
   * 命中的判据（任一）：
   * - `workos:` 前缀的令牌（cline 独有）；
   * - `clineUserId` / `cline_user_id`（cline 独有字段名）；
   * - `accountId` + 令牌三段 JWT（cline 官方 providers.json 的形态）。
   */
  matchesShape(input) {
    const token = readString(input, ['accessToken', 'access_token', 'token', 'access', 'apiKey', 'api_key'])
    if (token !== undefined && token.startsWith('workos:')) return true
    if (readString(input, ['clineUserId', 'cline_user_id']) !== undefined) return true
    const accountId = readString(input, ['accountId', 'account_id'])
    return accountId !== undefined && token !== undefined && token.split('.').length === 3
  },

  /** 裸字符串判别式：`workos:` 前缀，或三段式 JWT（见 looksLikeClineToken）。 */
  bareStringPattern: /^(workos:[A-Za-z0-9._-]{20,}|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,

  id: ID,
  name: 'Cline',
  capabilities: {
    /**
     * ✅ WorkOS **设备码轮询**：无本地回调监听，天然适配 Workers
     * （`src/cline-oauth.ts:5-16`）。具体状态机见文件头注释。
     */
    /**
     * ⚠️ **本构建为 `false`，尽管协议本身支持设备码登录**。
     *
     * 诚实纪律（见 types.ts 的「不假装支持」）：`login` 的含义是
     * 「**本服务能发起这条登录流程**」，而不是「上游协议允许登录」。
     * cline 的 WorkOS 设备码三步（`src/cline-oauth.ts:18-38`）虽然可在
     * Workers 跑（无本地监听），但本项目的 `/admin/providers/login/*`
     * 目前只接线了 qoder 与 zcode —— 声 true 会让面板显示一个点了没反应的按钮。
     *
     * 用**导入凭据**即可正常使用（`~/.cline/data/settings/providers.json` 的
     * `accessToken`）。
     */
    login: false,
    loginBlockedReason:
      '本服务暂未接线 Cline 的设备码登录（协议支持，但未实现发起流程）。'
      + '请从 Cline 桌面端的 `providers.json` 复制 `accessToken` 后粘贴导入。',
    listModels: true,
    chat: true,
    /** ✅ 有真实余额端点 `/api/v1/users/{userId}/balance`（`src/cline-credits.ts`）。 */
    balance: true,
    /**
     * ❌ **Cline 没有每日签到**。
     *
     * 依据：参考项目对整份 sidecar 产物做过字符串扫描，`checkin` / `check-in` /
     * `daily` / `campaign` **均无任何 Cline 业务端点命中** —— 其中 `campaign`
     * 的命中是 PostHog 的 UTM 参数与 feature-flag 事件属性，`daily` 是 YAML
     * cron 别名与 Blob 导出频率枚举（`src/cline-credits.ts:46-55`）。
     * 参考实现据此把 `dailyCheckin` 登记为 false，本适配器一致。
     *
     * ⚠️ 留一句诚实的话：这是「某次全量扫描没看到」得出的结论，而本项目记录过
     * 「某次实测没看到 ≠ 不存在」的教训（Qoder 曾因此误判无签到）。若将来要改，
     * 必须**重新采集**（新版本 sidecar 全量扫描 + 真实端点验证），不要凭猜测打开。
     */
    checkin: false,
  },
  parseCredential,
  listModels,
  chat,
  balance,
  shouldRotate,
}
