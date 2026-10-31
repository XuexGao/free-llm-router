/**
 * 「聚合 provider」——把各渠道的**同一个真实模型**归到一个规范名下，
 * 并按「积分最快作废」自动选渠道，失败自动切换。
 *
 * ## 它解决什么（用户诉求）
 *
 * 同一个真实模型在各渠道叫法不同（见 `canonical-models.ts` 的对照表），
 * 用户在选择器里看到 8 条 DeepSeek V4.1 Flash，而它们的**积分到期时间不同**。
 * 聚合层回答的是：「用哪一条最划算」——**临期的先用掉，长期的留着**。
 *
 * ## 🔴 架构决定：**在网关层做，不是新增一个 `Provider`**
 *
 * 参考实现把聚合做成一个 adapter。我们**不那样做**，理由是 `Provider`
 * 接口的 `chat(credential, request)` **拿不到 `env`**，因此无法访问别的
 * 供应商的账号池。硬要做就得改 `Provider` 接口（牵动全部 12 家），
 * 或者把账号池塞进 `credential`（把「账号」与「池」两个概念混在一起）。
 *
 * ⇒ 本模块是**网关层**的一层薄封装，最终**复用 `handleProviderChat`** 派发。
 * 这一步很关键：它让聚合**白拿**了既有的选号／冷却／熔断／续期／记账／
 * 会话粘性 —— 那些逻辑一行都不用重写，也不会与主路径分叉。
 *（本项目吃过「同一个 bug 只修一半」的教训：两条路径必然分叉。）
 *
 * ## 回退语义（诚实说明能做到什么）
 *
 * 只有当 `handleProviderChat` **还没吐内容就失败**（HTTP ≥ 400）时才换下一个
 * 候选。**一旦开始流式输出就不再切换** —— 那会把半截回答换成另一个模型的回答，
 * 客户端看到的是拼接起来的乱码。这与参考实现的取舍一致（它用
 * 「是否已产出可见内容」做同一判断），但我们**更保守**：连
 * 「200 但流里全是错」这种情况也不切换（本项目另有错误帧翻译路径兜住它）。
 */

import type { ProviderModel } from '../providers/types.js'
import { canonicalDisplayName, canonicalKeyFor, priceFactorFromName } from '../providers/canonical-models.js'

/** 聚合 provider 的**虚拟 id**（不出现在 `PROVIDERS` 注册表里，见文件头）。 */
export const AGGREGATE_PROVIDER_ID = 'aggregate'

/**
 * 聚合的保留模型名：不指定具体模型，在该模型的所有候选里挑。
 *
 * ⚠️ 与 `canonical-models.ts` 的 `EXCLUDED_ALIASES` 里的 `auto` 是**同一个**
 * 语义 —— 那边排除它正是为了不与这里撞车。
 */
export const AGGREGATE_AUTO = 'auto'

/** 一个候选渠道（某供应商上的**真实**模型 id）。 */
export interface AggregateCandidate {
  provider: string
  /** 该渠道真正发给上游的模型 id（不是规范键）。 */
  realId: string
  /** 该渠道的展示名（用于解析倍率）。 */
  realName: string
  /** 价格倍率（越小越便宜；`Infinity` = 未知）。 */
  price: number
  /**
   * 该渠道**是否支持图片输入**（逐模型，来自上游的真实能力位）。
   *
   * ⚠️ 聚合目录必须把它暴露给客户端：不带这个字段时客户端默认「不支持」，
   * 于是用户看到「自动 DeepSeek 不支持图像识别」—— 而实际上**底层渠道是支持的**
   *（实测 trae 与 qoder 的 DeepSeek 都是 `supportsImage: true`）。
   * 这是**我们自己没往外说**，不是能力缺失。
   */
  supportsImage: boolean
}

/** 一个虚拟模型（规范名 + 它在各渠道的候选）。 */
export interface VirtualModel {
  key: string
  name: string
  candidates: AggregateCandidate[]
  /**
   * 该规范名**是否能安全接图片**（聚合口径，见 `imageCapableOf`）。
   *
   * ⚠️ 与单个候选的 `supportsImage` **不是一个意思**：
   * 聚合会在候选里**随机挑渠道**，只要有一个候选不支持图片，
   * 带图请求就可能落到那个渠道上并被上游拒绝。
   * ⇒ 这里取的是**保守值**（全部候选都支持才算支持）。
   */
  supportsImage: boolean
}

/** 某供应商的目录（构建虚拟模型的输入）。 */
export interface ProviderCatalog {
  provider: string
  models: readonly ProviderModel[]
}

