/**
 * Raccoon Work（商汤小浣熊）供应商适配器。
 *
 * ## 协议速览
 *
 * | 用途 | 端点 | 认证 |
 * |---|---|---|
 * | 对话 | `POST {base}/api/web/llm/v2/chat/completions` | `Bearer` + `X-Org-Code` / `X-Raccoon-Language` |
 * | 模型目录 | `GET {base}/api/web/llm/v2/model_catalog` | 同上 |
 * | 余额（只读） | `GET {base}/api/web/points/v1/balance` | 同上 |
 * | 一次性登录奖励 | `POST {base}/api/web/desktop/v1/login/points/grant` | 同上 + **`X-Client-Platform`** |
 * | 扫码轮询 | `POST {base}/api/web/auth/v1/login_with_qrcode_code` | 无 |
 * | 续期 | `POST {base}/api/web/auth/v1/refresh` | 无（body 带 refresh_token） |
 *
 * ## 三个必须记住的坑（逐条来自实测）
 *
 * 1. **扫码的 `code` 由客户端自造**：官方桌面端靠 `office-raccoon://auth/callback`
 *    自定义协议回调，而 `/code/authorize` 页面的回调地址是**写死的**、改不成
 *    localhost。实测**任意自造 code 都被接受**并进入 `pending`，服务端只做轮询
 *    查询（`src/raccoon.ts:14-17`、`src/raccoon-oauth.ts:112-118`）。
 *    ⇒ 这就是「轮询式登录能在 Workers 上跑」的根据。**纯 HTTP**。
 * 2. **手机号必须 AES-128-CFB 加密**，密钥是公开常量 `senseraccoon2023`
 *    （`src/raccoon.ts:43,175-201`），输出 `Base64(iv ‖ ciphertext)`。
 *    加密错了上游回 `100003 params_encryted_error`。见 `aes-cfb.ts`。
 * 3. **短信登录路径在 Workers 上不可行**：`send_sms` 还要求阿里云滑块验证码的
 *    产物 `captcha_param`，缺了回 `100006 captcha_verify_error`
 *    （`src/raccoon-oauth.ts:186-188`）。滑块需要真实浏览器 ⇒ **只保留扫码路径**。
 *
 * ## 积分语义（诚实登记）
 *
 * | 来源 | 金额 | 触发 | 本适配器 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发 | 不涉及 |
 * | **桌面端登录奖励** | 3000 | `POST …/login/points/grant` | 见 `grantLoginReward`（**一次性**） |
 * | 每日积分 | 300 | **服务端按日自动发放，无端点** | ❌ 不存在可调用的端点 |
 *
 * ⚠️ 故 `capabilities.checkin = false`，而**不是** `true`。
 * 依据 `plugin-src/client/credits-capabilities.js:133`：
 * `raccoon: { balance: true, onboardingTasks: true }` —— 登记的是
 * **一次性** `onboardingTasks`，**没有** `dailyCheckin`。
 * 把每日 300 实现成签到按钮会让用户每次点击都必然失败
 * （`src/raccoon-credits.ts:10-18`）。
 *
 * ## ⚠️ 一次性奖励如何如实表达
 *
 * `Provider` 接口**没有** onboarding 方法。两个选择：
 *
 * - (a) 映射成 `checkin()` 并让 `capabilities.checkin = true` —— ❌ **不行**：
 *   `checkin` 的语义是「每天都有收益」，而该端点幂等一次性（已领过回
 *   `granted:false`）。声明成签到会让面板每天渲染一个必然无收益的按钮。
 * - (b) `checkin: false` + 把 `grantLoginReward` 作为**独立导出函数**暴露，
 *   并在本注释与能力位上写明。✅ **采用这个**。
 *
 * 这样「能力矩阵如实」与「功能可达」两者兼得 —— 与参考项目把它登记为
 * `onboardingTasks`（一个**独立于** `dailyCheckin` 的能力位）是同一口径。
 */

import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'
import { base64ToBytes, bytesToBase64, encryptAes128Cfb } from './aes-cfb.js'
import { md5Hex } from './md5.js'
import { renderQrSvg } from './raccoon-qr.js'

// ── 协议常量 ────────────────────────────────────────────────────────

/** API 基址。 */
export const RACCOON_API_BASE = 'https://xiaohuanxiong.com'

/** 认证端点前缀。 */
export const RACCOON_AUTH_PREFIX = '/api/web/auth/v1'
/** 推理与模型目录前缀。 */
export const RACCOON_LLM_PREFIX = '/api/web/llm/v2'
/** 积分端点前缀。 */
export const RACCOON_POINTS_PREFIX = '/api/web/points/v1'
/** 桌面端端点前缀（含一次性登录奖励）。 */
export const RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'

/**
 * 手机号传输层加密密钥（**公开常量**，`src/raccoon.ts:36-43`）。
 *
 * ⚠️ 客户端把它硬编码在前端 bundle 里，只用于防止手机号明文出现在日志/代理里，
 * **不是安全边界**（与其它家的 AccessKey 同性质）。
 */
export const RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'

/**
 * 续期提前窗口（秒）。
 *
 * 照抄官方 `scheduleAuth.js` 的 `TOKEN_REFRESH_WINDOW_SECONDS = 300`
 * （`src/raccoon.ts:45-52`）：access_token 寿命约 3 小时（实测
 * `exp - nbf = 10805s`），提前 5 分钟刷新可避免边界失败。
 */
export const RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300

/** 请求超时（毫秒）。 */
export const RACCOON_REQUEST_TIMEOUT_MS = 60_000

/** 扫码轮询间隔（毫秒）。与客户端一致（`src/raccoon.ts:57-58`）。 */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000

/** 扫码状态机的状态值。 */
export const RACCOON_QR_STATUS = {
  pending: 'pending',
  logging: 'logging',
  canceled: 'canceled',
  success: 'success',
} as const

/**
 * 客户端平台标识。
 *
 * ⚠️ 取值**必须**是 `desktop-windows` / `desktop-macos` / `desktop-linux`
 * —— 依据主进程 `desktopDeviceIdentity.js` 的
 * `resolveDesktopClientPlatform`（`win32` → `desktop-windows`）。
 * `desktop/v1/login/points/grant` **要求**该头，猜错会被拒
 * （`src/raccoon-product.ts:175-183`、`src/raccoon.ts:266-269`）。
 */
export const RACCOON_CLIENT_PLATFORM = 'desktop-windows'
/** 客户端版本（带 `v` 前缀）。 */
export const RACCOON_CLIENT_VERSION = 'v1.0.35'

/** 一次性登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

// ── 请求头 ──────────────────────────────────────────────────────────

/**
 * 业务端点请求头。
 *
 * 依据客户端 `createHeaders()`（`src/raccoon.ts:264-292`）。
 * `X-Client-Platform` 对 `desktop/v1/login/points/grant` **必需**。
 */
