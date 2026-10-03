/**
 * 真实对话与专家市场（**会消耗上游配额**）。
 *
 * ## 🔴 为什么必须有真实对话，而不能靠事件伪造
 *
 * 有几个任务的判据是**服务端校验过的真实对话回执**：
 * `expert_actual_use`、`skill_info`、`black_cat` 的进度都要求
 * `conversationId` / `requestId` 是**服务端自己签发的 id**。
 *
 * ⚠️ **自造 UUID 不计数**（Go 侧 `desktop.go:417-418` 实测记录）。
 * 客户端会 `resolveRealRequestId` —— 从 SSE 流里抓 `data.id`。
 * 故这里必须：**发一条真实 chat → 从流里抓 id → 用它构造后续事件**。
 *
 * ## 预算纪律
 *
 * 这些动作**真的会花配额**（虽然大多是 `fast-model` 的极短对话）。
 * 故：
 * - 只在对应任务未达标时才执行（调用方先检查进度，见 `verify.ts`）；
 * - 每次对话的 prompt 极短（`'1+1等于几？直接回答。'`），把消耗压到最低；
 * - 动作之间有间隔（`expertSummonGap = 6s`），避免被判定为脚本。
 */

import { resolveUpstream, type Env } from '../env.js'
import { callUpstream, classify, UpstreamError } from './client.js'
import { deriveDeviceId, desktopHeaders, desktopUserAgent } from './headers.js'
import {
  desktopChatSequence,
  desktopExpertActualUseEvent,
  desktopExpertSummonEvents,
  desktopFingerprint,
  skillInfoEvent,
  type Event,
  type MarketExpert,
} from './events.js'

/** 专家召唤间隔（Go 侧实测 `expertSummonGap`，**不要调小**）。 */
export const EXPERT_SUMMON_GAP_MS = 6000

/** 夜间对话间隔（Go 侧 `blackcat.go` 实测 4s）。 */
export const NIGHT_CHAT_GAP_MS = 4000

/**
 * `black_cat`（夜猫子）的计数窗口：**23:00–08:00（UTC+8）**。
 *
 * ⚠️ 窗口**外**的对话**不计分**（Go 侧 `blackcat.go:1-8` 实测口径）。
 * 若不判窗口就跑，会白花配额 —— 而且是「看起来成功了但进度不动」的形态，
 * 很难排查（线上实测：上报成功、回读仍 0/3）。
 *
 * 用固定 +8 偏移，不依赖本机时区（Workers 恒 UTC）。
 */
export function inNightWindow(now: number): boolean {
  const CST_OFFSET = 8 * 60 * 60 * 1000
  const hour = new Date(now + CST_OFFSET).getUTCHours()
  return hour >= 23 || hour < 8
}

/**
 * 服务端签发的 requestId 形状。
 *
 * `cmb-` 前缀 + 32 位 hex，或裸 32 位 hex（Go 侧 `idRegex` 同口径）。
 * ⚠️ 用它做**校验**而不是随便取一个 `"id"` 字段 —— SSE 里还有消息 id 等别的 id。
 */
const REQUEST_ID_RE = /^(cmb-)?[0-9a-f]{32}$/

/** 从一段 SSE 文本里找第一个**形状合法**的 `"id":"..."`。 */
export function extractServerRequestId(text: string, searchFrom = 0): { id: string; nextFrom: number } | undefined {
  let from = searchFrom
  for (;;) {
    const idx = text.indexOf('"id":"', from)
    if (idx < 0) return undefined
    const rest = text.slice(idx + 6)
    const end = rest.indexOf('"')
    if (end <= 0) return undefined
    const id = rest.slice(0, end)
    if (REQUEST_ID_RE.test(id)) return { id, nextFrom: idx + 1 }
    // ⚠️ 推进搜索位置：否则同一个不匹配的 id 会让循环永远命中同一处
    // （Go 侧踩过这个坑：读满 1MB 后误报「未找到 requestId」）
    from = idx + 1
  }
}

