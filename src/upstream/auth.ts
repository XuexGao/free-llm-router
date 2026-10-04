/**
 * 设备码登录与 token 续期。
 *
 * ## 为什么 WorkBuddy 能在 Workers 上登录（而其他 provider 不能）
 *
 * 这是**轮询式设备码**流程，**不需要本地回调监听**：
 *
 * ```
 * ① POST /v2/plugin/auth/state?platform=CLI → 拿 state + authUrl
 * ② 用户在浏览器打开 authUrl 完成授权
 * ③ GET  /v2/plugin/auth/token?state=...    → 轮询，未完成时业务码非 0
 * ④ GET  /v2/plugin/login/account?state=... → 拿 uid / nickname
 * ```
 *
 * Workers 没有 listen socket，所以「起本地端口收 OAuth 回调」那类 provider
 * （CodeArts / LobsterAI / TRAE / Loomy / Raccoon）在这里**整体不可行**。
 * WorkBuddy 的轮询式流程是它能落地 serverless 的前提之一（AGENTS.md §2.5）。
 *
 * ## 登录状态放在 DO 里，不放内存
 *
 * `state` 的有效期是分钟级，而 Worker isolate 随时可能被回收。
 * 故登录会话必须持久化 —— 否则「发起登录」与「轮询结果」可能落在不同 isolate，
 * 表现为「轮询永远说 state 未知」（Go 侧进程内 map 在多实例下就是这个问题）。
 */

import { callUpstream, classify, UpstreamError } from './client.js'
import { cliCommonHeaders, type HeaderMap } from './headers.js'

/** CLI 登录用的 UA（与 Go 侧 `panel/login.go:29` 一致）。 */
export const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 登录 state 的有效期：5 分钟（对齐 IDE 的 5×60s 轮询上限）。 */
export const LOGIN_STATE_TTL_MS = 5 * 60 * 1000

/** 一次性登录会话（持久化在 DO storage 里）。 */
export interface LoginSession {
  state: string
  authUrl: string
  realm: string
  createdAt: number
  /** 完成后的凭据（未完成时为空）。 */
  credential?: LoginCredential
}

/** 登录得到的凭据。 */
export interface LoginCredential {
  accessToken: string
  refreshToken: string
  /** 绝对过期时刻（epoch ms）。 */
  expiresAt: number
  domain: string
  uid: string
  enterpriseId: string
  nickname: string
  realm: string
}

/** 登录流程的错误（带可读原因，便于面板展示）。 */
export class LoginError extends Error {
  readonly stage: 'state' | 'token' | 'account' | 'invalid'
  constructor(stage: LoginError['stage'], message: string) {
    super(message)
    this.name = 'LoginError'
    this.stage = stage
  }
}

/** 各 realm 的 base 与 Origin。global 域留接口，第一版只用 cn。 */
export function loginEndpoints(base: string, realm: string): { state: string; token: string; account: string; origin: string } {
  const origin = realm === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  return {
    state: `${base}/v2/plugin/auth/state?platform=CLI`,
    token: `${base}/v2/plugin/auth/token?state=`,
    account: `${base}/v2/plugin/login/account?state=`,
    origin,
  }
}

/** 登录专用出站头（与任务动作的头**不同**：登录用的是 CLI UA，不是桌面 UA）。 */
function loginHeaders(origin: string): HeaderMap {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': LOGIN_UA,
  }
}

/**
 * 第 ① 步：发起设备授权，拿 state + authUrl。
 *
 * 幂等、无副作用、**不消耗任何配额**（本项目出口验证探针用的就是这个端点）。
 */
export async function startLogin(input: { chatBase: string; realm: string }): Promise<{ state: string; authUrl: string }> {
  const ep = loginEndpoints(input.chatBase, input.realm)
  const headers = loginHeaders(ep.origin)

  const res = await callUpstream<{ state?: unknown; authUrl?: unknown }>({
    method: 'POST',
    url: ep.state,
    headers,
    body: '{}',
    timeoutMs: 15_000,
  })

  if (!res.ok || res.envelope === undefined) {
    throw new LoginError('state', `发起登录失败：http=${res.httpStatus} ${res.raw.slice(0, 200)}`)
  }

  const data = res.envelope.data
  const state = typeof data?.state === 'string' ? data.state : ''
  const authUrl = typeof data?.authUrl === 'string' ? data.authUrl : ''
  if (state === '' || authUrl === '') {
    throw new LoginError('state', `上游未返回 state/authUrl：${res.raw.slice(0, 200)}`)
  }
  return { state, authUrl }
}