export function raccoonHeaders(
  credential: Pick<ProviderCredential, 'accessToken' | 'extras'>,
  opts: { platform?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    // 个人账号为空串；客户端总是发送该头
    'X-Org-Code': credential.extras['orgCode'] ?? '',
    'X-Raccoon-Language': 'zh',
  }
  const platform = opts.platform ?? RACCOON_CLIENT_PLATFORM
  if (platform.length > 0) headers['X-Client-Platform'] = platform
  headers['X-Client-Version'] = RACCOON_CLIENT_VERSION
  const deviceId = credential.extras['deviceId'] ?? ''
  if (deviceId.length > 0) headers['X-Client-Device-ID'] = deviceId
  return headers
}

// ── JWT 过期解码 ────────────────────────────────────────────────────

/**
 * 解码 JWT payload 的 `exp`，换算成**毫秒**时间戳。
 *
 * ⚠️ 只解码、**不验签** —— 我们只需要知道什么时候该续期，签名由服务端校验。
 * ⚠️ 任何解析失败都返回 `undefined` 而**不抛错**：凭据可能被手工改坏，
 * 那时应当降级成「无过期信息」（宁可试一次），而不是让整个 provider 崩
 * （`src/raccoon.ts:108-129`）。
 *
 * ## 为什么必须回退到 JWT 的 `exp`（这不是锦上添花）
 *
 * `expires_at` 是**可选**字段，老凭据或手工导入的凭据可能没有它。
 * 只读 `expires_at` 会让过期判定**恒为 false**，于是续期永远被跳过 ——
 * 表现为「凭据悄悄过期、续期从不触发」，且**没有任何报错**
 * （`src/raccoon.ts:131-141` 记录了这条同型缺陷）。
 */
export function decodeJwtExpMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    // JWT 用 base64**url**；`atob` 只认标准 base64，故先补齐字母表与填充位。
    const payload = JSON.parse(decodeBase64Url(parts[1] ?? '')) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

/** base64url → UTF-8 字符串（`atob` 不认 `-`/`_`，也不接受无填充输入）。 */
function decodeBase64Url(value: string): string {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = base64.length % 4
  if (remainder === 2) base64 += '=='
  else if (remainder === 3) base64 += '='
  const bytes = base64ToBytes(base64)
  return new TextDecoder().decode(bytes)
}

/**
 * 解析凭据的过期时刻（毫秒）。
 *
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**（见上方说明）。
 */
export function raccoonCredentialExpiresAtMs(credential: ProviderCredential): number | undefined {
  if (Number.isFinite(credential.expiresAt) && credential.expiresAt > 0) return credential.expiresAt
  return decodeJwtExpMs(credential.accessToken)
}

// ── 手机号加密 ──────────────────────────────────────────────────────

/**
 * 加密手机号，供 `send_sms` / `login_with_sms` 使用。
 *
 * 算法照抄客户端（渲染层模块 68284 的 `yv()`，`src/raccoon.ts:174-201`）：
 *
 * ```
 * key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
 * iv    = 随机 16 字节
 * mode  = CFB, padding = NoPadding
 * 输出  = Base64(iv ‖ ciphertext)
 * ```
 *
 * ⚠️ CFB 是**流**密码、没有补位概念：11 字节手机号两种 `setAutoPadding`
 * 设置下密文都是 11 字节（`src/raccoon.ts:188-190`）。
 * ⚠️ 实现在 `aes-cfb.ts`（WebCrypto **没有** CFB 模式），已与 Node 的
 * `createCipheriv('aes-128-cfb', …)` 逐字节对拍验证。
 *
 * ⚠️ **本函数在 Workers 上可跑，但短信登录整体不可跑** —— 还需要阿里云
 * 滑块 `captcha_param`（见文件头第 3 条）。保留它是为了（a）形状可单测、
 * （b）若将来上游去掉滑块，扫码之外的这条路径可直接启用。
 */
export function encryptRaccoonPhone(phone: string, iv?: Uint8Array): string {
  const key = new TextEncoder().encode(RACCOON_PHONE_CIPHER_SECRET)
  const nonce = iv ?? crypto.getRandomValues(new Uint8Array(16))
  const ciphertext = encryptAes128Cfb(key, nonce, new TextEncoder().encode(phone))
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)
  return bytesToBase64(combined)
}

// ── 业务信封 ────────────────────────────────────────────────────────

/** 业务响应信封。 */
interface RaccoonEnvelope {
  code: number
  message: string
  details: string
  data: Record<string, unknown> | undefined
}

/**
 * 解析业务信封。
 *
 * ⚠️ 失败可能带 HTTP 400/401，**也可能**是 HTTP 200 + 非 0 `code`
 * —— 故状态码只在**没有** `code` 字段时兜底（`src/raccoon-oauth.ts:61-73`）。
 */
function parseEnvelope(payload: unknown, status: number): RaccoonEnvelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' ? record.message : ''
  const details = typeof record.details === 'string' ? record.details : ''
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { code, message, details, data }
}

/** 把信封里的错误拼成一条可读信息（服务端文案优先）。 */
function envelopeError(envelope: RaccoonEnvelope, fallback: string, path: string): string {
  const text = [envelope.message, envelope.details].filter((s) => s.length > 0).join(': ')
  const described = text.length > 0 ? text : fallback
  // 业务码能直接对上排查手册（100003 / 100006 / 200003 / 200035），故一并带上
  return `Raccoon ${path} 失败（code=${envelope.code}）：${described}`
}

/** 判断业务码是否值得换号（429/402 在 HTTP 层，这里只管业务码层）。 */
function isRetryableCode(code: number): boolean {
  // ⚠️ 100003（手机号加密错）/ 100006（滑块验证失败）是**请求本身的问题**，
  // 换号会重放同样的坏请求并放大风控 ⇒ 不换号。
  // 其余（含 5xx 兜底码）视为可换号。
  return code !== 100003 && code !== 100006 && code !== 200035
}

