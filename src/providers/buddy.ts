/**
 * 腾讯 CodeBuddy / WorkBuddy 供应商适配器（**两个变体，一套实现**）。
 *
 * 把既有的 `src/upstream/*` 与 `src/gateway/*` 包成统一的 `Provider` 接口。
 * **这是参考实现** —— 其它供应商照此结构写。
 *
 * ## 为什么是一个工厂产出两个变体
 *
 * 腾讯这两条产品线**协议完全相同**（同一套 `/v3/config`、`/v2/chat/completions`、
 * 四套客户端指纹），差异只在**域名与能力**：
 *
 * | 变体 | id | 端点 | 签到 |
 * |---|---|---|---|
 * | 国内版 | `buddy` | `copilot.tencent.com` / `www.codebuddy.cn` | ✅ 有 |
 * | 国际版 | `workbuddy` | `www.workbuddy.ai` | ❌ **无签到接口** |
 *
 * 故共用一套代码、只换配置。若拆成两个文件会立刻产生 200 行重复，
 * 且上游一改协议就要改两处（正是本项目在别处反复避免的形态）。
 *
 * ⚠️ **命名历史**：本项目早期只有国内版，当时它叫 `workbuddy`。
 * 接入国际版后按参考项目（`deepseek-harness-codearts/src/product.ts:76`）的口径
 * 把 id 定为 `buddy`（国内）/ `workbuddy`（国际）——
 * 这**改变了既有 `workbuddy` 的含义**，故必须做数据迁移（见 `migrateBuddyProviderId`）。
 *
 * ## 本供应商的特殊之处（与其它家不同，不要照抄到别家）
 *
 * - 模型目录在 `/v3/config`（不是 OpenAI 的 `/v1/models`）；
 * - 响应形状是 `data.models[]` **单层**（实测 54 个模型）；
 * - 对话请求体有 4 处必须改写（见 `gateway/payload.ts`）；
 * - 模型 id 是裸的（无 `provider/` 前缀），与既有用户兼容。
 */

import { type Env } from '../env.js'
import { cliChatHeaders, deriveDeviceId, referenceChatHeaders } from '../upstream/headers.js'
import { extractModels, type OpenAiModel } from '../gateway/models.js'
import { prepareChatBody, sanitizeChatBody } from '../gateway/payload.js'
import { parseAuthDocument, parseAuthPayload } from '../upstream/import.js'
import { dailyCheckin, fetchBalance } from '../upstream/checkin.js'
import { refreshCredential } from '../upstream/auth.js'
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderBalance,
  type CheckinResult,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

/** 变体标识。 */
export type BuddyVariant = 'buddy' | 'workbuddy'

/**
 * 一个变体的全部差异（**单一真相源**）。
 *
 * ⚠️ 刻意**不**从 `env` 读 base —— 两个变体同时存在，
 * 而 `env` 里只有一份 `UPSTREAM_*`（历史原因，服务国内版）。
 * 若让两家都读 env，切换供应商时就会用错域名。
 * env 仅作为**国内版**的覆盖口（便于本地调试指向 mock）。
 */
interface VariantConfig {
  id: BuddyVariant
  name: string
  /** 控制面：模型目录、chat、token 刷新。 */
  chatBase: string
  /** 计费面：签到、余额。 */
  billingBase: string
  /** Web 面：任务领奖、web 事件。 */
  webBase: string
  /** 是否支持每日签到。 */
  checkin: boolean
  /** 不支持签到时给用户的原因。 */
  checkinBlockedReason?: string
  /**
   * 是否**要求首条消息必须是 `role: 'system'`**。
   *
   * ⚠️ 国际版（workbuddy.ai）有这个硬要求：首条不是 system 时返回
   * **HTTP 400 + code 11128** `"first message is not system prompt"`，
   * 而且 `displayMsg` 把它**伪装成安全策略拦截**（"blocked by security"），
   * 极易误判成账号被封。
   * 依据：`deepseek-harness-codearts/src/account-probe.ts:93-107,326-327`。
   *
   * 国内版（codebuddy.cn）**没有**这个要求（同上文件的对照表）。
   */
  requiresSystemFirst?: boolean
}