/**
 * 第 ③④ 步：轮询 token，成功后取账号信息。
 *
 * @returns 未完成时返回 `undefined`（**不是错误** —— 用户还没点授权是正常状态）
 *
 * ⚠️ 判据纪律：`auth/token` 未完成时返回的**业务码非 0**，而不是 HTTP 错误。
 * 故必须用 `callUpstream` 裸接口看信封，不能靠 `res.ok` 判断。
 */
export async function pollLogin(input: {
  chatBase: string
  realm: string
  state: string
}): Promise<LoginCredential | undefined> {
  const ep = loginEndpoints(input.chatBase, input.realm)
  const headers = loginHeaders(ep.origin)

  const res = await callUpstream<{
    accessToken?: unknown
    refreshToken?: unknown
    expiresIn?: unknown
    domain?: unknown
  }>({
    method: 'GET',
    url: `${ep.token}${encodeURIComponent(input.state)}`,
    headers,
    timeoutMs: 15_000,
  })

  // 未完成：业务码非 0 → 继续轮询
  if (res.envelope !== undefined && res.envelope.code !== 0) {
    return undefined
  }
  if (!res.ok || res.envelope === undefined) {
    // 网络抖动也按「还没好」处理，不当作致命错误（用户可能只是还没点）
    return undefined
  }

  const data = res.envelope.data
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  if (accessToken === '') return undefined

  const refreshToken = typeof data?.refreshToken === 'string' ? data.refreshToken : ''
  const domain = typeof data?.domain === 'string' ? data.domain : ''
  const expiresIn = typeof data?.expiresIn === 'number' ? data.expiresIn : 0

  // 取账号信息（失败不阻塞：token 已拿到，缺展示名而已）
  let uid = ''
  let nickname = ''
  let enterpriseId = ''
  try {
    const acctRes = await callUpstream<{ uid?: unknown; nickname?: unknown; enterpriseId?: unknown }>({
      method: 'GET',
      url: `${ep.account}${encodeURIComponent(input.state)}`,
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      timeoutMs: 15_000,
    })
    const acct = acctRes.envelope?.data
    uid = typeof acct?.uid === 'string' ? acct.uid : ''
    nickname = typeof acct?.nickname === 'string' ? acct.nickname : ''
    enterpriseId = typeof acct?.enterpriseId === 'string' ? acct.enterpriseId : ''
  } catch {
    // 静默跳过：账号信息缺失不影响 token 可用性
  }

  if (uid === '') {
    throw new LoginError('account', '登录成功但拿不到 uid（账号信息获取失败，请重试）')
  }

  return {
    accessToken,
    refreshToken,
    // ⚠️ expiresIn 缺省时**不编造**：置 0 让续期逻辑用 JWT 兜底，而不是假装还有一小时。
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    domain,
    uid,
    nickname,
    enterpriseId,
    realm: input.realm,
  }
}

/**
 * uid 合法性校验（**安全边界**）。
 *
 * ⚠️ uid 来自上游响应，会被用作 DO storage 的 key。
 * 不校验就使用，构造出的异常 uid 可能污染其他账号的数据。
 * 实测腾讯侧 uid 是 UUID 形态，故只放行 `[A-Za-z0-9_-]` 且长度 ≤ 64。
 *
 * Go 侧记录过同型风险的更严重形态：uid 曾被直接拼进**文件名**，
 * 构成路径穿越（`workbuddy-../../evil.json`）。这里虽然不落文件系统，
 * 但作为 KV key 同样要守边界。
 */
/**
 * uid 是否可作为存储 key。
 *
 * ## ⚠️ 为什么允许冒号（实测踩到）
 *
 * 原规则只允许 `[A-Za-z0-9_-]`，于是 **CodeArts 的 uid 被拒**
 * （它的 uid 形如 `ak:HSTAGZBUB301TH1GN1V9`，是
 * 「AK 前缀 + access_key_id」的形态）。
 * 用户看到的是「uid 含非法字符，已拒绝」，但那个 uid 是**上游给的**、
 * 用户无法更改 —— 等于这家供应商永远导不进来。
 *
 * 本项目自己的存储 key 规则本来就允许冒号
 * （多供应商用 `${provider}:${uid}` 做前缀，见 index.ts 的 storageUid），
 * 故冒号在这里是安全的：它只出现在我们自己控制的 key 里，
 * 不会被用作 SQL 标识符或路径。
 *
 * 仍然拒绝的字符：空白、引号、斜杠、反斜杠、控制字符 ——
 * 那些会破坏 key 的可用性或日志可读性。
 */
