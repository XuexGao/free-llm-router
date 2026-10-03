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
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'
import { extractModels, type OpenAiModel } from '../gateway/models.js'
import { prepareChatBody, sanitizeChatBody } from '../gateway/payload.js'
import { parseAuthDocument, parseAuthPayload } from '../upstream/import.js'
import { dailyCheckin, fetchBalance } from '../upstream/checkin.js'
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
export const WORKBUDDY_INTL: VariantConfig = {
  id: 'workbuddy',
  name: 'WorkBuddy（国际版）',
  chatBase: 'https://www.workbuddy.ai',
  billingBase: 'https://www.workbuddy.ai',
  webBase: 'https://www.workbuddy.ai',
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
      extras: { realm: first.realm, domain: first.domain },
    }
  }
}

/** 把上游模型条目映射成统一形状。 */
export function toProviderModels(models: OpenAiModel[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    // ⚠️ `/v3/config` 里**有**这些字段，但 `extractModels` 只取了 id/name。
    // 这里给 0=未知，而不是编造数值 —— 编造会让客户端算出错误的上下文预算。
    contextWindow: 0,
    maxOutput: 0,
    supportsImage: false,
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
      body = sanitizeChatBody(prepareChatBody(request.body).body)
    } catch (error) {
      throw new ProviderError({
        provider: config.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    return await fetch(`${bases.chat}/v2/chat/completions`, {
      method: 'POST',
      headers: cliChatHeaders({
        uid: credential.uid,
        machineId,
        sessionId,
        accessToken: credential.accessToken,
        conversationRequestId: crypto.randomUUID().replaceAll('-', ''),
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
    parseCredential: makeParseCredential(config),
    listModels,
    chat,
    balance,
    // ⚠️ 只在声明支持时挂上 —— 国际版没有签到接口，
    // 挂上去会让「一键签到」对它发起必然失败的请求。
    ...(config.checkin ? { checkin } : {}),
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
