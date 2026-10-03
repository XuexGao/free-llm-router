/**
 * 进度回读与领奖的单测（含**异步计分**这个最难排查的坑）。
 *
 * ## 为什么这些断言重要
 *
 * 上游计分是**异步**的（实测 5–8s 才落定）。若代码只读一次进度，
 * 会把「其实已完成」误判为「未达标」→ **跳过领奖** →
 * 任务做了但积分永远拿不到，**且没有任何报错**。
 *
 * 这类失败没有任何显式信号，只能靠单测把语义钉住。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLAIM_POLL_ATTEMPTS, CLAIM_POLL_GAP_MS } from '../src/taskrunner/verify.ts'
import { planByName, planGrowth, zeroCostActions } from '../src/taskrunner/plans.ts'
import { NEEDS_REAL_CHAT, registeredActions } from '../src/taskrunner/actions.ts'

// ─────────────────── 回读参数 ───────────────────

test('⚠️ 回读必须是有界轮询（不是无限等，也不是只读一次）', () => {
  assert.ok(CLAIM_POLL_ATTEMPTS > 1, '只读一次会因异步计分误判未达标')
  assert.ok(CLAIM_POLL_ATTEMPTS <= 10, '轮询次数必须有界，否则白烧 DO Duration 配额')
  assert.ok(CLAIM_POLL_GAP_MS >= 1000, '间隔不能太短，否则轮询完仍可能没落定')
})

test('回读总预算在 10–20 秒量级（对齐 Go 侧实测的 5–8s 落定时间）', () => {
  const budgetMs = (CLAIM_POLL_ATTEMPTS - 1) * CLAIM_POLL_GAP_MS
  assert.ok(budgetMs >= 6000, `预算 ${budgetMs}ms 太短，覆盖不了实测落定时间`)
  assert.ok(budgetMs <= 30000, `预算 ${budgetMs}ms 太长，会拖住 alarm`)
})

// ─────────────────── 计划表 ───────────────────

test('每日计划：先只读探测，再签到，最后查余额', () => {
  const steps = planByName('daily')
  assert.equal(steps[0]?.action, 'listTasks', '先只读探测，便于快速定位账号问题')
  assert.ok(steps.some((s) => s.action === 'checkin'), '应包含签到')
  assert.equal(steps[steps.length - 1]?.action, 'balance', '最后查余额（用于解冻）')
})

test('⚠️ 成长计划：每个动作后面必须跟一次回读+领奖', () => {
  const steps = planGrowth()
  const actions = steps.map((s) => s.action)

  // 每个业务动作后面都应有 verifyAndClaim
  for (const { action } of zeroCostActions()) {
    const idx = actions.indexOf(action)
    assert.ok(idx >= 0, `计划里应有动作 ${action}`)
    assert.equal(actions[idx + 1], 'verifyAndClaim', `${action} 后面必须跟 verifyAndClaim（否则达标也不领奖）`)
  }
})

test('⚠️ 成长计划：绝不包含需要真实对话的任务（会消耗配额）', () => {
  const steps = planGrowth()
  for (const step of steps) {
    assert.equal(
      NEEDS_REAL_CHAT.has(step.code),
      false,
      `计划里不该有需要真实对话的任务：${step.code}`,
    )
  }
})

test('成长计划：零消耗动作数与动作表一致', () => {
  const actions = zeroCostActions()
  const steps = planGrowth()
  // 每个动作 2 步（动作 + 回读领奖）+ 1 个初始探测
  assert.equal(steps.length, actions.length * 2 + 1)
})

test('⚠️ 所有步骤的 delayMs 必须 ≥ 0（负数会让 alarm 立即重排，形成忙循环）', () => {
  for (const plan of ['daily', 'growth'] as const) {
    for (const step of planByName(plan)) {
      assert.ok(step.delayMs >= 0, `${plan} 的 ${step.action} delayMs 为负：${step.delayMs}`)
    }
  }
})

test('⚠️ 上报类动作之间有 ≥1s 间隔（反风控，不是性能调优）', () => {
  const steps = planGrowth()
  // 除最后一步外，业务动作后面都应有非零间隔
  const businessSteps = steps.filter((s) => s.action !== 'verifyAndClaim' && s.code !== '_probe')
  for (const step of businessSteps) {
    assert.ok(step.delayMs >= 1000, `${step.action} 的间隔 ${step.delayMs}ms 太短（会被风控）`)
  }
})

test('计划里没有重复的任务码动作（避免白跑）', () => {
  const steps = planGrowth()
  const actionSteps = steps.filter((s) => s.action !== 'verifyAndClaim' && s.code !== '_probe')
  const codes = actionSteps.map((s) => s.code)
  assert.equal(new Set(codes).size, codes.length, `有重复任务码：${codes.join(',')}`)
})

// ─────────────────── 动作注册表 ───────────────────

test('⚠️ 计划里引用的动作必须都已注册（否则会报「未注册的动作」）', () => {
  const registered = new Set(registeredActions())
  for (const plan of ['daily', 'growth'] as const) {
    for (const step of planByName(plan)) {
      assert.ok(registered.has(step.action), `${plan} 引用了未注册的动作：${step.action}`)
    }
  }
})

test('需要真实对话的任务码与零消耗动作表无交集', () => {
  for (const { code } of zeroCostActions()) {
    assert.equal(NEEDS_REAL_CHAT.has(code), false, `${code} 同时在两个表里，语义矛盾`)
  }
})

test('⚠️ NEEDS_REAL_CHAT 覆盖 AGENTS.md §6.4 列出的 6 个任务', () => {
  // 这 6 个是实测会消耗配额的任务，绝不能进第一版
  const expected = [
    'Model_chat_GLM5.2',
    'expert_5',
    'Expert_team_use_3',
    'skill_1',
    'Expert_lighthouse',
    'black_cat',
  ]
  for (const code of expected) {
    assert.ok(NEEDS_REAL_CHAT.has(code), `${code} 应被列入「需要真实对话」`)
  }
})

test('注册的动作表里含关键动作', () => {
  const registered = registeredActions()
  for (const action of ['checkin', 'balance', 'listTasks', 'verifyAndClaim']) {
    assert.ok(registered.includes(action), `缺少动作 ${action}`)
  }
})
