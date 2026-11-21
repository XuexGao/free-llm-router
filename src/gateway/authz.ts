/**
 * 子密钥鉴权与配额守卫（`/v1/*` 的入口层）。
 *
 * ## 职责边界
 *
 * 本模块**只做**「这请求能不能放行 / 放行后怎么记账」，
 * 不碰上游、不碰账号池。真正的转发仍在 `gateway/server.ts`。
 *
 * ## 为什么记账要分「放行」与「记账」两步
 *
 * 放行时只知道请求数，**不知道 token 数**（要等上游回完才知道）。
 * 故：
 *   - 放行 → `countUse({ rejected: false, 但 input/output 记 0 })` 占住请求数名额；
 *   - 结束后 → `settleUsage(...)` 把真实 token 补上去。
 *
 * ⚠️ 如果只在结束时记一次，那么**流式**响应会到最后一刻才计数 ——
 * 并发请求会全部穿过配额检查（「配额形同虚设」）。先占名额是必要的。
 */

import type { Env } from '../env.js'
import type { AccountPoolDO } from '../pool/AccountPoolDO.js'
import {
  type ApiKeyRecord,
  checkQuota,
  hashApiKey,
  isWindowExpired,
  resetUsageWindow,
} from '../store/apikeys.js'

/** 主密钥（`API_KEY` secret）比较：恒定时间。 */
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  // 长度不同也要走完整比较（否则长度会泄漏），故用最大长度循环。
  const len = Math.max(ea.length, eb.length)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < len; i += 1) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  }
  return diff === 0
}

/** 从请求头取 Bearer 明文。 */
export function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length) : ''
}

/**
 * 从请求里取**客户端凭据明文**，同时支持两种头（**Anthropic 客户端必需**）。
 *
 * ## 为什么必须支持 `x-api-key`（真实前提缺失）
 *
 * `Anthropic` 官方 SDK 与 **Claude Code** 发的是 **`x-api-key: <key>`**，
 * 而**不是** `Authorization: Bearer`。我们此前只读后者 ⇒ 接了 `/v1/messages`
 * 也进不来（Claude Code 拿来就会 401，而它不会告诉你「请换个头」）。
 *
 * ## 冲突策略：**同时给且值不同 ⇒ 拒绝**
 *
 * 两个头都带时，若值相同（有些客户端两个都发）就照收；**值不同则拒绝** ——
 * 不允许「任选一个能过的」：那会让一把泄漏的头悄悄覆盖另一把，
 * 也让「我以为用的是 A 密钥」变得不可验证。这与下游实现同口径。
 *
 * ⚠️ 只带一个头（任一）都接受 —— 这是绝大多数客户端的形态。
 *
 * @returns `key` 明文（空串 = 没带）；`conflict` 为真表示两个头值不同。
 */
export function clientKeyOf(request: Request): { key: string; conflict: boolean } {
  const bearer = bearerOf(request)
  // ⚠️ 大小写不敏感：`Headers.get` 本身不区分大小写，但这里显式取别名更清楚
  const rawApiKey = request.headers.get('x-api-key') ?? ''
  const apiKey = rawApiKey.trim()

  if (bearer !== '' && apiKey !== '' && bearer !== apiKey) {
    // 两个都带且不同 ⇒ 拒绝（见上）。返回空 key，由调用方翻译成 401。
    return { key: '', conflict: true }
  }
  // 优先 `Authorization`（既有行为不变），没有才用 `x-api-key`
  return { key: bearer !== '' ? bearer : apiKey, conflict: false }
}

/**
 * 取客户端 IP。
 *
 * ⚠️ 只认 `CF-Connecting-IP`：它是 Cloudflare 边缘**override** 上去的，
 * 客户端伪造不了（其他 `X-Forwarded-*` 可以）。取不到时返回空串，
 * 由 IP 白名单逻辑决定怎么处理（白名单为空 = 不限，空串也能过；
 * 白名单非空 = 空串直接拒），这是 fail-closed 的方向。
 */
export function clientIpOf(request: Request): string {
  return (request.headers.get('cf-connecting-ip') ?? '').trim()
}

/** 鉴权结果。 */
export type AuthResult =
  | { kind: 'admin' }
  | { kind: 'subkey'; record: ApiKeyRecord }
  | { kind: 'none' }
  | { kind: 'subkey-denied'; record: ApiKeyRecord; reason: string; status: number }

/** 子密钥池（全局，存在 `cn` 分片）。 */
function keyPool(env: Env): DurableObjectStub<AccountPoolDO> {
  return env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('cn'))
}

/**
 * 判定 `/v1/*` 请求的身份。
 *
 * 三种结果：
 * 1. `admin` —— 命中 `API_KEY`（全量权限，**不**受任何配额限制）；
 * 2. `subkey` —— 命中一把可用的子密钥（已通过全部配额检查）；
 * 3. `subkey-denied` —— 命中了子密钥但被拒（停用/过期/IP/模型/配额）。
 *
 * ⚠️ 「命中但被拒」必须与「完全没命中」区分开：前者要告诉用户**为什么**，
 * 后者只能说「密钥无效」。把两者混成同一个 401 会让用户拿着一把
 * 明明存在的 Key 却不知道该改什么。
 *
 * @param model - 本次请求要用的模型（`/v1/models` 传空串 = 不做模型检查）。
 */
