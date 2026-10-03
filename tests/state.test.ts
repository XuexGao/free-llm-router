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
