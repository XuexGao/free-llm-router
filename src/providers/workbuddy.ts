/**
 * WorkBuddy（腾讯 CodeBuddy）供应商适配器。
 *
 * 把既有的 `src/upstream/*` 与 `src/gateway/*` 包成统一的 `Provider` 接口。
 * **这是参考实现** —— 其它供应商照此结构写。
 *
 * ## 本供应商的特殊之处（与其它家不同，不要照抄到别家）
 *
 * - 模型目录在 `/v3/config`（不是 OpenAI 的 `/v1/models`）；
 * - 响应形状是 `data.models[]` **单层**（实测 54 个模型）；
 * - 对话请求体有 4 处必须改写（见 `gateway/payload.ts`）；
 * - 模型 id 是裸的（无 `provider/` 前缀），与既有用户兼容。
 */

import { resolveUpstream, type Env } from '../env.js'
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'
import { extractModels, type OpenAiModel } from '../gateway/models.js'
import { prepareChatBody, sanitizeChatBody } from '../gateway/payload.js'
import { parseAuthDocument, parseAuthPayload } from '../upstream/import.js'
import { fetchBalance } from '../upstream/checkin.js'
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderBalance,
  type ProviderCredential,
  type ProviderModel,
} from './types.js'

/**
 * 解析 WorkBuddy 凭据。
 *
 * ⚠️ 复用既有的 `parseImportPayload` —— 它已经处理了三种真实形态：
 * Go 版嵌套形、扁平 camelCase、DSH snake_case，
 * 以及「`expiresAt` 秒 vs 毫秒」这个踩过的坑。
 */
function parseCredential(input: unknown): ProviderCredential {
  let first
  try {
    // 复用既有的双形态解析（嵌套形 / 扁平 camelCase / DSH snake_case）
    const candidates = parseAuthPayload(input)
    const head = candidates[0]
    if (head === undefined) throw new Error('凭据为空')
    first = parseAuthDocument(head.raw, head.source)
  } catch (error) {
    throw new ProviderError({
      provider: 'workbuddy',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    provider: 'workbuddy',
    uid: first.uid,
    accessToken: first.accessToken,
    refreshToken: first.refreshToken,
    expiresAt: first.expiresAt,
    nickname: first.nickname,
    extras: { realm: first.realm, domain: first.domain },
  }
}

/** 拉模型目录并转成统一形状。 */
async function listModels(credential: ProviderCredential, _signal: AbortSignal, env: Env): Promise<ProviderModel[]> {
  const bases = resolveUpstream(env)
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
      provider: 'workbuddy',
      httpStatus: res.status,
      message: `模型目录拉取失败：http=${res.status}`,
      retryable: res.status === 429 || res.status === 402,
    })
  }
  const payload = (await res.json()) as unknown
  return toProviderModels(extractModels(payload))
}

/** 把 WorkBuddy 的模型条目映射成统一形状。 */
export function toProviderModels(models: OpenAiModel[]): ProviderModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    // ⚠️ WorkBuddy 的 `/v3/config` 里**有**这些字段，但 `extractModels`
    // 目前只取了 id/name（网关不需要更多）。这里给 0=未知，
    // 而不是编造数值 —— 编造会让客户端算出错误的上下文预算。
    contextWindow: 0,
    maxOutput: 0,
    supportsImage: false,
    isFree: false,
  }))
}

/** 发起对话（返回上游原始响应，由网关统一转流）。 */
async function chat(credential: ProviderCredential, request: ChatRequest, env: Env): Promise<Response> {
  const bases = resolveUpstream(env)
  const machineId = await deriveDeviceId(credential.uid, 'machine')
  const sessionId = await deriveDeviceId(credential.uid, 'session')

  // 复用网关的请求体准备逻辑（4 处必改 + 工具配对清理）
  let body: string
  try {
    body = sanitizeChatBody(prepareChatBody(request.body).body)
  } catch (error) {
    throw new ProviderError({
      provider: 'workbuddy',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const res = await fetch(`${bases.chat}/v2/chat/completions`, {
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
  return res
}

/** 查余额。 */
async function balance(credential: ProviderCredential, _signal: AbortSignal, env: Env): Promise<ProviderBalance> {
  const b = await fetchBalance({ uid: credential.uid, accessToken: credential.accessToken }, env, Date.now())
  return {
    total: b.total,
    expiring: b.expiring,
    earliestExpiry: b.earliestExpiry,
    // ⚠️ WorkBuddy 的包结构里没有「包名」，且额度字段是 cycleRemain/totalRemain。
    // 统一形状用 name/amount/expiry —— 这里如实映射，不编造包名。
    packages: b.packages.map((p, i) => ({
      name: `包 ${i + 1}`,
      amount: p.cycleRemain,
      expiry: p.expiresAt,
    })),
  }
}

export const workbuddyProvider: Provider = {
  id: 'workbuddy',
  name: 'WorkBuddy（腾讯）',
  capabilities: {
    login: true,
    listModels: true,
    chat: true,
    balance: true,
    checkin: true,
  },
  parseCredential,
  async listModels(credential, signal) {
    // ⚠️ `env` 在这里不可用 —— 见下方说明。
    throw new ProviderError({
      provider: 'workbuddy',
      message: '内部错误：workbuddy.listModels 需要 env，请用 bindWorkbuddy(env) 构造',
    })
  },
  async chat(credential, request) {
    throw new ProviderError({
      provider: 'workbuddy',
      message: '内部错误：workbuddy.chat 需要 env，请用 bindWorkbuddy(env) 构造',
    })
  },
}

/**
 * 把需要 `env` 的方法绑定上去。
 *
 * ## 为什么需要这一步
 *
 * `Provider` 接口的方法签名里**没有 `env`** —— 因为绝大多数纯 HTTP 供应商
 * 不需要它。但 WorkBuddy 的上游 base 来自 `env`（支持换域），故必须在
 * 构造时注入。
 *
 * 这比「给所有方法都加 env 参数」更好：那会迫使每家供应商都接收一个
 * 自己用不到的参数，且让接口看起来像泄漏了宿主细节。
 */
export function bindWorkbuddy(env: Env): Provider {
  return {
    ...workbuddyProvider,
    listModels: (credential, signal) => listModels(credential, signal, env),
    chat: (credential, request) => chat(credential, request, env),
    balance: (credential, signal) => balance(credential, signal, env),
  }
}