/**
 * 国内版（腾讯 CodeBuddy / WorkBuddy 中国区）。
 *
 * 端点来自参考项目 `src/product.ts:269-274`（`id: 'buddy'`，
 * `endpoint: 'https://copilot.tencent.com'`）。
 */
export const BUDDY_CN: VariantConfig = {
  id: 'buddy',
  name: 'Buddy（国内版）',
  chatBase: 'https://copilot.tencent.com',
  billingBase: 'https://www.codebuddy.cn',
  webBase: 'https://www.workbuddy.cn',
  checkin: true,
}

/**
 * 国际版（WorkBuddy AI）。
 *
 * 端点来自参考项目 `src/product.ts:382-388`：
 * `id: 'workbuddy'`、`platform: 'workbuddy-ai'`、
 * `endpoint: 'https://www.workbuddy.ai'`，并明确注明
 * **「该产品没有每日签到积分接口」**（内核里只有
 * `/v2/billing/meter/get-dosage-notify`）。
 *
 * ⚠️ 故 `checkin: false` 是**如实声明**，不是遗漏 ——
 * 参考项目也因此在 Jet Hub 里不为它渲染「一键领取积分」按钮。
 */
/**
 * 若该变体要求「首条必须是 system」，则按需补一条。
 *
 * ⚠️ 只在**缺失**时补：客户端自己传了 system 就尊重它，
 * 不能覆盖用户精心写的系统提示词。
 */
function withSystemFirst(input: unknown, required: boolean): unknown {
  if (!required) return input
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  const body = input as Record<string, unknown>
  const messages = body.messages
  if (!Array.isArray(messages)) return input
  const first = messages.length > 0 ? (messages[0] as Record<string, unknown> | undefined) : undefined
  // ⚠️ **`developer` 也要算「已有 system」**（实测缺陷）。
  //
  // pi 这类客户端把系统提示词放在 `{role:'developer'}` 里（OpenAI 新规范），
  // 而它在 `prepareChatBody` 里会被**降级为 `system`**（见 payload.ts）。
  // 若这里只认 `role === 'system'`，就会**多补一条**无用的
  // 「You are a helpful assistant.」并排在真正的提示词**前面** ——
  // 那会稀释（甚至覆盖）客户端自己的行为约束。
  const roleOf = (m: Record<string, unknown> | undefined): string =>
    m === undefined ? '' : typeof m.role === 'string' ? m.role : ''
  const firstRole = roleOf(first)
  if (firstRole === 'system' || firstRole === 'developer') return input
  return {
    ...body,
    messages: [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages],
  }
}

export const WORKBUDDY_INTL: VariantConfig = {
  id: 'workbuddy',
  name: 'WorkBuddy（国际版）',
  chatBase: 'https://www.workbuddy.ai',
  billingBase: 'https://www.workbuddy.ai',
  webBase: 'https://www.workbuddy.ai',
  // ⚠️ 首条必须是 system（见 VariantConfig 上该字段的说明）
  requiresSystemFirst: true,
  checkin: false,
  checkinBlockedReason:
    '国际版没有每日签到积分接口（积分领取在 CodeBuddy 侧完成）——'
    + '这是上游产品形态，不是本服务的缺失。',
}

/**
 * 解析凭据。
 *
 * ⚠️ 复用既有的 `parseAuthDocument` —— 它已经处理了三种真实形态：
 * Go 版嵌套形、扁平 camelCase、DSH snake_case，
 * 以及「`expiresAt` 秒 vs 毫秒」这个踩过的坑。
 *
 * ⚠️ 国内版与国际版的凭据**形态完全相同**，无法从字段区分 ——
 * 故不做形状判别（`matchesShape` 不声明），只接受**显式声明**或默认兜底。
 * 用 `domain` 字段辅助判断（国际版凭据的 domain 会是 `www.workbuddy.ai`）。
 */
