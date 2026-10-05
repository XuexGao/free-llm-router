/**
 * 网关与账号池的接线：**选号 → 转发 → 记账 → 失败换号**。
 *
 * ## 为什么必须接线（这是架构的核心价值，不是可选优化）
 *
 * 没有接线的网关是「裸代理」：一个账号 429 或余额耗尽，**整个服务立刻不可用**，
 * 而且不会恢复 —— 因为没有任何地方记录「这个号暂时别用」。
 *
 * 接线后形成闭环（对应 Go 侧的 `handler.chatCompletions` 轮转 + `applyErrorPolicy`）：
 *
 * ```
 * pick(排除已试) → 转发 → 成功则 noteSuccess（清熔断）
 *                       ↘ 失败则 applyFailure（按类别落到正确维度）+ 换下一个号
 * ```
 *
 * ## 两个必须守住的纪律
 *
 * 1. **`tried` 集合跨重试保留**：否则会在两个账号之间无限来回
 *    （Go 侧 `account-pool.ts:905-914` 记录过这个缺陷）。
 * 2. **按错误类别罚正确的维度**（AGENTS.md §6.7）：
 *    - `6004` 是**模型级**限流 → 罚 `model`，不罚账号（切模型即可用）；
 *    - `11140` 是强信号 → 直接禁用账号；
 *    - `12153` 要**连续 3 次**才禁用；
 *    - `11115`/`11135` 是**请求的问题**，不罚号、也不换号。
 */

import { resolveUpstream, type Env } from '../env.js'
import { classify, type ErrorKind } from '../upstream/client.js'
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'
import { prepareChatBody, sanitizeChatBody } from './payload.js'
import { aggregateSse, detectErrorFrame, doneFrame, errorFrame, parseSseLine, sseHeaders, translateFrame } from './stream.js'
import { jsonError } from './http.js'
import { DEFAULT_PROVIDER, findProvider, providerIds } from '../providers/index.js'
import { splitModelName, type ProviderCredential } from '../providers/types.js'
import type { LoginCredential } from '../upstream/auth.js'
import type { AccountPoolDO } from '../pool/AccountPoolDO.js'

/** 单次请求最多换号次数（Go 侧 `MaxRotate` 默认 3）。 */
export const MAX_ROTATE = 3

/** 上游错误类别 → 账号池的惩罚维度。 */
export function mapErrorToPunishment(kind: ErrorKind): {
  punish: boolean
  dimension: 'soft' | 'hard' | 'breaker' | 'degrade' | 'session_dead' | 'model'
  /** 该错误是否值得**换号重试**。 */
  rotate: boolean
} {
  switch (kind) {
    // 限流：可能是账号级（14017）或模型级（6004）—— 调用方用错误码进一步区分
    case 'rate_limited':
      return { punish: true, dimension: 'soft', rotate: true }
    // 该后端无此模型：模型级负缓存，换号**可能**有用（不同号挂不同后端）
    case 'model_unavailable':
      return { punish: true, dimension: 'model', rotate: true }
    // 余额耗尽：硬冷却到次日 04:00，换号有用
    case 'credit_exhausted':
      return { punish: true, dimension: 'hard', rotate: true }
    // WAF：账号级软冷却；但可能是 IP 级（详见 AGENTS.md §2.6），换号**无用**
    case 'waf_blocked':
      return { punish: true, dimension: 'soft', rotate: false }
    // 请求非法：强信号，直接禁用；换号无用（同样的非法请求）
    case 'request_illegal':
      return { punish: true, dimension: 'breaker', rotate: false }
    // session 死亡：连续 3 次才禁用；换号有用
    case 'session_dead':
      return { punish: true, dimension: 'session_dead', rotate: true }
    // 5xx：喂熔断；换号有用
    case 'server':
      return { punish: true, dimension: 'breaker', rotate: true }
    // 鉴权失败：续期凭据后重试，**不罚号**（换号可能有用）
    case 'auth_error':
      return { punish: false, dimension: 'soft', rotate: true }
    // 参数类：**不换号**（换号会重放同样的非法请求，放大风控）
    case 'context_exceeded':
    case 'image_invalid':
      return { punish: false, dimension: 'soft', rotate: false }
    // 网络层：抖动量，不构成「这个号坏了」的证据；也不该立刻换号（可能是本地出口抖动）
    case 'network':
      return { punish: false, dimension: 'soft', rotate: false }
    case 'not_found':
    case 'already_done':
    case 'unsupported':
    case 'unknown':
      return { punish: false, dimension: 'soft', rotate: false }
  }
}

/**
 * 从业务码里再细分限流维度：6004 是**模型级**，14017 是**账号级**。
 *
 * ## ⚠️ 为什么必须细分（实测缺陷）
 *
 * 上游 6004 的原话是：
 * > usage exceeds frequency limit, but don't worry, your usage will reset at
 * > 2026-10-05 14:47:23 UTC+8, **alternatively, you can switch to the other** …
 *
 * 「你可以换用**其它模型**」—— 这明确是**模型级**限流。若把它当成账号级
 * 冷却，后果是：**单个账号的供应商**（如只有 1 个 global 账号的 workbuddy）
 * 会在冷却期内**完全不可用**，而真实情况是「换个模型立刻就能用」。
 * 用户看到的现象正是「一会能用一会不能用」。
 */
export function refineModelScoped(
  kind: ErrorKind,
  bodyText: string,
): { dimension: 'soft' | 'model'; code: number | undefined; resetAt: number | undefined } {
  const code = parseBusinessCode(bodyText)
  const resetAt = parseResetAt(bodyText)
  if (kind !== 'rate_limited') return { dimension: 'soft', code, resetAt }
  // 6004 = 模型级限流（切模型即可用，不该罚整个账号）
  if (code === 6004) return { dimension: 'model', code, resetAt }
  return { dimension: 'soft', code, resetAt }
}