/**
 * 给事件注入桌面公共指纹。
 *
 * ## ⚠️ 为什么这一步不能省（线上实测踩到）
 *
 * 桌面事件上报端点（`{chat}/v2/report`）**要求每条事件都带 `reportDelay` 与
 * `timestamp`**。缺了它们上游返回：
 *
 * ```
 * code=10001  event missing both reportDelay and timestamp fields
 * ```
 *
 * 而 `desktopExpertSummonEvents` / `skillInfoEvent` 这些构造器**刻意不注入指纹**
 * （它们只管业务字段，指纹由上报层统一加）——
 * 于是真实对话链一上线就全部报这个错。
 *
 * 我的 `richMeow` / `buddyApp` 等动作是先 `withFingerprint(...)` 再上报的，
 * 但 `realtime.ts` 里的专家链**漏了这一步**。故这里统一封装，避免再漏。
 */
async function withDesktopFingerprint(
  uid: string,
  nickname: string,
  events: Event[],
  now: number,
): Promise<Event[]> {
  const machineId = await deriveDeviceId(uid, 'machine')
  const sessionId = await deriveDeviceId(uid, 'session')
  const fingerprint = desktopFingerprint({ uid, nickname, machineId, sessionId, now })
  return events.map((ev) => ({ ...fingerprint, ...ev }))
}

