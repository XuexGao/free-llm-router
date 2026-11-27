/**
 * 账号状态机的单测（四维**正交性**是重点）。
 *
 * ## 为什么这些测试值得写
 *
 * 状态机的错误是**不对称**的：
 * - 把「临时限流」当「账号死亡」→ 误杀健康账号
 *   （Go 侧真实事故：13 个 disabled 号 refresh 全部成功）；
 * - 把「模型级限流」当「账号级」→ 该账号的其他模型也用不了。
 *
 * 所以这里锁的是**边界语义**，不是「代码能跑」。
 *
 * 运行：`node --test --experimental-strip-types tests/state.test.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createAccountState,
  healthy,
  healthyForModel,
  isActive,
  modelExempt,
  pruneExpired,
} from '../src/pool/state.ts'
import type { AccountState } from '../src/pool/state.ts'

const NOW = 1_700_000_000_000

function make(): AccountState {
  return createAccountState({ uid: 'u1', nickname: 'n', realm: 'cn' })
}

test('isActive：0 表示「无」，不能靠 truthiness', () => {
  assert.equal(isActive(0, NOW), false)
  assert.equal(isActive(NOW + 1, NOW), true)
  assert.equal(isActive(NOW, NOW), false, '恰好到点应视为已过期')
  assert.equal(isActive(NOW - 1, NOW), false)
})

test('新账号健康', () => {
  assert.equal(healthy(make(), NOW), true)
})

test('disabled 恒不健康，即使其他维度都清零', () => {
  const s = make()
  s.disabled = true
  assert.equal(healthy(s, NOW), false)
  // 即使把三个截止都清零也不该恢复
  s.until = 0
  s.breakerUntil = 0
  s.degradeUntil = 0
  assert.equal(healthy(s, NOW), false)
})

test('四维并列或门：任一未到期即不可选', () => {
  for (const field of ['until', 'breakerUntil', 'degradeUntil'] as const) {
    const s = make()
    s[field] = NOW + 60_000
    assert.equal(healthy(s, NOW), false, `${field} 未到期时应不可选`)
  }
})

test('四维正交：都过期后恢复健康（取最远者的语义）', () => {
  const s = make()
  s.until = NOW + 1000
  s.breakerUntil = NOW + 5000
  s.degradeUntil = NOW + 3000
  assert.equal(healthy(s, NOW), false)
  // 最远的 breakerUntil 过后即健康
  assert.equal(healthy(s, NOW + 5001), true)
})

test('模型级冷却只拦该模型，不拦其他模型', () => {
  const s = make()
  s.modelCooldowns['glm-5.2'] = {
    until: NOW + 60_000,
    resetAt: 0,
    reason: '6004',
    hits: 1,
    auditOnly: false,
  }
  assert.equal(healthy(s, NOW), true, '账号本身仍健康')
  assert.equal(healthyForModel(s, NOW, 'glm-5.2'), false, '被限流的模型不可用')
  assert.equal(healthyForModel(s, NOW, 'deepseek-v4'), true, '其他模型不受影响')
  assert.equal(healthyForModel(s, NOW, ''), true, '空模型名不做模型级过滤')
})

test('⚠️ 审计条目不得参与可用性判定', () => {
  const s = make()
  s.modelCooldowns['x'] = { until: NOW + 999_999, resetAt: 0, reason: 'audit', hits: 0, auditOnly: true }
  assert.equal(healthyForModel(s, NOW, 'x'), true, 'auditOnly 条目必须被忽略')
  assert.equal(modelExempt(s, NOW), false, 'auditOnly 不算「模型级豁免」形态')
})

test('modelExempt：账号健康但有真实模型冷却', () => {
  const s = make()
  s.modelCooldowns['glm'] = { until: NOW + 1, resetAt: 0, reason: '6004', hits: 1, auditOnly: false }
  assert.equal(modelExempt(s, NOW), true)
  // 账号级冷却同时存在时不再是「仅模型级」形态
  s.until = NOW + 1000
  assert.equal(modelExempt(s, NOW), false)
})

test('pruneExpired：清过期模型冷却与陈旧成本，且报告变更', () => {
  const s = make()
  s.modelCooldowns['expired'] = { until: NOW - 1, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  s.modelCooldowns['live'] = { until: NOW + 100_000, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  s.modelCosts['stale'] = { per1k: 1, lastSeen: NOW - 7 * 60 * 60 * 1000 }
  s.modelCosts['fresh'] = { per1k: 1, lastSeen: NOW - 60_000 }
  s.modelCosts['broken'] = { per1k: 1, lastSeen: 0 }

  const changed = pruneExpired(s, NOW, 6 * 60 * 60 * 1000)
  assert.equal(changed, true)
  assert.equal(s.modelCooldowns['expired'], undefined)
  assert.notEqual(s.modelCooldowns['live'], undefined)
  assert.equal(s.modelCosts['stale'], undefined, '超过 TTL 的成本应清除')
  assert.notEqual(s.modelCosts['fresh'], undefined)
  assert.equal(s.modelCosts['broken'], undefined, 'lastSeen<=0 的破损条目应清除')
})

test('pruneExpired：无变更时返回 false（避免无谓回写）', () => {
  const s = make()
  s.modelCooldowns['live'] = { until: NOW + 1000, resetAt: 0, reason: 'r', hits: 1, auditOnly: false }
  assert.equal(pruneExpired(s, NOW, 6 * 60 * 60 * 1000), false)
})

test('allowsAllFieldsExplicit：所有计数字段都被初始化为数字（不靠 undefined）', () => {
  const s = make()
  for (const key of ['softStreak', 'fails', 'retryCount', 'consecutiveFails', 'sessionDeadFails'] as const) {
    assert.equal(typeof s[key], 'number', `${key} 应是数字`)
    assert.equal(s[key], 0, `${key} 应显式归零`)
  }
  assert.equal(s.tokenUsage.input, 0)
  assert.equal(s.tokenUsage.output, 0)
})

// ─────────────────── 池计数（面板恒为 0 的 bug） ───────────────────

test('⚠️ healthy 与 modelExempt 会**同时为真**（计数必须按顺序判）', () => {
  // 线上实测：面板的「模型限流」恒为 0。
  // 根因是 counts() 里先判 healthy —— 而 healthy() 只看账号级四维，
  // **不看** modelCooldowns，于是「账号健康但有模型在冷却」时两个都为 true，
  // 先判 healthy 就把模型限流那一类吞掉了。
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['glm-5.2'] = {
    until: now + 3600_000, resetAt: 0, reason: 'x', hits: 1, auditOnly: false,
  }
  assert.equal(healthy(s, now), true, 'healthy 只看账号级四维，这里是 true')
  assert.equal(modelExempt(s, now), true, '有未过期模型冷却 → 也是 true')
  // ⇒ 两者同时为真，故 counts 必须**先判 modelExempt**
})

test('⚠️ 审计条目不该让账号被算成「模型限流」', () => {
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['x'] = { until: now + 3600_000, resetAt: 0, reason: 'audit', hits: 1, auditOnly: true }
  assert.equal(modelExempt(s, now), false, 'auditOnly 不参与判定')
})

test('过期的模型冷却被剪枝后不算限流', () => {
  const now = 1_700_000_000_000
  const s = createAccountState({ uid: 'u', nickname: 'n', realm: 'cn' })
  s.modelCooldowns['x'] = { until: now - 1000, resetAt: 0, reason: 'old', hits: 1, auditOnly: false }
  pruneExpired(s, now, 6 * 3600_000)
  assert.equal(modelExempt(s, now), false)
  assert.equal(Object.keys(s.modelCooldowns).length, 0, '过期条目应被删除')
})

// ───────────── 清惩罚态必须连 `reason` 一起清（陈旧文案会误导归因） ─────────────

test('🔴 清惩罚态的每一条路径都必须同时清 `reason`（陈旧失败文案会误导归因）', async () => {
  // ## 真实缺陷（线上实测，2026-11-27）
  //
  // 一个 buddy 账号的实际状态是
  // `coolKind:''` `until:0` `fails:0` `breakerUntil:0`（**完全健康**），
  // 但 `reason` 仍挂着 **10-17 的**
  // `waf_blocked: Illegal API invocation from an unapproved channel`。
  //
  // 根因：`reason` 只是惩罚态的**附注**，而 `noteSuccess` 清了 9 个失败态字段
  // **唯独漏了它**；`clearCooldowns` 同样漏。
  //
  // ⚠️ 后果不是「少显示一个字段」，而是**主动误导**：
  // 我据此判定「国内版 11-21 之后全挂了、疑似指纹回退」，
  // 实际它只是因为被手动关闭而没再发请求 —— 一开启立刻 4/4 成功。
  // 一个六周前的失败原因被当成「当前状态」来归因，这类缺陷极难自查。
  //
  // ⚠️ 这个测试**按源码结构断言**（AccountPoolDO 依赖 DO storage，无法直接跑）：
  // 找出所有「把 coolKind 清成空串」的代码块，要求同一块里必须出现
  // `state.reason = ''`。新增一条清惩罚态的路径却忘了清 reason 时，
  // 这里会立刻变红 —— 那正是我要防的「同一个 bug 只修一半」。
  const src = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 剥块注释
    .replace(/^\s*\/\/.*$/gm, '')       // 剥行注释

  // 以 `coolKind = ''` 为锚点，取它所在的「语句块」（前后各 12 行）判断。
  // ⚠️ 不能用固定长度窗口切文件（注释一长就会切偏）——这里按行号聚合更稳。
  const lines = src.split('\n')
  const anchors = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /state\.coolKind\s*=\s*''/.test(l))
  assert.ok(anchors.length >= 3, `应至少有 3 处清 coolKind（实得 ${anchors.length}）`)

  for (const { i } of anchors) {
    // 取该锚点所在的语句块：向上找到最近一个 `{` 或空行/函数边界，向下 12 行
    const window = lines.slice(Math.max(0, i - 6), i + 13).join('\n')
    assert.ok(/state\.reason\s*=\s*''/.test(window),
      `⚠️ 第 ${i + 1} 行清 coolKind 的代码块里没有清 state.reason ——\n`
      + '清了惩罚态却留下失败文案，面板会把一条已不成立的原因当成当前状态显示，\n'
      + '而这会把人引向完全错误的归因方向（实测代价：误判「指纹回退」）。')
  }

  // 反向：`noteSuccess` 里必须明确清 reason（它是**正常成功路径**，
  // 恰恰是陈旧 reason 最常见的残留来源 —— 账号一直好着，文案却一直是坏的）。
  const successIdx = src.indexOf('async noteSuccess')
  assert.ok(successIdx > 0, '应有 noteSuccess')
  const successBody = src.slice(successIdx, src.indexOf('\n  }', successIdx))
  assert.ok(/state\.reason\s*=\s*''/.test(successBody),
    '⚠️ noteSuccess 必须清 reason（成功一次就说明上次失败原因已不成立）')
})

test('⚠️ 判「是否被惩罚」只能看时间语义字段，不能看 reason', () => {
  // 这条把上面那条的**判据纪律**钉死：`reason` 是自由文本附注，
  // 判据必须只用 `isActive(until)` / `coolKind` / `fails` / `breakerUntil`。
  //
  // 一个健康账号完全可以带着非空 `reason`（历史遗留），
  // 故任何 `reason !== ''` 形式的「是否被限」判断都是错的。
  const st = make()
  assert.equal(st.reason, '', '新建账号 reason 应为空')
  st.reason = 'waf_blocked: 六周前的失败'
  // ⚠️ 即使 reason 非空，健康判据仍须为「可用」—— 两者必须解耦
  assert.equal(healthy(st, NOW), true, '⚠️ reason 非空不得影响健康判定')
})

test('🔴 /admin/accounts 的 reason 必须按「当前是否真被惩罚」过滤（存量脏数据）', () => {
  // ## 为什么**只修写入侧不够**
  //
  // 上一轮改了 `noteSuccess` / `clearCooldowns` 会清 `reason`，
  // 但**存量数据仍然是脏的** —— 那个账号在下次成功之前，`reason`
  // 依旧挂着六周前的 WAF 文案。而「下一次成功」可能永远不会来
  //（账号被手动关闭、或已经不再使用）。
  //
  // ⇒ 读侧必须**自证**：只有当某个惩罚态**当前仍在生效**时，`reason`
  // 才有展示意义；否则它必然是陈旧残留，一律回空串。
  //
  // ⚠️ 这条特别值得写死，因为缺陷形态是「界面显示得很正常」——
  // 一条历史失败原因看起来和当前失败原因**长得一模一样**，
  // 只有对照 `until` / `coolKind` 才分得出来。
  const src = readFileSync('src/index.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // 找到账号列表里回 reason 的那一行
  const m = /reason:\s*\(([\s\S]{0,400}?)\)\s*\n\s*\?\s*a\.reason\s*\n\s*:\s*''/.exec(src)
  assert.ok(m !== null,
    '⚠️ /admin/accounts 的 reason 必须带「当前是否被惩罚」的条件判断，'
    + '不能直接回 `reason: a.reason`（那会把陈旧文案当成当前状态）')

  const cond = m[1]
  for (const k of ['isActive(a.until', 'isActive(a.breakerUntil', 'isActive(a.degradeUntil']) {
    assert.ok(cond.includes(k),
      `⚠️ 过滤条件必须覆盖 ${k}（只看 coolKind 会漏掉按截止时刻生效的惩罚态）`)
  }
  assert.ok(cond.includes('a.disabled'), '⚠️ 手动停用也要回 reason（那是当前有效状态）')
})