export function isValidUid(uid: string): boolean {
  if (uid === '' || uid.length > 128) return false
  // 允许字母数字、下划线、连字符、冒号（CodeArts 的 AK 前缀形态）
  return /^[A-Za-z0-9_:-]+$/.test(uid)
}

/**
 * 续期 access token。
 *
 * ## 两个必须守住的点（Go 侧实测教训）
 *
 * 1. **终态判定要结构化**：`refresh token` 失效（401/403 或 message 含
 *    `expired`/`invalid`）是**终态**，必须停止重试并提示重新登录。
 *    把它当可重试会让调度器无限打上游。
 * 2. **`expiresIn` 缺省不编造**：Go 侧把「缺省或 >10 年」视为脏值保留旧值。
 *    这里同样：非法值返回 0，让调用方知道「不知道何时过期」。
 */
export async function refreshCredential(input: {
  chatBase: string
  realm: string
  refreshToken: string
  accessToken: string
  uid: string
  enterpriseId: string
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; domain: string }> {
  if (input.refreshToken.trim() === '') {
    throw new UpstreamError({
      kind: 'auth_error',
      httpStatus: 0,
      message: '没有 refreshToken，需要重新登录',
      detail: 'refreshToken is empty',
    })
  }

  const origin = input.realm === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const headers: HeaderMap = {
    ...loginHeaders(origin),
    Authorization: `Bearer ${input.accessToken}`,
    // ⚠️ 安全红线：X-Refresh-Token 只能出现在续期请求里（Go 侧 headers.go:214 明确记录）
    'X-Refresh-Token': input.refreshToken,
    'X-Auth-Refresh-Source': 'ide-main',
    'X-User-Id': input.uid,
  }
  if (input.enterpriseId !== '') headers['X-Enterprise-Id'] = input.enterpriseId

  const res = await callUpstream<{
    accessToken?: unknown
    refreshToken?: unknown
    expiresIn?: unknown
    domain?: unknown
  }>({
    method: 'POST',
    url: `${input.chatBase}/v2/plugin/auth/token/refresh`,
    headers,
    timeoutMs: 30_000,
  })

  const code = res.envelope?.code
  const msg = res.envelope?.msg ?? ''

  // 终态：refresh token 本身失效 → 停止重试
  const isTerminal =
    res.httpStatus === 401 ||
    res.httpStatus === 403 ||
    code === 401 ||
    code === 403 ||
    /expired|invalid/i.test(msg)

  if (isTerminal) {
    throw new UpstreamError({
      kind: 'auth_error',
      httpStatus: res.httpStatus,
      code,
      message: `refreshToken 已失效，需要重新登录：${msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  if (!res.ok || res.envelope === undefined) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `续期失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  const data = res.envelope.data
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  if (accessToken === '') {
    throw new UpstreamError({
      kind: 'auth_error',
      httpStatus: res.httpStatus,
      message: '续期响应里没有 accessToken，需要重新登录',
      detail: res.raw.slice(0, 400),
    })
  }

  const expiresIn = typeof data?.expiresIn === 'number' ? data.expiresIn : 0
  // ⚠️ 缺省或异常大的 expiresIn 视为脏值 → 0（表示「不知道」），不编造一个假的过期时间。
  const MAX_REASONABLE_SECONDS = 10 * 365 * 24 * 3600
  const validExpires = expiresIn > 0 && expiresIn < MAX_REASONABLE_SECONDS

  return {
    accessToken,
    refreshToken: typeof data?.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : input.refreshToken,
    expiresAt: validExpires ? Date.now() + expiresIn * 1000 : 0,
    domain: typeof data?.domain === 'string' ? data.domain : '',
  }
}

/** 距过期不足此时间即视为需要续期（Go 侧 `RefreshSkew = 10min`）。 */
export const REFRESH_SKEW_MS = 10 * 60 * 1000

/** 是否需要续期。`expiresAt === 0`（未知）恒为 true —— 宁可多续一次也不要打到 401。 */
export function needsRefresh(expiresAt: number, now: number): boolean {
  if (expiresAt <= 0) return true
  return expiresAt - now <= REFRESH_SKEW_MS
}