/** 拉真实专家列表（`expertType`：`agent` 单专家 / `team` 专家团）。 */
export async function marketExpertList(
  ctx: { uid: string; accessToken: string },
  env: Env,
  expertType: string,
): Promise<MarketExpert[]> {
  const bases = resolveUpstream(env)
  const body: Record<string, unknown> = {
    page: 1,
    page_size: 20,
    sort_by: 'reco_rank',
    sort_order: 'desc',
  }
  if (expertType !== '') body.expert_type = expertType

  const res = await callUpstream<{ experts?: unknown }>({
    method: 'POST',
    url: `${bases.chat}/portal/operation-platform/market/expert/list`,
    headers: desktopHeaders({ uid: ctx.uid, accessToken: ctx.accessToken }),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const c = classify(res.httpStatus, res.raw)
    throw new UpstreamError({
      kind: c.kind,
      httpStatus: res.httpStatus,
      code: c.code,
      message: `专家列表拉取失败（${c.kind}）：${c.msg || res.raw.slice(0, 120)}`,
      detail: res.raw.slice(0, 400),
    })
  }

  return parseExperts(res.envelope?.data)
}

/** 解析专家列表（**纯函数**）。 */
export function parseExperts(data: unknown): MarketExpert[] {
  if (data === null || typeof data !== 'object') return []
  const experts = (data as Record<string, unknown>).experts
  if (!Array.isArray(experts)) return []

  const out: MarketExpert[] = []
  for (const raw of experts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const e = raw as Record<string, unknown>
    const expertId = typeof e.expert_id === 'string' ? e.expert_id : ''
    // ⚠️ 没有 expert_id 的条目必须丢弃：id 是判据校验的锚点，编造/为空都不计数
    if (expertId === '') continue
    out.push({
      expertId,
      expertType: typeof e.expert_type === 'string' ? e.expert_type : 'agent',
      displayNameZh: typeof e.display_name_zh === 'string' ? e.display_name_zh : '',
      professionZh: typeof e.profession_zh === 'string' ? e.profession_zh : '',
      version: typeof e.version === 'string' ? e.version : '',
      categories: Array.isArray(e.categories) ? e.categories : [],
    })
  }
  return out
}

/** 真实对话的结果。 */
export interface RealChatResult {
  conversationId: string
  /** ⚠️ **服务端签发**的 requestId（不是我们生成的）。 */
  requestId: string
}

/**
 * 发一条**真实对话**并从 SSE 流里抓服务端 requestId。
 *
 * ⚠️ 这个函数**会消耗配额**（一次极短对话）。调用方必须先确认对应任务未达标。
 *
 * @param expertId 非空时带 `X-Expert-Id` 头（专家类任务必需）
 */
export async function realChat(
  ctx: { uid: string; accessToken: string },
  env: Env,
  expertId = '',
): Promise<RealChatResult> {
  const bases = resolveUpstream(env)
  const conversationId = `wb2api-conv-${Date.now()}`

  const body = {
    model: 'fast-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
      { role: 'user', content: '1+1等于几？直接回答。' },
    ],
    agent: 'cli',
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': desktopUserAgent(),
    'X-Domain': bases.chat,
    'X-Product': 'SaaS',
    'X-User-Id': ctx.uid,
    'X-Conversation-ID': conversationId,
    'X-Request-ID': `${Date.now()}`,
    'X-Agent-Intent': 'craft',
    'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
    'x-codebuddy-request': '1',
  }
  if (expertId !== '') headers['X-Expert-Id'] = expertId

  const res = await fetch(`${bases.chat}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok || res.body === null) {
    const text = await res.text().catch(() => '')
    throw new UpstreamError({
      kind: classify(res.status, text).kind,
      httpStatus: res.status,
      message: `真实对话失败：http=${res.status} ${text.slice(0, 160)}`,
      detail: text.slice(0, 400),
    })
  }

  // ⚠️ 逐块读，**边读边找** —— 找到就立刻取消，不必读完整条流
  // （省时间也省配额：回答内容对我们毫无意义，只需要那个 id）。
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let searchFrom = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const found = extractServerRequestId(buffer, searchFrom)
      if (found !== undefined) {
        return { conversationId, requestId: found.id }
      }
      // 防无界累积：只保留尾部（id 一定出现在流的早期帧里）
      if (buffer.length > 256 * 1024) {
        buffer = buffer.slice(-64 * 1024)
        searchFrom = 0
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 忽略：取消失败不影响已拿到的 id
    }
  }

  throw new UpstreamError({
    kind: 'unknown',
    httpStatus: 200,
    message: 'SSE 流里没找到服务端签发的 requestId',
    detail: buffer.slice(0, 300),
  })
}

/**
 * 完整的「专家召唤 + 真实对话 + 使用事件」链。
 *
 * ⚠️ 顺序固定：**先召唤 → 再真实对话 → 最后带服务端 id 上报使用事件**。
 * 少了召唤链，使用事件可能因「没有召唤前置」不计数。
 */
export async function expertUseChain(
  ctx: { uid: string; accessToken: string; nickname?: string },
  env: Env,
  expert: MarketExpert,
  report: (events: Event[]) => Promise<{ ok: boolean; detail: string }>,
): Promise<{ ok: boolean; detail: string }> {
  const uid = ctx.uid
  const nickname = ctx.nickname ?? ''
  // ⚠️ 每条事件都要带桌面指纹（reportDelay / timestamp），否则上游报 10001
  const send = async (events: Event[]) =>
    await report(await withDesktopFingerprint(uid, nickname, events, Date.now()))

  // ① 召唤链
  const summon = await send(desktopExpertSummonEvents(expert))
  if (!summon.ok) return { ok: false, detail: `召唤链上报失败：${summon.detail}` }

  // ② 真实对话（带 X-Expert-Id）→ 服务端 requestId
  const chat = await realChat(ctx, env, expert.expertId)

  // ③ 使用事件（JOIN 服务端 id）+ chat 链
  const chatChain = desktopChatSequence({
    conversationId: chat.conversationId,
    requestId: chat.requestId,
    messageId: `msg-${chat.requestId.slice(-8)}`,
    modelId: 'fast-model',
    modelName: 'fast-model',
    now: Date.now(),
  })
  const useEvent = desktopExpertActualUseEvent(expert, chat.conversationId, chat.requestId)
  const use = await send([...chatChain, useEvent])
  if (!use.ok) return { ok: false, detail: `使用事件上报失败：${use.detail}` }

  return { ok: true, detail: `已对专家「${expert.displayNameZh || expert.expertId}」完成召唤+使用链` }
}

/**
 * `skill_1`：真实对话 + `skill_info` 事件。
 *
 * ⚠️ chat 链里 `chat_message_response.finishReason` 必须是 `'tool_calls'`
 * （语义：模型发起了工具调用 → 加载了技能）。
 */
export async function skillFreshChain(
  ctx: { uid: string; accessToken: string; nickname?: string },
  env: Env,
  report: (events: Event[]) => Promise<{ ok: boolean; detail: string }>,
): Promise<{ ok: boolean; detail: string }> {
  const send = async (events: Event[]) =>
    await report(await withDesktopFingerprint(ctx.uid, ctx.nickname ?? '', events, Date.now()))

  const chat = await realChat(ctx, env, '')
  const messageId = `msg-${chat.requestId.slice(-8)}`

  // ⚠️ finishReason='tool_calls' 是 skill_1 与其它对话类任务的关键差异
  const chain = desktopChatSequence({
    conversationId: chat.conversationId,
    requestId: chat.requestId,
    messageId,
    modelId: 'fast-model',
    modelName: 'fast-model',
    now: Date.now(),
    finishReason: 'tool_calls',
  })
  const skill = skillInfoEvent({
    conversationId: chat.conversationId,
    requestId: chat.requestId,
    now: Date.now(),
  })

  const result = await send([...chain, skill])
  return result.ok
    ? { ok: true, detail: '已上报真实对话 + skill_info 技能加载事件' }
    : { ok: false, detail: `skill_info 上报失败：${result.detail}` }
}

/**
 * `Expert_lighthouse`：固定轻量云专家（可免费领一个月轻量服务器）。
 *
 * ⚠️ 两个对齐真实样本的细节（Go 侧实测）：
 * - `expert_actual_use` 的 `type` 为空串；
 * - `cost` 为 0（不是默认的 9000）。
 */
export async function expertLighthouseChain(
  ctx: { uid: string; accessToken: string; nickname?: string },
  env: Env,
  report: (events: Event[]) => Promise<{ ok: boolean; detail: string }>,
): Promise<{ ok: boolean; detail: string }> {
  const send = async (events: Event[]) =>
    await report(await withDesktopFingerprint(ctx.uid, ctx.nickname ?? '', events, Date.now()))

  const LIGHTHOUSE_ID = 'ex_2cvvUZQhDyeJ'
  let lighthouse: MarketExpert = {
    expertId: LIGHTHOUSE_ID,
    expertType: 'agent',
    displayNameZh: '腾讯轻量云专家',
    professionZh: '腾讯轻量云专家',
    version: '1.0.2',
    categories: [],
  }

  // 市场列表命中则用服务端信息（version 等以服务端为准）
  try {
    const experts = await marketExpertList(ctx, env, 'agent')
    const hit = experts.find((e) => e.expertId === LIGHTHOUSE_ID)
    if (hit !== undefined) lighthouse = hit
  } catch {
    // 列表拉取失败不阻塞：用上面的兜底信息继续
  }

  const summon = await send(desktopExpertSummonEvents(lighthouse))
  if (!summon.ok) return { ok: false, detail: `召唤链上报失败：${summon.detail}` }

  const chat = await realChat(ctx, env, LIGHTHOUSE_ID)

  // chat 链里补 has_expert / expert_id（对齐真实样本）
  const chain = desktopChatSequence({
    conversationId: chat.conversationId,
    requestId: chat.requestId,
    messageId: `msg-${chat.requestId.slice(-8)}`,
    modelId: 'fast-model',
    modelName: 'fast-model',
    now: Date.now(),
  })
  for (const ev of chain) {
    if (ev.eventCode === 'agent_task_created') {
      ev.has_expert = true
      ev.expert_id = lighthouse.expertId
      ev.expert_name = lighthouse.displayNameZh
      ev.expert_industry_id = ''
    }
  }

  const useEvent = desktopExpertActualUseEvent(lighthouse, chat.conversationId, chat.requestId)
  // ⚠️ 轻量云专家的真实样本：type 为空、cost 为 0
  useEvent.type = ''
  useEvent.cost = 0

  const use = await send([...chain, useEvent])
  return use.ok
    ? { ok: true, detail: '已上报轻量云专家召唤+使用链（真实对话 requestId）' }
    : { ok: false, detail: `使用事件上报失败：${use.detail}` }
}