/** 从响应体里读业务码（`{"code":6004,...}`）。 */
export function parseBusinessCode(bodyText: string): number | undefined {
  const m = /"code"\s*:\s*(\d+)/.exec(bodyText)
  return m === null ? undefined : Number.parseInt(m[1] ?? '', 10)
}

/**
 * 解析上游在限流文案里给出的**重置时刻**。
 *
 * 上游会明说何时恢复：`your usage will reset at 2026-10-05 14:47:23 UTC+8`。
 * ⚠️ 用它而不是我们自己的退避估算 —— 上游知道真实的重置墙钟，
 * 我们猜的（6h 起指数退避）要么过早（继续撞限流）要么过晚（白白少用几小时）。
 *
 * ⚠️ 时区必须按文案里的 `UTC+8` 偏移换算（**不能**用运行时本地时区：
 * Worker 跑在 UTC，直接 `new Date(str)` 会差 8 小时）。
 * 只认这一种实测到的格式；认不出就返回 undefined（回落到本地退避）。
 */
export function parseResetAt(bodyText: string): number | undefined {
  const m = /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC([+-])(\d{1,2})/.exec(bodyText)
  if (m === null) return undefined
  const [, y, mo, d, h, mi, sec, sign, offRaw] = m
  const offsetHours = Number.parseInt(offRaw ?? '0', 10) * (sign === '-' ? -1 : 1)
  const utcMs = Date.UTC(
    Number.parseInt(y ?? '0', 10),
    Number.parseInt(mo ?? '1', 10) - 1,
    Number.parseInt(d ?? '1', 10),
    Number.parseInt(h ?? '0', 10),
    Number.parseInt(mi ?? '0', 10),
    Number.parseInt(sec ?? '0', 10),
  ) - offsetHours * 60 * 60 * 1000
  return Number.isFinite(utcMs) ? utcMs : undefined
}

/** 选号 + 取凭据。 */
interface Candidate {
  uid: string
  credential: LoginCredential
}

/** 走账号池选号（**排除已试过的**，跨重试保留）。 */
/**
 * 派生**会话粘性 key**（用于把同一会话固定到同一账号，命中上游 prompt cache）。
 *
 * ## key 的选取（按可靠性排序）
 *
 * 1. **客户端显式给的 `user` 字段** —— OpenAI 规范里它就是这个用途
 *    （「代表最终用户的稳定标识符」）。最可靠，且跨轮次稳定。
 * 2. **首条消息的指纹** —— 客户端没给 `user` 时的回落。
 *    取首条 `role+content` 的短哈希：同一会话的后续轮次首条消息**不变**，
 *    故指纹稳定；不同会话几乎必然不同。
 *
 * ⚠️ 刻意**不**用「全部消息的哈希」：那样每加一轮消息 key 就变，
 * 粘性等于没有（每轮都当新会话）。这是最容易写错的地方。
 *
 * ⚠️ 返回空串 = 「无法判定会话」，此时**不做粘性**（回落到常规加权随机）。
 * 编造一个 key 会让不同会话互相干扰，比不做更糟。
 */
async function deriveSessionKey(rawBody: unknown): Promise<string> {
  if (rawBody === null || typeof rawBody !== 'object') return ''
  const body = rawBody as Record<string, unknown>

  // ① 客户端显式的 user 字段（最可靠）
  const user = body.user
  if (typeof user === 'string' && user.trim() !== '') {
    return `u:${(await sha256Hex(user.trim())).slice(0, 32)}`
  }

  // ② 首条消息的指纹
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const first = messages[0]
  if (first === null || typeof first !== 'object') return ''
  const f = first as Record<string, unknown>
  const role = typeof f.role === 'string' ? f.role : ''
  // content 可能是字符串或多模态数组 —— 两种都序列化进来
  const content = f.content
  const material =
    typeof content === 'string'
      ? content
      : content === undefined || content === null
        ? ''
        : JSON.stringify(content)
  if (role === '' && material === '') return ''
  // ⚠️ 只取前 512 字符：超长首条（如带图的多模态）没必要全哈希，
  // 且能避免在大请求上多花 CPU（Free 计划 10ms 铁律）。
  return `m:${(await sha256Hex(`${role}\n${material.slice(0, 512)}`)).slice(0, 32)}`
}

/** SHA-256 → 小写 hex（WebCrypto）。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function pickCandidate(
  pool: DurableObjectStub<AccountPoolDO>,
  realm: string,
  model: string,
  exclude: string[],
  now: number,
  provider: string,
  /** 会话粘性的优先账号（仅首轮传；见 `deriveSessionKey` 的说明）。 */
  preferred?: string,
): Promise<Candidate | undefined> {
  const result = await pool.pick({
    realm, provider, model, exclude, now,
    ...(preferred !== undefined && preferred !== '' ? { preferred } : {}),
  })
  if (result === undefined) return undefined
  const credential = (await pool.getCredential(result.uid)) as LoginCredential | undefined
  if (credential === undefined || credential.accessToken === '') return undefined
  return { uid: result.uid, credential }
}

/** 网关处理结果。 */
export interface GatewayResult {
  response: Response
}

/**
 * 处理 `/v1/chat/completions`：**选号 → 转发 → 记账 → 失败换号**。
 */