/** 发一次带凭证的 JSON 请求并拆信封。 */
async function raccoonRequest(
  credential: ProviderCredential,
  path: string,
  init: { method: string; body?: string; platform?: string },
  signal: AbortSignal,
): Promise<RaccoonEnvelope> {
  let response: Response
  try {
    response = await fetch(`${RACCOON_API_BASE}${path}`, {
      method: init.method,
      headers: raccoonHeaders(credential, init.platform === undefined ? {} : { platform: init.platform }),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'raccoon',
      message: `请求 Raccoon 失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new ProviderError({
      provider: 'raccoon',
      httpStatus: response.status,
      message: `Raccoon 响应不是 JSON（${path}，HTTP ${response.status}）`,
      retryable: response.status === 429 || response.status === 402,
    })
  }
  return parseEnvelope(parsed, response.status)
}

/** 发一次请求；信封 `code !== 0` 时抛 `ProviderError`。 */
async function raccoonRequestOk(
  credential: ProviderCredential,
  path: string,
  init: { method: string; body?: string; platform?: string },
  signal: AbortSignal,
): Promise<RaccoonEnvelope> {
  const envelope = await raccoonRequest(credential, path, init, signal)
  if (envelope.code !== 0) {
    throw new ProviderError({
      provider: 'raccoon',
      message: envelopeError(envelope, '业务请求失败', path),
      retryable: isRetryableCode(envelope.code),
    })
  }
  return envelope
}

// ── 凭据解析 ────────────────────────────────────────────────────────

/** 从任意形状里读字符串。 */
function pickString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** 读毫秒时间戳（接受数字或数字字符串）；非法返回 0（= 未知）。 */
function pickTimestamp(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const raw = source[key]
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * 解析 Raccoon 凭据。
 *
 * ## 判别特征（严格）
 *
 * 必须能与别家区分开。Raccoon 的 `access_token` 是**服务端下发的 JWT**
 * （三段 base64url，`src/raccoon.ts:78-83`），这与其它家的 32 位 hex session
 * **形态完全不同**，是最可靠的判别依据。
 *
 * 故判据是：有 token 字段**且**（是 JWT，**或**有 `refresh_token`，
 * **或**有 `user_id`/`phone`）。只看「有 access_token」会把 WorkBuddy 的
 * 凭据也吞下来。
 *
 * ## uid 的口径
 *
 * `uid` 被用作 DO 存储的 key，**必须对同一账号恒为同一个值**。优先级：
 * `user_id`（服务端稳定 id）→ JWT `sub` → JWT 的 `iat` + `access_token` 派生值。
 *
 * ⚠️ **不用 `access_token` 本身**：它每 3 小时续期一次就换一个，
 * 拿它当主键会让同一账号在池里反复新增（参考项目
 * `AccountPool.findAccountIdByCredential` 正是用 `access_token` 做身份，
 * 那在本项目这种「以 uid 为存储 key」的场景下会出问题）。
 *
 * ## ⚠️ 为什么不能「找不到稳定 id 就抛错」
 *
 * 扫码登录成功后服务端**只下发 token**（`src/raccoon-oauth.ts:238-253`），
 * 没有 `user_id`。若这里抛错，**整条扫码链路都会失败**。
 * 故回退到「从 token 确定性派生」—— 续期后 token 变了 uid 也会变，
 * 所以调用方**必须**紧接着用 {@link enrichRaccoonCredential} 把
 * 服务端的 `user_id` 补进去（那才是最终稳定的值）。
 */
function parseCredential(input: unknown): ProviderCredential {
  const fail = (message: string): never => {
    throw new ProviderError({ provider: 'raccoon', message })
  }

  if (input === null || typeof input !== 'object') {
    fail('Raccoon 凭据必须是一个 JSON 对象')
  }
  const root = Array.isArray(input) ? input[0] : input
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    fail('Raccoon 凭据必须是一个 JSON 对象（不能是空数组）')
  }
  let source = root as Record<string, unknown>
  for (const wrapper of ['credential', 'credentials', 'auth']) {
    const inner = source[wrapper]
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      source = { ...source, ...(inner as Record<string, unknown>) }
      break
    }
  }

  const accessToken = pickString(source, 'access_token', 'accessToken', 'token')
  if (accessToken === '') {
    fail('缺少访问令牌：请提供 Raccoon 的 `access_token` 字段')
  }
  const refreshToken = pickString(source, 'refresh_token', 'refreshToken')

  const jwtPayload = decodeJwtPayload(accessToken)
  const sub = typeof jwtPayload?.sub === 'string' ? jwtPayload.sub : ''
  const userId = pickString(source, 'user_id', 'userId')
  const phone = pickString(source, 'phone', 'mobile')

  const looksLikeJwt = accessToken.split('.').length >= 3
  if (!looksLikeJwt && refreshToken === '' && userId === '' && phone === '' && sub === '') {
    fail(
      '这不像是 Raccoon 凭据：`access_token` 不是 JWT（三段 base64url），'
      + '且没有 `refresh_token` / `user_id` / `phone` 可用于识别账号。'
      + '请在面板粘贴 Raccoon 登录后的凭据。',
    )
  }

  // ⚠️ uid 必须稳定：不用 access_token（每 3 小时续期就换一个）。
  // 都没有时**派生**而不是抛错 —— 抛出会让扫码登录整条链路失败
  // （扫码成功后服务端只给 token）。
  const uid = userId !== '' ? userId : (sub !== '' ? sub : deriveRaccoonUid(accessToken, phone))

  const officeIdentity = pickString(source, 'office_identity', 'officeIdentity', 'org_code')
  const nickname = pickString(source, 'nickname', 'name')
  const deviceId = pickString(source, 'device_id', 'deviceId')
  // ⚠️ `expires_at` 可能缺失 —— 此时回退到 JWT 的 `exp`（见 decodeJwtExpMs）
  const expiresAt = pickTimestamp(source, 'expires_at', 'expiresAt') || (decodeJwtExpMs(accessToken) ?? 0)

  return {
    provider: 'raccoon',
    uid,
    accessToken,
    refreshToken,
    expiresAt,
    nickname: nickname === '' ? (phone !== '' ? `Raccoon ${phone}` : `Raccoon ${uid}`) : nickname,
    extras: {
      ...(officeIdentity === '' ? {} : { orgCode: officeIdentity }),
      ...(phone === '' ? {} : { phone }),
      ...(userId === '' ? {} : { userId }),
      ...(deviceId === '' ? {} : { deviceId }),
      // 诚实标记：raccoon **有** refresh 端点
      refreshable: refreshToken === '' ? 'false' : 'true',
      apiBase: RACCOON_API_BASE,
    },
  }
}

/** 尽力解出 JWT payload（失败返回 undefined，**不抛错**）。 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(parts[1] ?? ''))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 token（与手机号，若提供）确定性派生 uid。
 *
 * ⚠️ 这是**过渡值**，不是最终 uid：续期换 token 后派生的 uid 会变。
 * 调用方必须在登录后立刻用 {@link enrichRaccoonCredential} 拉 `user_id`
 * 覆盖它（见 `parseCredential` 的注释）。
 * 用 MD5 而非 SHA-256 是因为 `parseCredential` **必须同步**（接口签名如此），
 * 且这里只需「确定性 + 单向」，不是安全边界。
 */
function deriveRaccoonUid(accessToken: string, phone: string): string {
  const parts = accessToken.split('.')
  // 取 payload（第 2 段）而不是整条 token：JWT 的签名段每次续期都会变，
  // 而 payload 里的 `sub`/`iat` 在同一账号同一会话内稳定得多。
  const material = `${phone}\u0000${parts.length >= 2 ? parts[1] ?? '' : accessToken}`
  return `raccoon-${md5Hex(new TextEncoder().encode(material)).slice(0, 16)}`
}

// ── 模型目录 ────────────────────────────────────────────────────────

/** 倍率格式化：去掉浮点噪声，`0.75` → `0.75`、`1` → `1`、`0.1` → `0.1`。 */
function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * 最终展示名：`GLM-5-3 · x0.75` / `SenseNova-6.8-Flash · 免费` /
 * `GLM-5-3-Flash · x0.2→x0.1` / `Kimi-K3 · x1`。
 *
 * ⚠️ 倍率必须拼进 `name`（**不是** `description`）：模型切换菜单只渲染 `name`
 * （`src/raccoon.ts:225-241`）。
 *
 * ⚠️ **1 倍也要显示**（真实缺陷，用户报障：「为什么 Kimi-K3 没有倍率，
 * ide 是 1 倍，1 倍也要显示倍率」）。早期按「1 倍是默认，显示属噪声」省略它，
 * 结果该模型看起来**没有计费信息** —— 用户无法区分「它就是 1 倍」与
 * 「我们没取到它的倍率」（`src/raccoon.ts:232-235`）。
 *
 * 三条展示规则：
 * - 生效价为 **0** → 显示「免费」（**不是** `x0`）；
 * - 生效价 **严格小于**原价 → `x原价→x折后价`；
 * - 其余（**含 1 倍**）→ `x生效价`。
 */
export function raccoonDisplayName(input: {
  id: string
  description: string
  effectiveMultiplier: number
  baseMultiplier: number
}): string {
  const name = input.description.length > 0 ? input.description : input.id
  const effective = input.effectiveMultiplier
  // 非有限数 / 负数：不追加后缀，避免产出「模型名 · 」这种孤立分隔符。
  // ⚠️ 这条只处理「取不到倍率」，与「倍率恰好是 1」是两回事（后者要显示）。
  if (!Number.isFinite(effective) || effective < 0) return name
  if (effective === 0) return `${name} · 免费`

  const base = input.baseMultiplier
  const hasBase = Number.isFinite(base) && base > 0
  if (hasBase && base > effective) {
    return `${name} · x${formatMultiplier(base)}→x${formatMultiplier(effective)}`
  }
  return `${name} · x${formatMultiplier(effective)}`
}

/**
 * 解析 `GET /model_catalog` 响应。
 *
 * 只取 `categories[].type === 'chat'` 的那个分类（实测只有一个），
 * 过滤 `visible === false`（`src/raccoon-auth.ts:617-652`）。
 */
export function parseRaccoonModels(payload: unknown): ProviderModel[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const root = payload as Record<string, unknown>
  if (root.code !== 0) return []
  const data = typeof root.data === 'object' && root.data !== null && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined
  if (data === undefined) return []

  const categories = Array.isArray(data.categories) ? data.categories : []
  const chat = categories.find((c) => {
    return typeof c === 'object' && c !== null && !Array.isArray(c)
      && (c as Record<string, unknown>).type === 'chat'
  })
  if (chat === undefined) return []

  const models = Array.isArray((chat as Record<string, unknown>).models)
    ? (chat as Record<string, unknown>).models as unknown[]
    : []

  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    // ⚠️ 远端把模型 id 放在 `name` 字段里（不是 `id`）
    const id = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (id === '' || seen.has(id)) continue
    // 远端 `visible` 缺省视为可见（保守：不因字段缺失而隐藏模型）
    if (entry.visible === false) continue
    seen.add(id)

    const params = typeof entry.params === 'object' && entry.params !== null
      ? entry.params as Record<string, unknown>
      : {}
    const description = typeof entry.description === 'string' && entry.description.length > 0
      ? entry.description
      : id
    const effective = typeof entry.billing_effective_multiplier === 'number'
      ? entry.billing_effective_multiplier
      : Number.NaN
    const base = typeof entry.billing_multiplier === 'number' ? entry.billing_multiplier : Number.NaN
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())
      : []

    const contextWindow = readPositiveInt(params.context_window ?? entry.context_window)
    const maxTokens = readPositiveInt(params.max_tokens)

    out.push({
      id,
      name: raccoonDisplayName({ id, description, effectiveMultiplier: effective, baseMultiplier: base }),
      // 0 = 未知（不编造数值：编造会让客户端算出错误的上下文预算）
      contextWindow,
      maxOutput: maxTokens,
      supportsImage: tags.includes('vision') || tags.includes('image') || tags.includes('image-understanding'),
      // ⚠️ `billing_status === 'limited_free'` 表示**限免**（有时限），
      // 而 `effective === 0` 是当前生效价为零。判据用后者（它是实际计价口径）；
      // 前者会随时间失效却仍被标成免费。
      isFree: effective === 0,
    })
  }
  return out
}

/** 只放行**安全正整数**（`0`/负数/`NaN` 一律回 0 = 未知）。 */
function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** 拉取模型目录。 */
async function listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderModel[]> {
  const envelope = await raccoonRequestOk(
    credential,
    `${RACCOON_LLM_PREFIX}/model_catalog`,
    { method: 'GET' },
    signal,
  )
  const models = parseRaccoonModels({ code: 0, data: envelope.data })
  if (models.length === 0) {
    // ⚠️ 空目录必须显式失败（不返回空数组冒充成功）——
    // 那会让面板显示「该账号没有模型」，而真实原因可能是响应形状变了。
    throw new ProviderError({
      provider: 'raccoon',
      message: 'Raccoon 模型目录为空：上游响应形状可能已变化（期望 data.categories[type=chat].models[] 且 visible !== false）',
    })
  }
  return models
}

// ── 对话 ────────────────────────────────────────────────────────────

/**
 * 准备出站请求体。
 *
 * ⚠️ 网关对**非默认供应商**传的是**未清洗的原始 body**，
 * 故这里必须自己补两件事：
 *
 * 1. `model` 换成去掉 `provider/` 前缀的值（body 里那份还带前缀）；
 * 2. `stream` 必须为 `true`。
 *
 * 另外做工具配对清理。
 *
 * ## 思考档位
 *
 * ⚠️ 唯一**有效**的思考控制通道是 **`extra_body.thinking`**（Anthropic 风格对象），
 * 服务端报错原文确认其枚举：``expected one of `adaptive`, `enabled`, `disabled` ``
 * （`src/raccoon-product.ts:45-56`）。实测 `reasoning_effort` 虽被接受
 * （8 个枚举值）但**无任何可观测效果**（8 轮配对实验里正负差 4:4，纯随机），
 * 且 `none` **不关闭**思考（均值 301 vs `disabled` 的 0）
 * （`src/raccoon-adapter.ts:62-104`）。
 *
 * 故：body 里若显式带了 `reasoning_effort`，映射成
 * `extra_body.thinking = { type: 'disabled' | 'enabled' }`；
 * 否则**不发该字段**，保持服务端默认（实测默认就是开启，但少发一个字段更稳）。
 */
export function prepareRaccoonBody(body: Record<string, unknown>, model: string): string {
  const out: Record<string, unknown> = { ...body, model, stream: true }
  if (Array.isArray(out.messages)) {
    out.messages = cleanupToolPairing(out.messages)
  }

  const effort = typeof out.reasoning_effort === 'string' ? out.reasoning_effort : undefined
  // 只认明确的「关闭」；未知值按开启处理 —— 宁可多思考，
  // 不可静默关掉（用户看不到思考内容会以为模型坏了）。
  if (effort !== undefined && out.extra_body === undefined) {
    out.extra_body = { thinking: { type: effort === 'none' || effort === 'off' || effort === 'disabled' ? 'disabled' : 'enabled' } }
  }
  // ⚠️ 删掉 `reasoning_effort`：它被服务端接受但无效果，
  // 留着只会让人误以为档位生效了（且多一个可能被未来 schema 收紧的字段）。
  delete out.reasoning_effort
  return JSON.stringify(out)
}

/** 清理孤儿 `tool` 消息与不完整 `tool_calls`。 */
function cleanupToolPairing(messages: unknown[]): unknown[] {
  const declared = new Set<string>()
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const call of msg.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      const id = (call as Record<string, unknown>).id
      if (typeof id === 'string' && id !== '') declared.add(id)
    }
  }

  const out: unknown[] = []
  let changed = false
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') {
      out.push(raw)
      continue
    }
    const msg = raw as Record<string, unknown>
    if (msg.role === 'tool') {
      const id = msg.tool_call_id
      if (typeof id !== 'string' || id === '' || !declared.has(id)) {
        changed = true
        continue
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const kept = (msg.tool_calls as unknown[]).filter((call) => {
        if (call === null || typeof call !== 'object') return false
        const fn = (call as Record<string, unknown>).function
        if (fn === null || typeof fn !== 'object') return false
        const name = (fn as Record<string, unknown>).name
        return typeof name === 'string' && name !== ''
      })
      if (kept.length !== msg.tool_calls.length) {
        changed = true
        if (kept.length === 0) delete msg.tool_calls
        else msg.tool_calls = kept
      }
    }
    out.push(msg)
  }
  return changed ? out : messages
}

/**
 * 发起对话，返回**上游原始 `Response`**（由网关逐帧透传）。
 *
 * ⚠️ **绝不 `await response.text()`**：这是流式响应，整包缓冲会
 * （a）把整条回答读进内存、（b）让客户端干等到最后才有第一个字。
 *
 * ⚠️ 与 Loomy 不同，raccoon 的业务失败**不一定**返回 HTTP 200
 * （`src/raccoon-oauth.ts:53`：失败可能带 400/401，也可能是 200 + 非 0 code）。
 * 但这里**不 peek** SSE 流 —— 一旦 content-type 是 `text/event-stream`，
 * 读取就会消费流。错误帧交给网关的 `detectErrorFrame` 处理
 * （它已认 OpenAI 标准 `{error:{...}}` 形态，`gateway/stream.ts:78-85`）。
 */
async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
  const body = prepareRaccoonBody(request.body, request.model)

  let response: Response
  try {
    response = await fetch(`${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        'X-Org-Code': credential.extras['orgCode'] ?? '',
        'X-Raccoon-Language': 'zh',
        'X-Client-Platform': RACCOON_CLIENT_PLATFORM,
      },
      body,
      signal: request.signal,
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'raccoon',
      message: `Raccoon 对话请求失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ProviderError({
      provider: 'raccoon',
      httpStatus: response.status,
      message: `Raccoon 对话失败（HTTP ${response.status}）：${text.slice(0, 300) || '(空响应)'}`,
      retryable: response.status === 429 || response.status === 402,
    })
  }

  return response
}

// ── 余额 ────────────────────────────────────────────────────────────

/** 读成有限数字；非法返回 `undefined`（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 查询积分余额（**只读**）。
 *
 * ⚠️ 用 `GET /points/v1/balance` 而**不是** `login/points/grant`：
 * 后者是**写**端点（一次性奖励），在「打开面板」这种高频路径上调用会
 * 意外消费掉那个一次性机会（与 Loomy 的 `first-login` 同型缺陷，
 * `src/raccoon-credits.ts:20-25`）。
 *
 * ⚠️ 各池**分开作 package**：它们的有效期与回补规则都不同
 * （每日积分每日刷新、奖励/充值积分长期有效）。
 */
async function balance(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderBalance> {
  const envelope = await raccoonRequestOk(
    credential,
    `${RACCOON_POINTS_PREFIX}/balance`,
    { method: 'GET' },
    signal,
  )
  const data = envelope.data
  const available = readNumber(data?.available_points)
  if (available === undefined) {
    // ⚠️ `available_points` 是核心字段：没有它就说明响应形状不对。
    // 返回 0 会把「查不到」伪装成「余额为 0」。
    throw new ProviderError({
      provider: 'raccoon',
      message: 'Raccoon 余额响应缺少 `available_points` 字段：无法确认额度（不返回 0 以免误报为「已用尽」）',
    })
  }

  const packages: ProviderBalance['packages'] = []
  const reward = readNumber(data?.reward_points)
  const daily = readNumber(data?.daily_points)
  const topup = readNumber(data?.topup_points)
  const monthly = readNumber(data?.monthly_points)
  if (reward !== undefined) packages.push({ name: '奖励积分', amount: reward, expiry: 0 })
  if (daily !== undefined) packages.push({ name: '每日积分（每日刷新）', amount: daily, expiry: 0 })
  if (monthly !== undefined && monthly > 0) packages.push({ name: '会员积分', amount: monthly, expiry: 0 })
  if (topup !== undefined) packages.push({ name: '充值积分', amount: topup, expiry: 0 })

  return {
    total: available,
    // ⚠️ **不声称任何过期信息**（`expiring: 0` = 未知）。
    // 服务端只给四个池的余额，**不返回**任何到期字段（参考项目的
    // `makePackage` 同样把 `expiredTime` 留空、`expiredTotal` 置 0，
    // `src/raccoon-credits.ts:106-119,157-162`）。
    // 与 Loomy 的关键差异：Loomy 的每日池有**明确记载**的当日失效语义
    //（`credits-capabilities.js:239-240`「dailyBalance（当日到期，次日重发）」），
    // 而 raccoon 的「每日 300 由服务端自动发放」并未说明该池会清零。
    // ⇒ 凭猜测标一个「即将过期」会让用户以为额度要作废，那比不报更糟。
    expiring: 0,
    earliestExpiry: 0,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [{ name: '可用积分', amount: available, expiry: 0 }],
  }
}

// ── 一次性登录奖励（**不是**每日签到，见文件头） ────────────────────

/** 领取结果。 */
export interface RaccoonGrantResult {
  /** 本次是否真的发放了（`false` = 此前已领过，幂等命中）。 */
  granted: boolean
  /** 发放的额度（服务端未给时回落到 3000）。 */
  points: number
  /** 可读说明。 */
  detail: string
}

/**
 * 领取「桌面端登录奖励」（**一次性，幂等**）。
 *
 * ## ⚠️ 为什么它不是 `checkin()`
 *
 * `Provider.checkin` 的语义是「每日签到」（每天都有收益）。本端点实测是
 * **幂等一次性**的（已领过返回 HTTP 200 + `granted:false`，
 * `src/raccoon-credits.ts:165-172`）。把它挂到 `checkin` 上会让面板
 * 每天渲染一个必然无收益的按钮。
 *
 * 故这里作为**独立导出函数**暴露，`capabilities.checkin` 如实为 `false`
 * （与参考项目 `plugin-src/client/credits-capabilities.js:133` 把 raccoon
 * 登记为 `onboardingTasks`、**无** `dailyCheckin` 是同一口径）。
 *
 * ## ⚠️ 必需 `X-Client-Platform`
 *
 * 该头标识「来自桌面端」，缺了会被拒（`src/raccoon-credits.ts:171-173`）。
 * `raccoonHeaders` 默认就带上它。
 */
export async function grantLoginReward(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<RaccoonGrantResult> {
  const envelope = await raccoonRequestOk(
    credential,
    `${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    { method: 'POST' },
    signal,
  )

  // ⚠️ 幂等判据是响应体的 `granted`，**不是** HTTP 状态码
  // （重复领取同样返回 200）。
  if (envelope.data?.granted !== true) {
    return {
      granted: false,
      points: 0,
      detail: '该账号已领取过桌面端登录奖励（每号一次，幂等命中）',
    }
  }

  const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
    ? envelope.data.popup as Record<string, unknown>
    : undefined
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS
  return { granted: true, points, detail: `已领取桌面端登录奖励 ${points} 积分` }
}

/**
 * 查询「桌面端登录奖励」是否已领。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的合计，
 * 无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」
 * （`src/raccoon-credits.ts:214-227`）。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchLoginRewardStatus(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<{ claimed: boolean; points: number }> {
  let envelope: RaccoonEnvelope
  try {
    envelope = await raccoonRequest(
      credential,
      `${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
      { method: 'GET' },
      signal,
    )
  } catch {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }
  if (envelope.code !== 0 || envelope.data === undefined) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'reward_grant') continue
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    const points = readNumber(item.points)
    return { claimed: true, points: points !== undefined && points > 0 ? points : RACCOON_LOGIN_REWARD_POINTS }
  }
  return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
}

// ── 供应商导出 ──────────────────────────────────────────────────────

export const raccoonProvider: Provider = {
  /**
   * 对象判别式：Raccoon 凭据的**独有**字段。
   *
   * ⚠️ 它的 `access_token` + `user_id` 与 buddy 重叠，必须靠
   * `phone`（Raccoon 登录必带手机号）或 `user_id` 的数字形态判别。
   * 实测：不加判别时本地 RACCOON 凭据被判成 buddy（uid=7455957）。
   */
  /**
   * 续期：`POST {base}/api/web/auth/v1/refresh`（body 带 refresh_token）。
   *
   * 实测本地凭据已过期 5 小时 → 所有请求 401；
   * 接上续期后应能自动恢复，而不需要用户重新扫码。
   */
  async refresh(credential, signal) {
    return await refreshRaccoonCredential(credential, signal)
  },

  matchesShape(input) {
    // ## 🔴 必须**先排除** LobsterAI 的凭据（实测缺陷）
    //
    // 用户报「我在本地登录了 lobsterai，你推送上去试试」——实测导入后
    // 它被判成了 **raccoon**（账号以 `raccoon:116092` 出现）。
    //
    // 根因：本函数下面的判据是「`user_id` 是**纯数字**」，而
    // **LobsterAI 的 `user_id` 恰好也是纯数字**（`116092`）⇒ 判别式重叠。
    // 且 `lobsteraiProvider` 当时**没有 `matchesShape`**，
    // 在 `parseCredentialAnywhere` 的循环里会被「形状不属于该供应商」直接跳过
    // ⇒ 凭据落到排在后面的 raccoon 手里。
    //
    // ⚠️ 判据用 LobsterAI 的**独有字段** `first_keyfrom` / `latest_keyfrom`
    //（它的身份载荷必带，Raccoon 协议里没有这个概念）—— 与
    // `lobsterai.ts:299-305` 拒绝 TRAE 凭据用的是同一思路：
    // **靠凭据本身的判别特征分家，而不是靠注册顺序**。
    if (typeof input['first_keyfrom'] === 'string' || typeof input['latest_keyfrom'] === 'string') {
      return false
    }
    if (typeof input['first_keyfrom'] === 'number' || typeof input['latest_keyfrom'] === 'number') {
      return false
    }
    if (typeof input['firstKeyfrom'] === 'string' || typeof input['latestKeyfrom'] === 'string') {
      return false
    }
    if (typeof input['phone'] === 'string' && input['phone'] !== '') return true
    // Raccoon 的 user_id 是**纯数字**（buddy 的 user_id 是 UUID 形态）
    const uid = input['user_id']
    return typeof uid === 'string' && /^\d+$/.test(uid)
  },
  id: 'raccoon',
  name: 'Raccoon（商汤）',
  capabilities: {
    /**
     * ✅ 登录可在 Workers 完成（**仅扫码路径**）。
     *
     * 依据：扫码的 `code` 由**客户端自造**、服务端只做轮询查询
     * （`src/raccoon.ts:14-17`、`src/raccoon-oauth.ts:112-118`），
     * 完全绕开那条收不到的 `office-raccoon://auth/callback` 自定义协议。
     * ⚠️ 参考项目里那个 `createServer` 只是承载**登录选择页**的展示壳
     * （`src/raccoon-login-page.ts:35-48`）；本服务里这一页由面板渲染：
     * `/admin/providers/login/start` 返回 `qrSvg`，面板内联显示，用户用微信扫。
     *
     * ⚠️ 这条声明此前是 `false`（「扫码登录已实现但未接线」）。现已接线到
     * `/admin/providers/login/{start,poll}`（见 `src/index.ts` 的 raccoon 分支）
     * —— 目的是让**本服务拥有自己的凭据**：本地 DSH 客户端与本服务此前共用
     * 同一份凭据文件，而 raccoon 的 `refresh_token` 是**一次性轮换**的，
     * 两边互相续期会把对方顶掉（用户报障「账号用一天就废」）。
     */
    login: true,

    listModels: true,
    chat: true,
    balance: true,
    /**
     * ❌ **raccoon 没有签到端点**。
     *
     * 每日 300 积分是**服务端按日自动发放**的（账单里 `biz_type: 'daily_grant'`，
     * 该账号 13:30 注册、13:31 即到账，`src/raccoon.ts:18-21`），
     * **不存在可调用的签到端点**。把它实现成签到按钮必然失败
     * （`src/raccoon-credits.ts:10-18`）。
     *
     * ✅ 交叉印证：参考项目的能力矩阵把它登记为
     * `raccoon: { balance: true, onboardingTasks: true }` —— **无** `dailyCheckin`
     * （`plugin-src/client/credits-capabilities.js:117-133`）。
     *
     * ⚠️ 但它**有**一次性登录奖励（3000 分，幂等），语义与 Loomy 的新手任务同构，
     * 故在参考项目里登记为独立的 `onboardingTasks` 而**不是** `dailyCheckin`。
     * `Provider` 接口没有 onboarding 方法 ⇒ 该功能由本文件导出的
     * {@link grantLoginReward} 提供。
     */
    checkin: false,
    /**
     * ⚠️ 这不是本服务的缺陷，而是**上游产品形态**。
     *
     * 依据 `plugin-src/client/credits-capabilities.js:133`：
     * `raccoon: { balance: true, onboardingTasks: true }` —— 登记的是**一次性**
     * `onboardingTasks`，**没有** `dailyCheckin`。
     * 每日 300 积分由服务端**按日自动发放**（账单 `biz_type: 'daily_grant'`），
     * 实测注册后 1 分钟即到账 —— 没有可调用的签到端点。
     */
    checkinBlockedReason:
      'Raccoon 的每日积分由服务端自动发放（账单类型 daily_grant），没有可调用的签到端点。'
      + '这是上游产品形态，不是本服务的缺失 —— 你的积分照常每天到账。',

  },
  parseCredential,
  listModels,
  chat,
  balance,
  /**
   * 429（限流）与 402（余额耗尽）值得换号 —— `Provider` 的缺省语义。
   * 另外补上 401/403：raccoon 的 access_token 寿命约 3 小时
   * （`src/raccoon.ts:45-52`），过期时换号立刻可用；
   * 而 401/403 也可能是 refresh_token 已失效（终态），换号同样正确。
   */
  shouldRotate(status, _bodyText) {
    return status === 429 || status === 402 || status === 401 || status === 403
  },
}

// ── 登录（扫码轮询；供面板调用） ────────────────────────────────────
//
// ⚠️ 与 loomy 同理：这些函数的输出**全部**是「一份 ProviderCredential」，
// 必须与 parseCredential 共用同一套 uid / expiresAt 口径。

/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
  status: (typeof RACCOON_QR_STATUS)[keyof typeof RACCOON_QR_STATUS]
  /** 仅 `success` 时存在。 */
  credential?: ProviderCredential
  /** 仅 `logging` 时存在（二维码有效期，供页面倒计时）。 */
  expiredAt?: string
}

/** 一次「发起扫码登录」的结果：面板拿它渲染二维码。 */
export interface RaccoonQrLoginStart {
  /** 服务端认这个 code；轮询时原样回传（**本地自造，非服务端下发**）。 */
  code: string
  /** 二维码**承载的内容** —— 微信扫码后打开的公开登录页。 */
  qrUrl: string
  /** 内联 SVG 字符串（面板把它插进 DOM 即可，无需前端 QR 逻辑）。 */
  qrSvg: string
}

/**
 * 发起一次扫码登录：生成 code、拼出二维码内容、并就地渲染成 SVG。
 *
 * ⚠️ **不碰网络、不碰凭据** —— 纯本地计算，故可离线单测，
 * 也不会因误调接口消耗用户凭据。真正的登录状态由
 * {@link pollRaccoonQrLogin} 轮询得到。
 */
export function beginRaccoonQrLogin(): RaccoonQrLoginStart {
  const code = generateQrCode()
  const qrUrl = buildQrLoginUrl(code)
  return { code, qrUrl, qrSvg: renderQrSvg(qrUrl) }
}

/**
 * 生成一个扫码用的 `qrcode_code`（32 位小写 hex = 16 字节随机）。
 *
 * 依据客户端 `CryptoJS.lib.WordArray.random(16)`
 * （`src/raccoon-oauth.ts:111-118`）。
 * ⚠️ **任意自造值都被服务端接受**（见文件头第 1 条），这是本方案成立的前提。
 */
export function generateQrCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * 构造二维码承载的微信登录页 URL。
 *
 * 依据客户端：`` `${base}/login/mp?code=${code}&appname=商汤小浣熊官网` ``
 * （`src/raccoon-oauth.ts:120-130`）。这是一个**公开页面**，扫码后在微信内
 * 完成授权，服务端据此把该 code 置为 `success`，我们轮询取回 token。
 */
export function buildQrLoginUrl(code: string): string {
  const params = new URLSearchParams({ code, appname: '商汤小浣熊官网' })
  return `${RACCOON_API_BASE}/login/mp?${params.toString()}`
}

/**
 * 轮询一次扫码登录状态。
 *
 * ⚠️ **任何异常都降级为 `pending`**（网络抖动、响应畸形、未知 status）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断整个登录流程；而把未知状态
 * 误判成 `success` 会让流程拿到空 token 后卡死，误判成 `canceled` 则会让
 * 用户正在扫码的二维码被无故刷新（`src/raccoon-oauth.ts:132-139`）。
 *
 * ⚠️ `fetcher` 显式注入（缺省全局 `fetch`）：本函数的**唯一**用途是网络轮询，
 * 单测必须能在**不打真实上游**的前提下锁死「哪种响应算哪种状态」——
 * 这个仓库的其它 provider 也是这个口径（注入 `signal` + 在测试里替换
 * `globalThis.fetch`，见 `tests/verify.test.ts:81-95`）。
 * ⚠️ **绝不能用真实凭据调 `/refresh` 验证任何东西** —— raccoon 的
 * `refresh_token` 是**一次性轮换**的，调一次就作废（本仓库已因此丢过两次账号）。
 */
export async function pollRaccoonQrLogin(
  code: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrPollResult> {
  let envelope: RaccoonEnvelope
  try {
    const response = await fetcher(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrcode_code: code }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)]),
    })
    envelope = parseEnvelope(await response.json(), response.status)
  } catch {
    return { status: RACCOON_QR_STATUS.pending }
  }

  if (envelope.code !== 0 || envelope.data === undefined) return { status: RACCOON_QR_STATUS.pending }

  const status = typeof envelope.data.status === 'string' ? envelope.data.status : ''
  const expiredAt = typeof envelope.data.expired_at === 'string' ? envelope.data.expired_at : undefined

  if (status === RACCOON_QR_STATUS.canceled) return { status: RACCOON_QR_STATUS.canceled }
  if (status === RACCOON_QR_STATUS.logging) {
    return { status: RACCOON_QR_STATUS.logging, ...(expiredAt === undefined ? {} : { expiredAt }) }
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : ''
    const refreshToken = typeof envelope.data.refresh_token === 'string' ? envelope.data.refresh_token : ''
    // ⚠️ 缺 token 的 success 视为**未完成**：否则会产出空凭据并让流程卡死
    if (accessToken === '') return { status: RACCOON_QR_STATUS.pending }
    // ⚠️ 服务端不返回 user_id，故先靠 JWT 填 uid；
    // 调用方可随后用 /user_info 补 user_id/phone 并写回凭据。
    const expMs = decodeJwtExpMs(accessToken)
    const officeIdentity = typeof envelope.data.office_identity === 'string' ? envelope.data.office_identity : ''
    return {
      status: RACCOON_QR_STATUS.success,
      credential: parseCredential({
        access_token: accessToken,
        refresh_token: refreshToken,
        ...(expMs === undefined ? {} : { expires_at: String(expMs) }),
        ...(officeIdentity === '' ? {} : { office_identity: officeIdentity }),
      }),
    }
  }
  return { status: RACCOON_QR_STATUS.pending }
}

