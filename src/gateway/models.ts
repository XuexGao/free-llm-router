/**
 * 模型目录：从上游 `/v3/config` 拉取并转成 OpenAI 兼容形状。
 *
 * ⚠️ 上游**没有** OpenAI 式的 `/v1/models`；目录在 `/v3/config`。
 */

import { resolveUpstream, type Env } from '../env.js'
import { DEFAULT_PROVIDER } from '../providers/index.js'
import { cliChatHeaders, deriveDeviceId } from '../upstream/headers.js'

/** 模型目录单条（OpenAI 兼容形状）。 */
export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name?: string
  /**
   * 上下文窗口（上游 `maxInputTokens`）。
   *
   * ⚠️ 之前这里**丢掉了**这个字段（只留 id/name），导致面板显示「—」、
   * 客户端也拿不到真实的上下文预算。上游 `/v3/config` 本来就下发它，
   * 白丢是自己的问题。
   */
  contextWindow?: number
  /** 单次输出上限（上游 `maxOutputTokens`）。 */
  maxOutput?: number
  /** 是否接受图片输入（上游 `supportsImages`）。 */
  supportsImage?: boolean
  /** 是否支持工具调用（上游 `supportsToolCall`）。 */
  supportsToolCall?: boolean
  /** 是否支持推理（上游 `supportsReasoning`）。 */
  supportsReasoning?: boolean
  /** 是否默认模型（上游 `isDefault`）。 */
  isDefault?: boolean
  /** 厂商（上游 `vendor`）。 */
  vendor?: string
}

/** 从账号池取第一个可用账号（1–3 账号场景下够用）。 */
export async function pickCredential(
  env: Env,
  realm: string,
  /**
   * 只要该供应商的账号。
   *
   * ⚠️ 这个过滤是**必须**的（实测踩到）：不带它时，一个「有 cline 账号、
   * 没有 workbuddy 账号」的部署会把 cline 的凭据拿去打 WorkBuddy 的端点，
   * 报的是上游 401 —— 看起来像「凭据坏了」，实际是选错了账号。
   */
  providerId = DEFAULT_PROVIDER,
): Promise<{ uid: string; credential: { accessToken: string } } | undefined> {
  const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName(realm))
  const accounts = await pool.listAccounts(realm, Date.now())
  for (const account of accounts) {
    if (account.disabled) continue
    if ((account.provider ?? DEFAULT_PROVIDER) !== providerId) continue
    const credential = (await pool.getCredential(account.uid)) as { accessToken?: string } | undefined
    if (credential !== undefined && typeof credential.accessToken === 'string' && credential.accessToken !== '') {
      return { uid: account.uid, credential: { accessToken: credential.accessToken } }
    }
  }
  return undefined
}

/**
 * 拉取模型目录。
 *
 * 目录响应几十 KB，这里允许整体解析 —— 它是**一次性**调用，
 * 不在流式回答的热路径上（那条路径绝不能缓冲）。
 */
export async function listModels(
  ctx: { uid: string; accessToken: string },
  env: Env,
): Promise<OpenAiModel[]> {
  const bases = resolveUpstream(env)
  const machineId = await deriveDeviceId(ctx.uid, 'machine')
  const sessionId = await deriveDeviceId(ctx.uid, 'session')

  const res = await fetch(`${bases.chat}/v3/config`, {
    method: 'GET',
    headers: cliChatHeaders({
      uid: ctx.uid,
      machineId,
      sessionId,
      accessToken: ctx.accessToken,
      conversationRequestId: crypto.randomUUID().replaceAll('-', ''),
    }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) throw new Error(`模型目录拉取失败：http=${res.status}`)
  const payload = (await res.json()) as unknown
  return extractModels(payload)
}

/**
 * 从 `/v3/config` 响应里提取模型（**纯函数**，便于单测）。
 *
 * ## ⚠️ 路径是本文件最容易搞错的地方（已实测踩过一次）
 *
 * CN 域 `/v3/config` 的真实形状是 **`data.models[]`**（单层），
 * 实测返回 **54 个模型**。最初按 `data.data.models`（双层）去取，
 * 线上表现为 `GET /v1/models` **HTTP 200 但 models 为空数组** ——
 * 没有报错、没有提示，只是「看起来这个账号没有模型」，极难排查。
 *
 * 双层形态确实存在于**另一**端点家族（global 域企业端点），
 * 故这里同时兼容两种：先试 `data.models`，没有再看 `data.data.models`。
 */
export function extractModels(payload: unknown): OpenAiModel[] {
  if (payload === null || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const data = root.data
  if (data === null || typeof data !== 'object') return []
  const outer = data as Record<string, unknown>

  // ① CN 域当前形态：data.models[]（已实测）
  const direct = outer.models
  if (Array.isArray(direct)) return mapModels(direct)

  // ② 兼容双层形态：data.data.models[]
  const inner = outer.data
  if (inner !== null && typeof inner === 'object') {
    const nested = (inner as Record<string, unknown>).models
    if (Array.isArray(nested)) return mapModels(nested)
  }

  return []
}

/** 把上游模型条目映射成 OpenAI 形状（跳过无 id 的脏数据）。 */
function mapModels(models: unknown[]): OpenAiModel[] {
  const out: OpenAiModel[] = []
  for (const raw of models) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id : ''
    if (id === '') continue

    const str = (k: string): string | undefined => {
      const v = m[k]
      return typeof v === 'string' && v !== '' ? v : undefined
    }
    const num = (k: string): number | undefined => {
      const v = m[k]
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    }
    const bool = (k: string): boolean | undefined => (typeof m[k] === 'boolean' ? (m[k] as boolean) : undefined)

    out.push({
      id,
      object: 'model',
      created: 0,
      owned_by: DEFAULT_PROVIDER,
      ...(str('name') === undefined ? {} : { name: str('name') as string }),
      // ⚠️ 这些字段上游**本来就下发**（实测 `/v3/config` 的 data.models[]），
      // 之前只取 id/name 是白丢信息 —— 面板因此显示不出上下文与图片能力。
      ...(num('maxInputTokens') === undefined ? {} : { contextWindow: num('maxInputTokens') as number }),
      ...(num('maxOutputTokens') === undefined ? {} : { maxOutput: num('maxOutputTokens') as number }),
      ...(bool('supportsImages') === undefined ? {} : { supportsImage: bool('supportsImages') as boolean }),
      ...(bool('supportsToolCall') === undefined ? {} : { supportsToolCall: bool('supportsToolCall') as boolean }),
      ...(bool('supportsReasoning') === undefined ? {} : { supportsReasoning: bool('supportsReasoning') as boolean }),
      ...(bool('isDefault') === undefined ? {} : { isDefault: bool('isDefault') as boolean }),
      ...(str('vendor') === undefined ? {} : { vendor: str('vendor') as string }),
    })
  }
  return out
}