/**
 * 聚合路由**只暴露这几个规范名**（用户要求：其它的用不上）。
 *
 * ## 为什么用白名单而不是黑名单
 *
 * 各家渠道的模型池会**随时增删**（上游上架/下架一个模型就会多/少一个规范键）。
 * 黑名单意味着「上游每加一个新模型，聚合目录就自动多一行」——
 * 那正是用户不想要的（他只想看自己真会用的那两个）。
 * 白名单则是「只放我认过的」，上游怎么变都不会溢出。
 *
 * ⚠️ **必须在 `buildVirtualModels` 里过滤，而不是在 `/v1/models` 处过滤** ——
 * 聚合有**两条独立入口**：`/v1/models` 的目录（`src/index.ts`）
 * 与聚合 **chat** 的实际路由（`src/gateway/server.ts` 的 `loadAggregateCatalog`）。
 * 只过滤一处会让「目录里看不到、却仍然能调通」——
 * 本项目已经吃过「同一个 bug 只修一半」的教训。
 * 两条路径**都**经过 `buildVirtualModels`，故这里是唯一的收口点。
 *
 * ⚠️ **`aggregate/auto` 也会被连带收窄**（这一点我第一版写错了，实测代码后改正）：
 * `handleAggregateChat` 里 `auto` 的候选是**遍历 `virtuals` 取并集**得来的
 * （`src/gateway/server.ts`），而 `virtuals` 就是本函数过滤后的结果
 * ⇒ `auto` 只会在白名单这两个模型的各渠道之间挑。
 *
 * ⚠️ 这是**有意的**，不是副作用：用户要的就是「聚合只留这两个模型」。
 * 若 `auto` 仍能选到别的模型，那「其它的用不上」就没落到实处 ——
 * 目录里看不到、却能通过 `auto` 调出去，等于没关。
 */
export const AGGREGATE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'deepseek-v4-1-flash',
  'glm-5-3-flash',
])

/**
 * 构建虚拟模型表（**纯函数**，便于单测）。
 *
 * 算法（对齐参考实现，顺序不可改）：
 * 1. 逐个渠道、逐个模型跑 `canonicalKeyFor` —— 返回 `undefined` 的
 *    （通用名，如 `auto` / `fast-model`）**直接丢弃**；
 * 2. 按规范键分组；
 * 3. 输出顺序：候选数**降序**、同数按键**升序**（稳定，避免顺序抖动）；
 *    组内候选按供应商**升序**、再按 `realId` 升序。
 *
 * ⚠️ 顺序必须**稳定**：它决定 `/v1/models` 的排列与「同分候选的先后」，
 * 每次刷新都变会让用户觉得目录在乱跳。
 */
export function buildVirtualModels(catalogs: readonly ProviderCatalog[]): VirtualModel[] {
  const groups = new Map<string, AggregateCandidate[]>()
  for (const cat of catalogs) {
    for (const m of cat.models) {
      // ⚠️ 没有 id 的脏数据必须丢弃（它会让规范键为空，进而产出无效目录）
      if (typeof m.id !== 'string' || m.id.trim().length === 0) continue
      const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id
      const hit = canonicalKeyFor(cat.provider, m.id, name)
      if (hit === undefined) continue
      const list = groups.get(hit.key) ?? []
      list.push({
        provider: cat.provider,
        realId: m.id,
        realName: name,
        price: priceFactorFromName(name),
        // ⚠️ 直接取上游的 `ProviderModel.supportsImage`（逐模型、上游真实下发），
        // 不做任何推断 —— 本项目已多次吃过「按同族推断能力」的亏。
        supportsImage: m.supportsImage === true,
      })
      groups.set(hit.key, list)
    }
  }

  const out: VirtualModel[] = []
  for (const [key, candidates] of groups) {
    // ⚠️ 白名单收口（见 `AGGREGATE_ALLOWED_KEYS` 的说明）——
    // 放在这里而不是更早：早于分组的话，「某个键的候选」会被拆散，
    // 反而不好理解。这里整组丢弃，语义最清楚。
    if (!AGGREGATE_ALLOWED_KEYS.has(key)) continue
    candidates.sort((a, b) => (a.provider === b.provider
      ? a.realId.localeCompare(b.realId)
      : a.provider.localeCompare(b.provider)))
    out.push({
      key,
      name: canonicalDisplayName(key),
      candidates,
      supportsImage: imageCapableOf(candidates),
    })
  }
  out.sort((a, b) => (b.candidates.length - a.candidates.length
    || a.key.localeCompare(b.key)))
  return out
}

/**
 * 「不可用」哨兵。
 *
 * ⚠️ 用 `-1` 而不是 `0`：`0` 很容易与「过期时刻就是 epoch 0」混淆，
 * 而 `-1` 在时间轴上不可能出现，故能做明确的排除标记。
 */