/**
 * 补全凭据里缺失的 `user_id` / `phone` / `office_identity`。
 *
 * ## 为什么必需
 *
 * 扫码成功后服务端**只给 token**，而 `uid` 只能从 JWT 的 `sub` 推。
 * 一旦 JWT 换了签发方式（或缺 `sub`），凭据就没有稳定主键了。
 * 故登录后立刻拉一次 `GET /user_info` 把它补实。
 *
 * ⚠️ **失败时原样返回、不抛错**：用户信息只用于昵称展示与 uid 稳定化，
 * 不该因为它失败而让整个登录流程失败（登录**已经**成功了）
 * （`src/raccoon-oauth.ts:321-329`）。
 */
export async function enrichRaccoonCredential(
  credential: ProviderCredential,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ProviderCredential> {
  let response: Response
  try {
    response = await fetcher(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/user_info`, {
      method: 'GET',
      headers: raccoonHeaders(credential),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)]),
    })
  } catch {
    return credential
  }
  if (!response.ok) return credential

  let envelope: RaccoonEnvelope
  try {
    envelope = parseEnvelope(await response.json(), response.status)
  } catch {
    return credential
  }
  if (envelope.code !== 0 || envelope.data === undefined) return credential

  const userId = typeof envelope.data.id === 'string' ? envelope.data.id : ''
  const name = typeof envelope.data.name === 'string' ? envelope.data.name : ''
  const officeIdentity = typeof envelope.data.office_identity === 'string' ? envelope.data.office_identity : ''
  const phone = typeof envelope.data.phone === 'string' ? envelope.data.phone : ''

  // ⚠️ 优先用服务端的 `id` 作 uid —— 它比 JWT 的 `sub` 更稳定
  // （`src/raccoon-oauth.ts:330-355`）。
  const nextUid = userId !== '' ? userId : credential.uid
  return {
    ...credential,
    uid: nextUid,
    nickname: name !== '' ? name : credential.nickname,
    extras: {
      ...credential.extras,
      ...(officeIdentity === '' ? {} : { orgCode: officeIdentity }),
      ...(phone === '' ? {} : { phone }),
      ...(userId === '' ? {} : { userId }),
    },
  }
}

/**
 * 用 `refresh_token` 换新凭据。
 *
 * ## 三条必须守住的语义
 *
 * 1. **服务端可能只返回新的 `access_token`**（不带新 `refresh_token`）——
 *    此时必须**保留旧值**，否则续期一次就把账号变成不可续期
 *    （`src/raccoon-oauth.ts:281-288`）。
 * 2. **服务端不返回的附加字段（昵称、身份、设备号）也要保留** —— 故用
 *    `{...credential}` 展开而不是重建。
 * 3. **401 / 业务码 `200003` 表示 `refresh_token` 已失效**：这是**终态**，
 *    必须明确提示「请重新登录」且**不重试**（`src/raccoon-oauth.ts:289-302`）。
 */
export async function refreshRaccoonCredential(
  credential: ProviderCredential,
  signal: AbortSignal,
): Promise<ProviderCredential> {
  if (credential.refreshToken === '') {
    throw new ProviderError({ provider: 'raccoon', message: '凭据缺少 refresh_token，请重新登录' })
  }

  let response: Response
  try {
    response = await fetch(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: credential.refreshToken }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    throw new ProviderError({
      provider: 'raccoon',
      message: `Raccoon 续期请求失败：${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    })
  }

  let envelope: RaccoonEnvelope
  try {
    envelope = parseEnvelope(await response.json(), response.status)
  } catch {
    throw new ProviderError({
      provider: 'raccoon',
      httpStatus: response.status,
      message: `Raccoon 续期响应不是 JSON（HTTP ${response.status}）`,
    })
  }

  if (response.status === 401 || envelope.code === 200003) {
    // 终态：`retryable: false`（缺省即 false），且文案必须能指导行动。
    // ⚠️ 刻意保留**连续**的「重新登录」四个字：参考项目就是靠这个子串判定
    // 「需重新登录」这一终态（`src/raccoon-auth.ts:322` 的
    // `message.includes('重新登录')`）。写成「重新扫码登录」会让该判据失配。
    throw new ProviderError({
      provider: 'raccoon',
      httpStatus: response.status,
      message: 'Raccoon 登录态已过期（refresh_token 已失效），请重新登录（微信扫码）',
    })
  }
  if (envelope.code !== 0) {
    throw new ProviderError({
      provider: 'raccoon',
      message: envelopeError(envelope, '续期失败', '/refresh'),
      retryable: isRetryableCode(envelope.code),
    })
  }

  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (accessToken === '') {
    throw new ProviderError({ provider: 'raccoon', message: 'Raccoon 续期响应缺少 access_token' })
  }
  const nextRefresh = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : credential.refreshToken
  const expMs = decodeJwtExpMs(accessToken)
  // ⚠️ `{...credential}` 展开保留昵称/身份/设备号等附加字段
  return {
    ...credential,
    accessToken,
    refreshToken: nextRefresh,
    ...(expMs === undefined ? {} : { expiresAt: expMs }),
  }
}