export async function handleChatCompletions(
  request: Request,
  env: Env,
  realm = 'cn',
  /**
   * ExecutionContext（可选，便于单测）。
   *
   * ⚠️ 用途是 `waitUntil`：把「流结束后才发生的记账」托住，
   * 否则响应一结束 Worker 就会取消它。
   */
  ctx?: ExecutionContext,
): Promise<GatewayResult> {
  // ① 解析并准备请求体（一次性，不随换号重复）
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return { response: jsonError(400, '请求体必须是合法 JSON', 'invalid_request_error') }
  }

  // 会话粘性 key（空串 = 无法判定会话，此时不做粘性）。
  // ⚠️ 在这里算一次、两条路径共用 —— 不各算一份（会分叉）。
  const sessionKey = await deriveSessionKey(rawBody)

  const rawModel =
    typeof (rawBody as Record<string, unknown>).model === 'string'
      ? ((rawBody as Record<string, unknown>).model as string)
      : ''

  // ⚠️ 多供应商路由：`provider/model` 前缀决定去哪家。
  // 无前缀时回落到默认供应商（保持既有用户兼容 —— 他们已经在用裸模型名）。
  const routed = splitModelName(rawModel, providerIds(), DEFAULT_PROVIDER)
  const providerId = routed.provider
  const model = routed.model

  // ⚠️ **读客户端要的是流式还是非流式**（实测踩到的严重缺陷）。
  //
  // 上游只支持流式，故我们一律以流式请求它；但客户端可能要非流式。
  // 原实现**从不检查**这个字段，一律把 SSE 转发回去 ——
  // 非流式客户端拿到 `data: {...}` 文本，JSON.parse 直接报
  // `Unexpected JSON token at offset 5`（offset 5 就是 `data:` 的冒号）。
  /**
   * 客户端是否要流式。
   *
   * ⚠️ **OpenAI 规范里 `stream` 缺省是 `false`（非流式）**。
   * 我第一版写成「缺省按流式」，结果非流式工具调用（客户端没传 stream）
   * 仍返回 SSE 原文 —— 客户端 `JSON.parse` 报
   * `Unexpected JSON token at offset 5`。已用真实请求复现。
   *
   * 故判据是**严格等 true**：只有显式 `stream: true` 才走流式。
   */
  const wantsStream = (rawBody as Record<string, unknown>).stream === true

  // 非 WorkBuddy 的供应商走独立的 Provider 接口（协议差异极大，
  // 不能把分支塞进下面这段 WorkBuddy 专用逻辑里）。
  if (providerId !== DEFAULT_PROVIDER) {
    return await handleProviderChat({ providerId, model, wantsStream, rawBody, request, env, realm, ctx, tried: [], sessionKey })
  }

  // ⚠️ **必须把请求体里的 model 改写成去前缀的裸名**（实测踩到的真实缺陷，
  // 且必须在 `prepareChatBody` **之前**做 —— 它会连 `model` 一起复制）。
  //
  // 客户端发 `workbuddy/deepseek-v4-flash` 时，若不改写，上游收到带前缀的名字，
  // 回应：`model [workbuddy/deepseek-v4-flash] service info not found`。
  //
  // 后果比「报错」严重得多：该错误被归类为 `model_unavailable`（11102），
  // 于是**给这个模型写了 6 小时的模型级冷却** —— 一个纯粹由我方前缀引起的
  // 失败，被记成了「上游没有这个模型」。此后所有**裸名**请求都会因为这个
  // 冷却而选不到号，对外表现为「没有可用账号」，与真实原因毫无关系。
  //
  // 故这是「一个前缀写错 → 整个模型被拉黑 6 小时」的放大器，必须在这里切断。
  const upstreamBody =
    model !== rawModel && rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : rawBody

  let prepared: string
  try {
    prepared = sanitizeChatBody(prepareChatBody(upstreamBody).body)
  } catch (error) {
    return {
      response: jsonError(400, error instanceof Error ? error.message : String(error), 'invalid_request_error'),
    }
  }

  const bases = resolveUpstream(env)
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))

  // ⚠️ `tried` 必须**跨重试保留**，否则会在两个账号之间无限来回
  // （Go 侧 account-pool.ts:905-914 记录过这个缺陷）。
  const tried: string[] = []
  let lastError: { status: number; message: string; kind: string } | undefined

  // ⚠️ IP 级 WAF 拦截的**前置检查**：激活期内直接失败，**连一个号都不试**。
  // 理由：轮转会把一次客户端请求放大成 N 次撞同一堵墙，反而加重风控
  // （Go 侧实测：3 个账号 1 秒内全部 403）。判据与窗口见 AccountPoolDO 的常量注释。
  if (await pool.wafGateActive(Date.now())) {
    return {
      response: jsonError(
        503,
        '出口 IP 疑似被上游 WAF 拦截（短时间内多个账号接连 403），已暂停轮转以避免加重风控。稍后自动恢复。',
        'waf_ip_blocked',
      ),
    }
  }

  for (let attempt = 0; attempt <= MAX_ROTATE; attempt += 1) {
    const now = Date.now()
    // ⚠️ 限定默认供应商：池里可能同时有 cline 等家的账号，
    // 拿它们的凭据去打 WorkBuddy 端点必然 401（看起来像「凭据坏了」）。
    // 会话粘性：只首轮用（换号后还粘回去会死循环）
    const buddyPreferred =
      tried.length === 0 && sessionKey !== '' ? await pool.getSession(sessionKey, now) : ''
    const candidate = await pickCandidate(
      pool, realm, model, tried, now, DEFAULT_PROVIDER,
      buddyPreferred === undefined ? '' : buddyPreferred,
    )
    if (candidate === undefined) {
      // 没有可用账号了：若之前有过失败，报最后一次的真实原因（更有信息量）
      if (lastError !== undefined) {
        return {
          response: jsonError(lastError.status, `所有可用账号均失败，最后一次：${lastError.message}`, lastError.kind),
        }
      }
      return {
        response: jsonError(
          503,
          '没有可用账号（请先登录/导入凭据；若已导入，检查是否全部处于冷却或禁用状态）',
          'no_available_account',
        ),
      }
    }
    tried.push(candidate.uid)

    // ② 构造出站请求
    const machineId = await deriveDeviceId(candidate.uid, 'machine')
    const sessionId = await deriveDeviceId(candidate.uid, 'session')
    const conversationRequestId = crypto.randomUUID().replaceAll('-', '')

    let upstream: Response
    try {
      upstream = await fetch(`${bases.chat}/v2/chat/completions`, {
        method: 'POST',
        headers: cliChatHeaders({
          uid: candidate.uid,
          machineId,
          sessionId,
          accessToken: candidate.credential.accessToken,
          conversationRequestId,
        }),
        body: prepared,
        signal: request.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { punish } = mapErrorToPunishment('network')
      // 网络层：**不罚号**（抖动量不构成「这个号坏了」的证据）
      void punish
      lastError = { status: 502, message, kind: 'network' }
      continue // 换号重试
    }

    // ③ 上游错误：分类 → 记账 → 决定是否换号
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      const { kind, msg } = classify(upstream.status, text)
      const mapped = mapErrorToPunishment(kind)
      const { dimension, resetAt } = refineModelScoped(kind, text)

      // ⚠️ WAF 403 需要**双记账**：
      // ① 账号级软冷却（下方 applyFailure）—— 让这个号暂时别用；
      // ② **IP 级判定**（noteWaf）—— 若短窗内多个不同号都命中，说明是出口 IP 被拦，
      //    此时继续轮转毫无意义（撞的是同一堵墙），必须 fail-fast。
      if (kind === 'waf_blocked') {
        const ipBlocked = await pool.noteWaf(candidate.uid, Date.now()).catch(() => false)
        if (ipBlocked) {
          lastError = {
            status: 503,
            message: '出口 IP 疑似被 WAF 拦截（短窗内多个账号接连 403）',
            kind: 'waf_ip_blocked',
          }
          break // 不再轮转下一个号
        }
      }

      // 记账（按类别落到正确维度）
      if (mapped.punish) {
        await pool
          .applyFailure({
            uid: candidate.uid,
            kind: kind === 'rate_limited' ? dimension : mapped.dimension === 'model' ? 'model' : mapped.dimension,
            now: Date.now(),
            ...(model !== '' ? { model } : {}),
            // ⚠️ 带上上游给的重置时刻（文案里的 `reset at … UTC+8`）。
            // 模型级冷却据此对齐上游墙钟，而不是我们自己猜 6 小时指数退避 ——
            // 猜早了会继续撞限流，猜晚了白白少用几小时。
            ...(resetAt !== undefined ? { resetAt } : {}),
            ...(msg !== '' ? { reason: `${kind}: ${msg}`.slice(0, 200) } : {}),
          })
          .catch(() => {
            // 记账失败不该让回复失败：这是可观测性问题，不是正确性问题
          })
      }

      lastError = {
        status: upstream.status >= 500 ? 502 : upstream.status,
        message: `${kind}: ${msg || text.slice(0, 160)}`,
        kind,
      }

      if (!mapped.rotate) break // 不该换号（参数错/WAF/网络已单独处理）
      continue // 换号重试
    }

    // ④ 成功：按上游流**逐帧透传**，同时判断是否需要记账
    if (upstream.body === null) {
      lastError = { status: 502, message: '上游返回空 body', kind: 'unknown' }
      continue
    }

    const startedAt = Date.now()
    return {
      response: await streamResponse(upstream.body, {
        onFirstChunk: () => {
          // 首帧到达即算成功（清熔断/降权）
          const okTask = pool.noteSuccess(candidate.uid, Date.now()).catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(okTask)
          else void okTask
        },
        onFinish: (usage) => {
          // 记账用量（面板的「用量」视图靠它）
          //
          // ⚠️ 这里**不能**静默吞错误：第一版写成 `.catch(() => {})`，
          // 结果线上「对话成功但用量恒为 0」，且没有任何日志可查
          // （正是本项目一直在警告的「静默失败」形态）。
          const record = {
            at: Date.now(),
            uid: candidate.uid,
            model,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          const task = pool.recordUsage(record).catch((error: unknown) => {
            console.error(
              '[usage] 记录用量失败：',
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            )
          })
          // ⚠️ 必须 waitUntil：否则响应流结束的瞬间这个 promise 会被取消
          if (ctx !== undefined) ctx.waitUntil(task)
          else void task
        },
        onError: (message) => {
          // 流**内**错误：无法改 HTTP 状态码了，但要记账
          void pool
            .applyFailure({ uid: candidate.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
            .catch(() => {})
        },
      }, wantsStream ? undefined : { model }),
    }
  }

  // 所有轮转都失败
  return {
    response: jsonError(
      lastError?.status ?? 502,
      lastError === undefined ? '所有账号均失败' : `所有账号均失败，最后一次：${lastError.message}`,
      lastError?.kind ?? 'upstream_error',
    ),
  }
}

/**
 * 把上游 body 逐帧转换成给客户端的 SSE 流。
 *
 * ⚠️ **绝不缓冲**：不 `await response.text()`，否则 Free 计划的 10ms CPU
 * 会在长回答上超限，且客户端失去逐字输出。
 */
function streamResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  hooks: {
    onFirstChunk: () => void
    onError: (message: string) => void
    /** 流结束时回调，带上从流里解析到的 usage（用于面板用量统计）。 */
    onFinish?: (usage: { input: number; output: number } | undefined) => void
  },
  /**
   * 客户端要**非流式**时传 true：内部仍按流式读上游，但最后聚合成一个
   * JSON 响应（见 `aggregateSse` 的说明）。
   */
  nonStreaming?: { model: string },
): Response | Promise<Response> {
  let notified = false

  // ⚠️ 非流式：**必须缓冲**（非流式的语义就是「一次给完」）。
  // 与流式路径的取舍相反 —— 那条路径逐帧透传是为了省 CPU（10ms 纪律），
  // 而这条只在客户端显式要非流式时走。
  if (nonStreaming !== undefined) {
    return nonStreamingResponse(upstreamBody, nonStreaming.model, hooks)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const reader = upstreamBody.getReader()
      let buffer = ''
      let sawChunk = false
      let sawDone = false
      // 从流里抓 usage（末帧带 include_usage=true 时会有）
      let usage: { input: number; output: number } | undefined

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // ⚠️ `{stream:true}` 必需：多字节字符可能跨 chunk，否则解码出乱码
          buffer += decoder.decode(value, { stream: true })

          let nl = buffer.indexOf('\n')
          while (nl >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            const frame = parseSseLine(line)

            if (frame.kind === 'done') {
              sawDone = true
              controller.enqueue(encoder.encode(doneFrame()))
            } else if (frame.kind === 'chunk' && frame.data !== undefined) {
              if (!notified) {
                notified = true
                hooks.onFirstChunk()
              }
              // 只在**可能**是错误帧时才解析（正常帧原样转发，省 CPU）
              if (frame.data.includes('"error"') || frame.data.includes('"statusCodeValue"') || frame.data.includes('"stackTrace"') || frame.data.includes('"code"')) {
                const errMsg = tryDetectError(frame.data)
                if (errMsg !== undefined) {
                  hooks.onError(errMsg)
                  controller.enqueue(encoder.encode(errorFrame(errMsg)))
                  nl = buffer.indexOf('\n')
                  continue
                }
              }
              sawChunk = true
              // 只在字面量含 usage 时才解析（省 CPU）
              if (frame.data.includes('"usage"')) {
                try {
                  const parsed = JSON.parse(frame.data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
                  const u = parsed.usage
                  if (u !== undefined && typeof u.prompt_tokens === 'number') {
                    usage = { input: u.prompt_tokens, output: u.completion_tokens ?? 0 }
                  }
                } catch {
                  // usage 解析失败不影响转发
                }
              }
              controller.enqueue(encoder.encode(translateFrame(frame.data)))
            } else if (frame.kind === 'error') {
              // ⚠️ 非预期形状必须让客户端看到（不静默丢）
              controller.enqueue(encoder.encode(errorFrame(frame.error ?? '非预期帧')))
            }
            nl = buffer.indexOf('\n')
          }
        }

        // 流结束但从未产生内容 → 明确报「疑似截断」，而不是假装模型没话说
        if (!sawChunk && !sawDone) {
          const msg = '上游流在产生任何内容前结束（疑似被截断）'
          hooks.onError(msg)
          controller.enqueue(encoder.encode(errorFrame(msg)))
        }
        if (!sawDone) controller.enqueue(encoder.encode(doneFrame()))
        hooks.onFinish?.(usage)
      } catch (error) {
        const msg = `流传输中断：${error instanceof Error ? error.message : String(error)}`
        hooks.onError(msg)
        hooks.onFinish?.(undefined)
        controller.enqueue(encoder.encode(errorFrame(msg)))
        controller.enqueue(encoder.encode(doneFrame()))
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // 忽略
        }
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
}

/** 尝试解析并识别错误帧（失败返回 undefined）。 */
function tryDetectError(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return detectErrorFrame(parsed as Record<string, unknown>)
  } catch {
    return `无法解析的上游帧：${data.slice(0, 160)}`
  }
}


/**
 * 非 WorkBuddy 供应商的对话处理。
 *
 * ## 为什么要单独一条路径，而不是复用上面那段
 *
 * 上面那段是 **WorkBuddy 专用**的：它依赖 `/v2/chat/completions` 这个固定路径、
 * 四套客户端指纹、`prepareChatBody` 的 4 处必改、以及 WorkBuddy 特有的错误码表。
 * 把这些塞进一个「通用」循环里，只会让 WorkBuddy 的逻辑被稀释、
 * 而其它供应商仍要写一堆 `if (provider === ...)`。
 *
 * ⇒ 供应商差异**全部**收敛到 `Provider` 接口（见 `src/providers/types.ts`），
 * 这里只做「选号 → 调接口 → 记账 → 换号」这件与供应商无关的事。
 */
async function handleProviderChat(input: {
  providerId: string
  model: string
  /** 客户端是否要流式（false ⇒ 聚合成非流式 JSON）。 */
  wantsStream: boolean
  rawBody: unknown
  request: Request
  env: Env
  realm: string
  ctx?: ExecutionContext
  tried: string[]
  /** 会话粘性 key（由 `handleChatCompletions` 统一派生，空串 = 不做粘性）。 */
  sessionKey: string
}): Promise<GatewayResult> {
  const { providerId, model, wantsStream, rawBody, request, env, realm, ctx, sessionKey } = input

  const provider = findProvider(providerId)
  if (provider === undefined) {
    return { response: jsonError(404, `未知供应商「${providerId}」`, 'unknown_provider') }
  }
  if (!provider.capabilities.chat) {
    // ⚠️ 显式说明**为什么**不可用，而不是笼统报错
    return {
      response: jsonError(
        501,
        `供应商「${provider.name}」当前不支持对话。` +
          (provider.capabilities.loginBlockedReason ?? ''),
        'provider_chat_unsupported',
      ),
    }
  }

  // ⚠️ **realm 自动回退**（实测踩到：国际版登录成功却报「没有可用账号」）。
  //
  // 账号按凭据的 `extras.realm` 分片存放（WorkBuddy 国际版在 `global`），
  // 而客户端选分片靠查询参数 `?realm=`，缺省 `cn`。
  // 于是「国际版登录成功 → 用的时候报没有账号」，用户完全看不出
  // 是分片选错了（账号明明在，只是在另一个分片）。
  //
  // 只在「该分片里这个供应商**一个账号都没有**」时回退 ——
  // 否则会把「有账号但都在冷却」误判成「该换分片」，掩盖真实原因。
  let activeRealm = realm
  {
    const probe = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
    const hasHere = (await probe.listAccounts(realm, Date.now())).some(
      (a) => (a.provider ?? DEFAULT_PROVIDER) === providerId,
    )
    if (!hasHere) {
      const other = realm === 'cn' ? 'global' : 'cn'
      const probeOther = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(other))
      const hasOther = (await probeOther.listAccounts(other, Date.now())).some(
        (a) => (a.provider ?? DEFAULT_PROVIDER) === providerId,
      )
      if (hasOther) activeRealm = other
    }
  }

  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(activeRealm))
  // ⚠️ 与 WorkBuddy 路径同理：请求体里的 `model` 必须换成**去前缀**的裸名。
  // 各 provider 的 `chat()` 会把它直接放进上游请求，带前缀会被上游判为
  // 「没有这个模型」—— 而这个错误又会被记成模型级冷却（见上面的长注释）。
  const body =
    rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? { ...(rawBody as Record<string, unknown>), model }
      : (rawBody as Record<string, unknown>)
  const tried = input.tried
  let lastError: { status: number; message: string } | undefined

  for (let attempt = 0; attempt <= MAX_ROTATE; attempt += 1) {
    const now = Date.now()
    // ⚠️ 供应商过滤交给 `pick()` 做（`provider` 字段），
    // **不要**在这里「先选中再筛掉」—— 那会让「池里有账号但当前供应商没账号」
    // 表现为「pick 返回了号、却被我丢掉」，最终误报「没有可用账号」（实测踩到）。
    // ⚠️ **会话粘性**：优先用该会话已绑定的账号（命中上游 prompt cache）。
    // `preferred` 只是「排到最前」，不可用时自然回落 —— 不会因为它挂了就报「无可用账号」。
    // ⚠️ 只在**首轮**（`tried` 为空）用粘性：已经在换号了还粘回去会死循环。
    const preferred = tried.length === 0 ? (sessionKey === '' ? '' : await pool.getSession(sessionKey, now)) : ''
    const picked = await pool.pick({ realm: activeRealm, provider: providerId, model, exclude: tried, now, ...(preferred !== undefined && preferred !== '' ? { preferred } : {}) })
    if (picked === undefined) break
    tried.push(picked.uid)

    const credential = (await pool.getCredential(picked.uid)) as ProviderCredential | undefined
    if (credential === undefined) {
      lastError = { status: 500, message: '账号缺少凭据' }
      continue
    }

    const startedAt = Date.now()
    // ⚠️ 续期只试一次（见下方 401 分支的说明）。
    let refreshed = false
    let upstream: Response
    try {
      upstream = await provider.chat(credential, { model, body, signal: request.signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // ⚠️ **续期也要在 catch 分支里做**（实测踩到的架构不一致）。
      //
      // 8 家 provider 的 `chat()` 在非 200 时**抛 `ProviderError`**，
      // 而不是返回 `Response`（只有 opencode 返回）。于是网关的
      // `!upstream.ok` 分支**永远走不到** —— 401 续期逻辑形同虚设，
      // 表现为「cline 的 token 明明可以续期，却一直报 401」。
      //
      // 这里按同样的判据（鉴权类错误）尝试续期并重放一次。
      if (isAuthLikeFailure(0, message) && provider.refresh !== undefined && !refreshed) {
        try {
          refreshed = true
          const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
          await pool.putCredential(picked.uid, fresh, Date.now())
          console.warn(`[refresh] ${providerId} 续期成功（catch 分支），已回写凭据`)
          const retry = await provider.chat(fresh, { model, body, signal: request.signal })
          if (retry.ok && retry.body !== null) {
            const startedAt2 = Date.now()
            return {
              response: await streamResponse(retry.body, {
                onFirstChunk: () => {
                  const t = pool.noteSuccess(picked.uid, Date.now()).catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                  // ⚠️ 首帧到达即绑定会话 —— 此后同一会话优先落这个账号，
                  // 从第二轮起命中上游 prompt cache（更快、更省）。
                  if (sessionKey !== '' && ctx !== undefined) {
                    ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(() => {}))
                  }
                },
                onError: (m) => {
                  const t = pool
                    .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: m.slice(0, 200) })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
                onFinish: (usage) => {
                  const t = pool
                    .recordUsage({
                      at: Date.now(), uid: picked.uid, model: `${providerId}/${model}`,
                      input: usage?.input ?? 0, output: usage?.output ?? 0, ok: true,
                      ms: Date.now() - startedAt2,
                    })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
              }, wantsStream ? undefined : { model }),
            }
          }
        } catch (refreshError) {
          console.error(
            `[refresh] ${providerId} 续期失败：`,
            refreshError instanceof Error ? refreshError.message : String(refreshError),
          )
        }
      }

      lastError = { status: 502, message }
      // 传输层失败：换号可能有用（也可能是本地出口抖动）
      continue
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')

      // ⚠️ **401/403 先尝试续期，而不是直接判失败**（实测踩到）。
      //
      // 上游令牌都有寿命（实测本地凭据过期 5–7 小时），过期后所有请求 401。
      // 若不续期，账号用一天就废；而用户看到的是「凭据坏了」，
      // 完全想不到「只是该续期了」。
      //
      // 只试**一次**（`refreshed` 标记）：续期后仍 401 说明 refresh token 也废了，
      // 再试只是无谓地打上游。
      // ⚠️ **判据是「响应内容像鉴权失败」，不是「状态码等于 401/403」**。
      //
      // 实测踩到：CodeArts 的 security_token 过期报的是 **HTTP 400** +
      // `{"error_code":"APIG.0602","error_msg":"...security token has expired"}`。
      // 只看状态码的话，这个分支根本不进 —— 续期逻辑形同虚设，
      // 而 catch 分支（另一条路）已经改成按内容判了，两条路判据必须一致。
      if (isAuthLikeFailure(upstream.status, text) && provider.refresh !== undefined && !refreshed) {
        try {
          refreshed = true
          const fresh = await provider.refresh(credential, AbortSignal.timeout(30_000))
          await pool.putCredential(picked.uid, fresh, Date.now())
          // ⚠️ 重放请求（用新凭据）。这里直接用 continue 会重新选号，
          // 但我们要的是**同一个号**换新令牌重试 —— 故显式再发一次。
          const retry = await provider.chat(fresh, { model, body, signal: request.signal })
          if (retry.ok && retry.body !== null) {
            const startedAt2 = Date.now()
            return {
              response: await streamResponse(retry.body, {
                onFirstChunk: () => {
                  const t = pool.noteSuccess(picked.uid, Date.now()).catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                  // 会话粘性：首帧到达即绑定，后续轮次优先落同一账号
                  if (sessionKey !== '' && ctx !== undefined) {
                    ctx.waitUntil(pool.bindSession(sessionKey, picked.uid, Date.now()).catch(() => {}))
                  }
                },
                onError: (message) => {
                  const t = pool
                    .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
                onFinish: (usage) => {
                  const t = pool
                    .recordUsage({
                      at: Date.now(), uid: picked.uid, model: `${providerId}/${model}`,
                      input: usage?.input ?? 0, output: usage?.output ?? 0, ok: true,
                      ms: Date.now() - startedAt2,
                    })
                    .catch(() => {})
                  if (ctx !== undefined) ctx.waitUntil(t)
                },
              }, wantsStream ? undefined : { model }),
            }
          }
        } catch (error) {
          // 续期失败（refresh token 也废了）→ 落回正常失败路径，
          // 并把这个号标成需要重新登录（软冷却，避免每请求都试一次续期）。
          console.error(
            `[refresh] ${providerId} 续期失败：`,
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      const rotate = provider.shouldRotate?.(upstream.status, text) ?? (upstream.status === 429 || upstream.status === 402)

      // ⚠️ **429 不能一律当账号级冷却**（实测缺陷，用户报「一会能用一会不能用」）。
      //
      // 上游 6004 说的是「usage exceeds frequency limit … alternatively, you can
      // switch to the other models」= **模型级**限流。而这条 provider 路径原先
      // 硬编码 `429 → soft`（账号级），于是**单个账号的供应商**
      //（如只有 1 个 global 账号的 workbuddy）在冷却期**完全不可用**。
      //
      // 复用与 buddy 路径相同的细分判据，避免两条路径口径分叉
      //（此前 buddy 路径已细分、这里没有 —— 同一个 bug 修了一半）。
      const refined = refineModelScoped(upstream.status === 429 ? 'rate_limited' : 'unknown', text)
      const failureKind: 'soft' | 'hard' | 'model' | 'breaker' =
        upstream.status === 402
          ? 'hard'
          : upstream.status === 429
            ? refined.dimension
            : 'breaker'
      await pool
        .applyFailure({
          uid: picked.uid,
          kind: failureKind,
          now: Date.now(),
          ...(model !== '' ? { model } : {}),
          // ⚠️ 带上上游给的重置时刻（文案里有 `reset at … UTC+8`）：
          // 模型级冷却据此对齐上游墙钟，而不是我们自己猜 6 小时。
          ...(refined.resetAt !== undefined ? { resetAt: refined.resetAt } : {}),
          reason: `${providerId} http=${upstream.status}: ${text.slice(0, 160)}`,
        })
        .catch(() => {})
      lastError = { status: upstream.status >= 500 ? 502 : upstream.status, message: text.slice(0, 300) || `http=${upstream.status}` }
      if (!rotate) break
      continue
    }

    if (upstream.body === null) {
      lastError = { status: 502, message: '上游返回空 body' }
      continue
    }

    return {
      response: await streamResponse(upstream.body, {
        onFirstChunk: () => {
          const t = pool.noteSuccess(picked.uid, Date.now()).catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(t)
        },
        onError: (message) => {
          const t = pool
            .applyFailure({ uid: picked.uid, kind: 'breaker', now: Date.now(), reason: message.slice(0, 200) })
            .catch(() => {})
          if (ctx !== undefined) ctx.waitUntil(t)
        },
        onFinish: (usage) => {
          const record = {
            at: Date.now(),
            uid: picked.uid,
            // ⚠️ 用量里记**带前缀**的模型名：否则多供应商下的同名模型会混在一起
            model: `${providerId}/${model}`,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            ok: true,
            ms: Date.now() - startedAt,
          }
          const t = pool.recordUsage(record).catch((error: unknown) => {
            console.error('[usage] 记录用量失败：', error instanceof Error ? error.message : String(error))
          })
          if (ctx !== undefined) ctx.waitUntil(t)
          else void t
        },
      }, wantsStream ? undefined : { model }),
    }
  }

  return {
    response: jsonError(
      lastError?.status ?? 503,
      lastError === undefined
        // ⚠️ 区分「真的没账号」与「有账号但全在冷却/熔断」。
        // 实测踩到：账号因连续失败进了熔断，报的却是「请先导入凭据」——
        // 用户会去重新导入一份好凭据，而真实原因是**等几分钟就好**。
        ? (await describeNoAccount(env, activeRealm, providerId))
        : `供应商「${provider.name}」请求失败：${lastError.message}`,
      'provider_error',
    ),
  }
}


/**
 * 这次失败看起来是**鉴权类**问题吗（该续期）。
 *
 * ## ⚠️ 为什么必须抽成公共函数（实测踩到两次）
 *
 * 这个判据在网关里有**两个调用点**（`!upstream.ok` 分支与 `catch` 分支），
 * 因为 provider 的 `chat()` 有两种失败风格：有的返回非 2xx Response
 *（opencode），有的直接抛 `ProviderError`（其余 8 家）。
 *
 * 我第一版只放宽了 `catch` 分支，忘了 `!upstream.ok` 分支 ——
 * 于是 CodeArts（返回 Response 的那条路）仍然不续期，
 * 表现为「明明能续期却一直报 security token expired」。
 * 抽出来从根上避免两处再分叉。
 *
 * ## 判据要**宽**
 *
 * 各家的鉴权错误文案千差万别，且**状态码也各不相同**：
 * - WorkBuddy: `auth_error` / `upstream 401`
 * - Raccoon:   `code=200003` + `authorization_verify_error`
 * - Cline:     `http=401` + `Unauthorized`
 * - CodeArts:  **HTTP 400** + `APIG.0602` + `security token has expired`
 *
 * 宁可偶尔多试一次续期（续期失败会落回原错误），也不要漏掉真正的鉴权失败。
 */
/**
 * 生成「选不到号」的**准确**说明。
 *
 * ⚠️ 不能一律说「请先导入凭据」（实测踩到的误导）：
 * 账号可能只是**在冷却/熔断**里（`until` / `breakerUntil` / `degradeUntil`），
 * 等几分钟自己就好了。让用户去重新导入凭据是纯粹的浪费时间。
 */
export async function describeNoAccount(
  env: Env,
  realm: string,
  provider: string,
): Promise<string> {
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const accounts = (await pool.listAccounts(realm, Date.now())).filter(
    (a) => (a.provider ?? 'workbuddy') === provider,
  )
  if (accounts.length === 0) {
    return `供应商「${provider}」没有账号（请先在面板导入该供应商的凭据）`
  }
  const now = Date.now()
  const cooling = accounts.filter((a) => a.until > now || a.breakerUntil > now || a.degradeUntil > now)
  if (cooling.length > 0) {
    // 取最长的剩余时间（用户关心的是「还要等多久」）
    const waits = cooling.map((a) => Math.max(a.until, a.breakerUntil, a.degradeUntil) - now)
    const maxWait = Math.max(...waits)
    const mins = Math.max(1, Math.round(maxWait / 60_000))
    return `供应商「${provider}」的 ${accounts.length} 个账号都在冷却中（因连续失败触发退避），约 ${mins} 分钟后自动恢复`
  }
  const disabled = accounts.filter((a) => a.disabled)
  if (disabled.length === accounts.length) {
    return `供应商「${provider}」的账号都被手动禁用了（请在面板启用）`
  }
  return `供应商「${provider}」暂时没有可用账号（请稍后重试或查看面板状态）`
}

export function isAuthLikeFailure(status: number, detail: string): boolean {
  // 状态码：401/403 是标准鉴权失败；400 也可能（CodeArts 就是这样）
  if (status === 401 || status === 403) return true
  return /auth_error|unauthor|forbidden|invalid.?token|token.?expir|expired|200003|APIG\.0602|42400/i.test(
    detail,
  )
}

/**
 * 非流式响应：把上游 SSE 读完、聚合成一个 `chat.completion`。
 *
 * ⚠️ 这里的 `await reader.read()` 会一直读到上游结束 —— 对长回答可能耗时较久。
 * 这是**非流式的固有代价**（客户端要的就是「等完整结果」），
 * 且等待网络 I/O **不计入 CPU 预算**（AGENTS.md §8.2.2 第 2 条）。
 */
async function nonStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  hooks: {
    onFirstChunk: () => void
    onError: (message: string) => void
    onFinish?: (usage: { input: number; output: number } | undefined) => void
  },
): Promise<Response> {
  const reader = upstreamBody.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 忽略
    }
  }

  const completion = aggregateSse(raw, { model, now: Date.now() })
  const choice = completion.choices[0]

  // 上游错误以 SSE 帧形式返回（HTTP 200）：必须显式报错，不能假装成功。
  //
  // ⚠️ 判据是「**没有正文也没有思考过程**」，不能只看 `usage`。
  // 实测踩到：CodeArts 的模型名错误帧既没有 `usage` 也没有正文，
  // 而某次判断只查了 usage —— 结果给客户端一个 `content:''` 的空回答，
  // 用户以为是模型不行，其实是模型名写错了。
  if (
    choice !== undefined
    && choice.message.content === ''
    && (choice.message.reasoning_content ?? '') === ''
    && (completion.usage === undefined || completion.usage === null)
  ) {
    // ⚠️ **先处理「整个响应体就是一个 JSON（不是 SSE）」的情况**。
    //
    // 实测踩到：某些上游（如 CodeArts 经华为 APIG）在 HTTP **200** 下直接
    // 回一个**裸 JSON 错误体**，完全没有 `data: ` 前缀。此时：
    // - `aggregateSse` 找不到任何 `data:` 行 ⇒ 产出空 completion；
    // - 下面的逐行扫描也要求 `line.startsWith('data: ')` ⇒ 同样找不到错误。
    // 结果客户端拿到 `content:'' + finish_reason:'stop'` 的**空回答**，
    // 完全看不出上游其实报错了。
    //
    // 故这里先尝试把整个 body 当 JSON 解析，并用同一套 `detectErrorFrame`
    // 判据识别错误。
    const trimmedRaw = raw.trim()
    if (trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) {
      try {
        const whole = JSON.parse(trimmedRaw) as Record<string, unknown>
        const wholeErr = detectErrorFrame(whole)
        if (wholeErr !== undefined) {
          hooks.onError(wholeErr)
          return jsonError(502, wholeErr, 'upstream_error')
        }
      } catch {
        // 不是合法 JSON：交给下面的逐帧扫描
      }
    }

    // 流里没有任何内容 —— 找一下是不是错误帧
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        const err = detectErrorFrame(parsed)
        if (err !== undefined) {
          hooks.onError(err)
          return jsonError(502, err, 'upstream_error')
        }
      } catch {
        // 非 JSON 帧，继续找
      }
    }
  }

  hooks.onFirstChunk()
  const usage = completion.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  hooks.onFinish?.(
    usage === undefined
      ? undefined
      : { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 },
  )
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