export const EXPIRY_UNUSABLE = -1

/**
 * 「长期有效」哨兵。
 *
 * ⚠️ 它**必须仍然可被选中**（只是排在最后）：一个「没有临期额度但有永久额度」
 * 的渠道是**可用**的，只是不急着用。把它当不可用会让用户明明有额度却调不通。
 */
export const EXPIRY_NEVER = Number.POSITIVE_INFINITY

/**
 * 按「临期优先」排序候选（**纯函数**）。
 *
 * 排序键（依次）：
 * 1. 到期时刻**升序** —— 最快作废的先烧；
 * 2. 价格倍率**升序** —— 同样临期时先用便宜的；
 * 3. 保持输入顺序（稳定排序天然保证）。
 *
 * ⚠️ `EXPIRY_UNUSABLE` 的候选**必须被剔除**（不是排到最后）——
 * 「查不到额度」与「额度长期有效」是两件完全不同的事，
 * 前者我们**不知道**能不能用，让它参与排序等于把流量发给一个未知状态的渠道。
 */
export function rankCandidates(
  candidates: readonly AggregateCandidate[],
  expiryOf: (c: AggregateCandidate) => number,
): AggregateCandidate[] {
  return candidates
    .map((c) => ({ c, expiry: expiryOf(c) }))
    .filter((x) => x.expiry !== EXPIRY_UNUSABLE)
    .sort((a, b) => (a.expiry === b.expiry ? a.c.price - b.c.price : a.expiry - b.expiry))
    .map((x) => x.c)
}

/**
 * 聚合口径的**图片能力**：**任一**候选支持即可（配合路由侧过滤）。
 *
 * ## ⚠️ 为什么是 `some` 而不是 `every`（这里我改过一次）
 *
 * 最初写的是 `every`（保守），理由是「聚合会在候选里挑渠道，只要有一个不支持，
 * 带图请求就可能落到它上面并随机失败」。
 *
 * ⚠️ 但那样做的**实际后果**是：`codearts` 的 DeepSeek 不支持图片，
 * 于是整个 `deepseek-v4-1-flash` 被标成「不支持」——
 * **用户的需求完全没被解决**（他还是不能传图）。
 *
 * ⇒ 真正的解法是把能力判断**下沉到路由**（见 `server.ts` 里
 * `requestHasImage` 那段）：带图请求**只发给支持图片的候选**。
 * 这样：
 * - 目录如实报 `true`（**确实有渠道能处理**带图请求）；
 * - 带图请求**不会**落到不支持的渠道（不会随机失败）。
 *
 * ⚠️ 两者**必须成对**：若只改这里是 `some` 而不在路由侧过滤，
 * 就会退回「有时能用、有时失败」—— 那正是我最初担心的形态。
 * 单测同时钉住这两个条件。
 */
export function imageCapableOf(candidates: readonly AggregateCandidate[]): boolean {
  if (candidates.length === 0) return false
  return candidates.some((c) => c.supportsImage)
}

/**
 * 从候选里挑「最早作废」的那个渠道（**纯函数**，只按到期时刻）。
 *
 * ⚠️ 用**独立变量**表示「还没找到赢家」与「当前最优时刻」。
 * 我曾见过把两者都初始化为 `Infinity` 的写法：那会让
 * 「全部候选都是长期有效」时返回 `undefined`，界面报成「没有账号登录」——
 * 而实际上**账号好得很**，只是没有临期额度。
 * 故这里用 `best === undefined` 判「还没赢家」。
 */
export function pickSoonestProvider(
  ranked: ReadonlyArray<{ provider: string; expiry: number }>,
): string | undefined {
  let best: string | undefined
  let bestExpiry = Number.POSITIVE_INFINITY
  for (const r of ranked) {
    if (r.expiry === EXPIRY_UNUSABLE) continue
    if (best === undefined || r.expiry < bestExpiry) {
      best = r.provider
      bestExpiry = r.expiry
    }
  }
  return best
}

/**
 * 到期时刻的人类可读标签（面板用）。
 *
 * ⚠️ `EXPIRY_UNUSABLE` 显示「查不到」而**不是**「已过期」——
 * 前者是「我们没能确定」，后者是「确定没了」，用户该采取的行动不同。
 */
export function expiryLabel(expiry: number, now: number = Date.now()): string {
  if (expiry === EXPIRY_UNUSABLE) return '查不到'
  if (expiry === EXPIRY_NEVER || !Number.isFinite(expiry)) return '长期'
  const diff = expiry - now
  if (diff <= 0) return '已过期'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟后`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} 小时后`
  return `${Math.floor(hours / 24)} 天后`
}