function makeParseCredential(config: VariantConfig) {
  return function parseCredential(input: unknown): ProviderCredential {
    let first
    try {
      const candidates = parseAuthPayload(input)
      const head = candidates[0]
      if (head === undefined) throw new Error('凭据为空')
      first = parseAuthDocument(head.raw, head.source)
    } catch (error) {
      throw new ProviderError({
        provider: config.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // ⚠️ 凭据里的 domain 若指向国际版，说明它是国际账号 ——
    // 此时若被解析成国内版，后续请求会打错域名（必然 401）。
    // 这里**不静默接受**，而是明确报错让用户改声明。
    if (config.id === BUDDY_CN.id && first.domain.includes('workbuddy.ai')) {
      throw new ProviderError({
        provider: config.id,
        message:
          '这份凭据的 domain 指向国际版（workbuddy.ai），不能用国内版（buddy）的端点。'
          + '请在导入时显式声明 `"provider":"workbuddy"`。',
      })
    }

    return {
      provider: config.id,
      uid: first.uid,
      accessToken: first.accessToken,
      refreshToken: first.refreshToken,
      expiresAt: first.expiresAt,
      nickname: first.nickname,
      // ⚠️ `enterpriseId` 必须存下来：续期请求要带 `X-Enterprise-Id` 头
      //（见 upstream/auth.ts 的 refreshCredential），丢了会导致企业账号续期失败。
      extras: { realm: first.realm, domain: first.domain, enterpriseId: first.enterpriseId },
    }
  }
}

/** 把上游模型条目映射成统一形状。 */
export function toProviderModels(models: OpenAiModel[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    // ⚠️ 用上游下发的真实值；缺失才回落 0=未知。
    // **不要编造数值** —— 编造会让客户端算出错误的上下文预算。
    contextWindow: m.contextWindow ?? 0,
    maxOutput: m.maxOutput ?? 0,
    supportsImage: m.supportsImage ?? false,
    // 「免费」上游不直接下发（是营销状态，随时可变），故保持 false，
    // 不猜测 —— 猜错会让用户以为某个付费模型免费。
    isFree: false,
  }))
}

/** 构造一个变体的 Provider（绑定该变体的域名）。 */
export function buildBuddyProvider(config: VariantConfig, env?: Env): Provider {
  /** 国内版允许被 env 覆盖（本地调试指向 mock）；国际版恒用官方域名。 */
  const bases =
    config.id === BUDDY_CN.id && env !== undefined
      ? {
          chat: env.UPSTREAM_CHAT_BASE || config.chatBase,
          billing: env.UPSTREAM_BILLING_BASE || config.billingBase,
          web: env.UPSTREAM_WEB_BASE || config.webBase,
        }
      : { chat: config.chatBase, billing: config.billingBase, web: config.webBase }

  async function listModels(credential: ProviderCredential): Promise<ProviderModel[]> {
    const machineId = await deriveDeviceId(credential.uid, 'machine')
    const sessionId = await deriveDeviceId(credential.uid, 'session')

    const res = await fetch(`${bases.chat}/v3/config`, {
      method: 'GET',
      headers: cliChatHeaders({
        uid: credential.uid,
        machineId,
        sessionId,
        accessToken: credential.accessToken,
        conversationRequestId: crypto.randomUUID().replaceAll('-', ''),
        // ⚠️ **必须传变体**：国际版与国内版要求不同的渠道指纹，
        // 用错会回 `11128 unapproved channel`（伪装成「安全策略拦截」）。
        variant: config.id,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      throw new ProviderError({
        provider: config.id,
        httpStatus: res.status,
        message: `模型目录拉取失败：http=${res.status}`,
        retryable: res.status === 429 || res.status === 402,
      })
    }
    const payload = (await res.json()) as unknown
    return toProviderModels(extractModels(payload))
  }

  async function chat(credential: ProviderCredential, request: ChatRequest): Promise<Response> {
    const machineId = await deriveDeviceId(credential.uid, 'machine')
    const sessionId = await deriveDeviceId(credential.uid, 'session')

    // 复用网关的请求体准备逻辑（4 处必改 + 工具配对清理）
    let body: string
    try {
      // ⚠️ 国际版**要求首条消息是 `role: 'system'`**，否则返回
      // HTTP 400 + code 11128 `"first message is not system prompt"`，
      // 且被 `displayMsg` 伪装成「安全策略拦截」，极易误判成账号被封。
      // 依据：`deepseek-harness-codearts/src/account-probe.ts:93-107,326-327`。
      //
      // 用户不会知道这个要求，故在这里**自动补一条**。必须在
      // `prepareChatBody` **之前**改（它返回的是已序列化的字符串）。
      // 已有 system 首条则原样保留，不覆盖用户自己的系统提示词。
      const input = withSystemFirst(request.body, config.requiresSystemFirst === true)
      body = sanitizeChatBody(prepareChatBody(input).body)
    } catch (error) {
      throw new ProviderError({
        provider: config.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    return await fetch(`${bases.chat}/v2/chat/completions`, {
      method: 'POST',
      // ⚠️ **chat 用参考实现口径的头**（11 个），不是 Go 侧那套。
      //
      // 实测对比：用户「在 DSH 用参考插件几乎没失败过」，而我们一直回 11128。
      // 逐行对比后确认两套头差异很大（见 `referenceChatHeaders` 的对照表）——
      // 我们多发了一批 Go 侧口径的头（Origin/Referer/X-Machine-ID/
      // X-Conversation-Request-ID…），**在国际版端点上不被认可**。
      //
      // 唯一保留的额外头是 `Authorization`（参考实现也发）。
      headers: referenceChatHeaders({
        uid: credential.uid,
        accessToken: credential.accessToken,
        variant: config.id,
      }),
      body,
      signal: request.signal,
    })
  }

  async function balance(credential: ProviderCredential): Promise<ProviderBalance> {
    // ⚠️ `fetchBalance` 内部按 `env` 决定域，国际版需临时覆盖。
    const effectiveEnv =
      config.id === BUDDY_CN.id
        ? (env as Env)
        : ({ ...(env ?? {}), UPSTREAM_BILLING_BASE: bases.billing } as Env)
    const b = await fetchBalance({ uid: credential.uid, accessToken: credential.accessToken }, effectiveEnv, Date.now())
    return {
      total: b.total,
      expiring: b.expiring,
      earliestExpiry: b.earliestExpiry,
      // ⚠️ 包结构里没有「包名」，额度字段是 cycleRemain/totalRemain。
      // 如实映射，不编造包名。
      packages: b.packages.map((p, i) => ({
        name: `包 ${i + 1}`,
        amount: p.cycleRemain,
        expiry: p.expiresAt,
      })),
    }
  }

  /**
   * 每日签到。
   *
   * ⚠️ 只有**国内版**会走到这里（国际版的 `capabilities.checkin` 是 false，
   * 上游本就没有该接口）。
   *
   * 幂等由上游业务码保证（已签到返回 `10001`/`1001`，映射为 `alreadyDone`）——
   * 故重复点击是安全的。
   */
  async function checkin(credential: ProviderCredential): Promise<CheckinResult> {
    const effectiveEnv =
      config.id === BUDDY_CN.id
        ? (env as Env)
        : ({ ...(env ?? {}), UPSTREAM_BILLING_BASE: bases.billing } as Env)
    const r = await dailyCheckin({ uid: credential.uid, accessToken: credential.accessToken }, effectiveEnv)
    return {
      alreadyDone: r.alreadyDone,
      gained: r.credit,
      detail: r.alreadyDone ? '今日已签到（幂等命中）' : `签到成功，获得 ${r.credit}`,
    }
  }

  /**
   * 续期凭据。
   *
   * ⚠️ 国内版与国际版的**续期域不同**：
   * - 国内版 → `www.codebuddy.cn`
   * - 国际版 → `www.workbuddy.ai`
   *（见 upstream/auth.ts 的 `origin` 判定，按 `realm` 选）。
   */
  async function refresh(credential: ProviderCredential): Promise<ProviderCredential> {
    const realm = credential.extras['realm'] ?? 'cn'
    const r = await refreshCredential({
      chatBase: bases.chat,
      realm,
      refreshToken: credential.refreshToken,
      accessToken: credential.accessToken,
      uid: credential.uid,
      enterpriseId: credential.extras['enterpriseId'] ?? '',
    })
    return {
      ...credential,
      accessToken: r.accessToken,
      // ⚠️ 上游可能不返回新 refreshToken —— 此时**保留旧的**，
      // 否则下一次续期会因为 refreshToken 为空而彻底失败。
      refreshToken: r.refreshToken === '' ? credential.refreshToken : r.refreshToken,
      expiresAt: r.expiresAt,
      extras: { ...credential.extras, domain: r.domain },
    }
  }

  const provider: Provider = {
    id: config.id,
    name: config.name,
    capabilities: {
      login: true,
      listModels: true,
      chat: true,
      balance: true,
      checkin: config.checkin,
      ...(config.checkinBlockedReason === undefined
        ? {}
        : { checkinBlockedReason: config.checkinBlockedReason }),
    },
    /**
     * 对象判别式。
     *
     * ⚠️ 国内版（buddy）**不声明** —— 它是默认供应商，自动识别时永远参与，
     * 且形态最宽松，作为兜底最合适（声明了反而会把它自己排除掉）。
     *
     * ⚠️ 国际版（workbuddy）**必须声明** —— 否则对象形态下它不参与自动识别，
     * 国际版凭据会被 buddy 收下并**在 parseCredential 里被拒**
     *（buddy 明确拒绝 domain 含 workbuddy.ai 的凭据），
     * 于是最终报「没有任何供应商能解析这份凭据」——
     * 实测本地 WORKBUDDY_ACCOUNT 凭据就卡在这里。
     *
     * 判据：`domain` 或 `enterprise_id` 指向 workbuddy.ai，
     * 或显式带 `platform: 'workbuddy-ai'`。
     */
    ...(config.id === WORKBUDDY_INTL.id
      ? {
          matchesShape(input: Record<string, unknown>) {
            const domain = input['domain']
            if (typeof domain === 'string' && domain.includes('workbuddy.ai')) return true
            const platform = input['platform']
            return typeof platform === 'string' && platform === 'workbuddy-ai'
          },
        }
      : {}),
    parseCredential: makeParseCredential(config),
    listModels,
    chat,
    balance,
    // ⚠️ 只在声明支持时挂上 —— 国际版没有签到接口，
    // 挂上去会让「一键签到」对它发起必然失败的请求。
    ...(config.checkin ? { checkin } : {}),
    refresh,
  }

  return provider
}

/** 国内版 Provider（默认供应商）。 */
export const buddyProvider: Provider = buildBuddyProvider(BUDDY_CN)

/** 国际版 Provider。 */
export const workbuddyProvider: Provider = buildBuddyProvider(WORKBUDDY_INTL)

/**
 * 绑定 `env`（国内版允许用 env 覆盖域名，便于本地调试）。
 *
 * ## 为什么只有国内版需要这一步
 *
 * `Provider` 接口的方法签名里**没有 `env`** —— 绝大多数纯 HTTP 供应商不需要它。
 * 但国内版的上游 base 历史上来自 `env`（支持换域）。
 * 国际版恒用官方域名，故无需绑定。
 */
export function bindBuddy(env: Env): Provider {
  return buildBuddyProvider(BUDDY_CN, env)
}

/**
 * 把存储里旧的 `provider: 'workbuddy'`（当时指国内版）迁到 `'buddy'`。
 *
 * ## ⚠️ 为什么必须迁移（否则是静默的数据错误）
 *
 * 本项目早期只有国内版，且它当时的 id 就是 `workbuddy`。
 * 接入国际版后 `workbuddy` 的含义**变成了国际版** ——
 * 若不迁移，既有的国内账号会被当成国际账号，
 * 于是拿国内凭据去打 `www.workbuddy.ai`，**必然 401**。
 *
 * 且这个错误**很难归因**：用户看到的是「凭据失效」，
 * 而真实原因是 id 语义变了。
 *
 * 判据：`provider === 'workbuddy'` **且**凭据的 `domain` 不含 `workbuddy.ai`
 * ⇒ 它是迁移前存的国内账号。
 */
export function migrateBuddyProviderId(state: { provider?: string }, credentialDomain?: string): 'buddy' | undefined {
  if (state.provider !== 'workbuddy') return undefined
  // domain 明确是国际版 → 确实是国际账号，不动
  if (credentialDomain !== undefined && credentialDomain.includes('workbuddy.ai')) return undefined
  return 'buddy'
}