export async function authenticate(
  request: Request,
  env: Env,
  model: string,
): Promise<AuthResult> {
  // ⚠️ 双头解析：Claude Code / Anthropic SDK 发 `x-api-key`，其余发 `Authorization`。
  // 两个都带且值不同 ⇒ 一律拒绝（见 `clientKeyOf` 的冲突策略）。
  const parsed = clientKeyOf(request)
  if (parsed.conflict) {
    // 退回 `none`（= 401）：**不**告诉调用方是「哪个头不对」——
    // 那等于确认「另一个头是对的」，而滥用者可以据此判断密钥有效性。
    return { kind: 'none' }
  }
  const provided = parsed.key
  if (provided === '') return { kind: 'none' }

  // ① 先比主密钥。⚠️ 顺序有意义：主密钥的处理**不碰 DO**
  //（省一次往返，且主密钥不依赖任何存储状态 —— 即使 DO 挂了管理端仍可用）。
  const expected = env.API_KEY
  if (expected !== undefined && expected !== '' && constantTimeEqual(provided, expected)) {
    return { kind: 'admin' }
  }

  // ② 再按哈希找子密钥。
  //
  // ⚠️ `sk-` 前缀不是必要条件（用户可能自定义），但先做一次廉价前缀判断
  // 可以避免把明显的垃圾串拿去算 SHA-256 —— 那是每个请求都要付的成本。
  const pool = keyPool(env)
  let record: ApiKeyRecord | undefined
  try {
    record = await pool.findApiKeyByHash(await hashApiKey(provided))
  } catch {
    // DO 暂时不可用：**fail-closed**（拒绝），不 fail-open。
    // 放行会让「配额」在 DO 抖动时静默失效。
    return { kind: 'none' }
  }
  if (record === undefined) return { kind: 'none' }

  // ③ 配额 / 范围检查。
  const now = Date.now()
  const ip = clientIpOf(request)
  let usage = await pool.getApiKeyUsage(record.id).catch(() => undefined)
  if (usage === undefined) return { kind: 'none' }

  // ⚠️ 窗口过期要**先重置再判**：否则上一窗口用满的计数会让新窗口
  // 一开局就是「已超限」，密钥永久失效。
  if (isWindowExpired(usage, record.limits, now)) usage = resetUsageWindow(usage, now)

  const verdict = checkQuota(record, usage, ip, model, now)
  if (!verdict.ok) {
    const status = verdict.reason === 'requests' || verdict.reason === 'tokens' ? 429 : 403
    return { kind: 'subkey-denied', record, reason: verdict.message, status }
  }
  return { kind: 'subkey', record }
}

/**
 * 放行后立即「占名额」（请求数 +1，token 先记 0）。
 *
 * ⚠️ 必须**不 await** 由调用方 `waitUntil` 或忽略：它不该拖慢首字节时间。
 * 但失败要打日志 —— 静默失败会让配额静默失效（本项目反复强调的形态）。
 */
export function countUse(
  env: Env,
  record: ApiKeyRecord,
  request: Request,
  model: string,
): Promise<void> {
  return keyPool(env)
    .recordApiKeyUse({
      id: record.id,
      ip: clientIpOf(request),
      model,
      input: 0,
      output: 0,
    })
    .catch((error: unknown) => {
      console.error(
        '[apikey] 记账失败（配额可能失真）：',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
    })
}

/**
 * 请求结束后补齐真实 token 用量。
 *
 * ⚠️ 只加 token，**不再加请求数** —— 请求数已在放行时占过名额。
 * 重复加会让「请求数」直接翻倍。
 */
export function settleUsage(
  env: Env,
  record: ApiKeyRecord,
  input: number,
  output: number,
  model: string,
  ip: string,
): Promise<void> {
  if (input <= 0 && output <= 0) return Promise.resolve()
  return keyPool(env)
    .adjustApiKeyTokens({ id: record.id, ip, model, input, output })
    .catch((error: unknown) => {
      console.error('[apikey] token 记账失败：', error instanceof Error ? error.message : String(error))
    })
}

/**
 * 子密钥上下文（传给网关记账用）。
 *
 * ## ⚠️ 为什么把 IP 一起带上，而不是让网关自己从 request 里读
 *
 * `/v1/responses` 的实现是**新造一个 Request** 再转交给
 * `/v1/chat/completions`（见 responses.ts 的「复用」策略）。那个新对象
 * 只带了 `content-type`，`CF-Connecting-IP` **不会**跟过去 ——
 * 若让网关自己读，会一直记到空 IP，面板上「最后来源 IP」永远是空的
 *（而且很难归因：看着像「面板没渲染」，实际是数据源就错了）。
 *
 * ⇒ 在鉴权处读一次（那里拿的是**原始** request），随上下文传下去。
 */
export interface SubkeyContext {
  record: ApiKeyRecord
  /** 客户端的真实来源 IP（已从原始请求读出）。 */
  ip: string
}
