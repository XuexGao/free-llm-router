import { isAlreadyDeparted, isNoUnclaimedTravel } from '../src/upstream/travel.ts'
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
import { effectiveAccessToken, needsCredentialFetch } from '../src/taskrunner/steps.ts'
import type { Env } from '../src/env.ts'

// ─────────────────── Cron 空令牌的凭据补取 ───────────────────
//
// 这两个判据对应的是一次**静默故障**：Cron 扇出刻意传空令牌（省 10ms CPU），
// 而 DO 若无条件把它当 Bearer 发出去，所有上游请求都回 401 ——
// 自动任务从未真正执行，自动签到自然从未生效。实测证据见
// `steps.ts` 里 `needsCredentialFetch` 的说明（线上 `/admin/tasks/status`）。

test('⚠️ Cron 的空令牌必须触发凭据补取（否则所有动作 401）', () => {
  assert.equal(needsCredentialFetch(''), true, '空串必须触发补取')
  assert.equal(needsCredentialFetch('real-token'), false, '有令牌时不该多一次 DO 往返')
})

test('⚠️ 补取的令牌必须真的被用上；取不到时保持空串（如实 401，不编造）', () => {
  assert.equal(effectiveAccessToken('', 'fetched'), 'fetched', '补取成功必须替换掉空串')
  assert.equal(effectiveAccessToken('', ''), '', '无凭据时保持空串，让上游如实回 401')
  assert.equal(effectiveAccessToken('explicit', 'fetched'), 'explicit', '显式令牌优先，不被覆盖')
})

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

// ─────────────────── 签到动作：幂等判据与签到日记账 ───────────────────
//
// ⚠️ 这两条锁的是**上游业务码**（不是 HTTP 状态码）—— 上游对重复签到返回
// HTTP 400 + `code:10001`（本地实测原文：
// `{"code":10001,"msg":"今天已签到，请明天再来"}`）。
// 只看 HTTP 状态码会把「今天已签」误报成**失败**，于是用户以为签到坏了。

/** 构造一个最小的 Env 替身：只提供 checkin 动作会碰的两个面。 */
function makeCheckinEnv(recorded: string[]): Env {
  return {
    ACCOUNT_POOL: {
      idFromName: (name: string) => name,
      get: () => ({
        noteCheckinDone: async (uid: string, now: number) => {
          recorded.push(`${uid}@${new Date(now + 8 * 3600_000).toISOString().slice(0, 10)}`)
        },
      }),
    },
  } as unknown as Env
}

test('⚠️ 签到幂等：HTTP 400 + code 10001 必须判为「今日已签到」而非失败', async () => {
  const { executeAction } = await import('../src/taskrunner/actions.ts')
  const recorded: string[] = []
  const env = makeCheckinEnv(recorded)
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"code":10001,"msg":"今天已签到，请明天再来"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    const r = await executeAction({ code: 'checkin', action: 'checkin', delayMs: 0 }, {
      uid: 'u1', nickname: 'n', realm: 'cn', accessToken: 't', now: Date.now(),
    }, env)
    assert.equal(r.ok, true, '幂等命中不算失败（否则用户以为签到坏了）')
    assert.match(r.detail, /已签到/, `说理应说明已签到：${r.detail}`)
    assert.equal(recorded.length, 1, '幂等命中也要记录签到日（面板标签依赖它）')
  } finally {
    globalThis.fetch = original
  }
})

test('⚠️ 签到成功：code 0 必须报出获得积分，并记录签到日', async () => {
  const { executeAction } = await import('../src/taskrunner/actions.ts')
  const recorded: string[] = []
  const env = makeCheckinEnv(recorded)
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"code":0,"msg":"OK","data":{"credit":100}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    const r = await executeAction({ code: 'checkin', action: 'checkin', delayMs: 0 }, {
      uid: 'u1', nickname: 'n', realm: 'cn', accessToken: 't', now: Date.now(),
    }, env)
    assert.equal(r.ok, true)
    assert.match(r.detail, /\+100/, `应报出获得积分：${r.detail}`)
    assert.equal(recorded.length, 1, '签到成功必须记录签到日')
  } finally {
    globalThis.fetch = original
  }
})

// ⚠️ 这两条锁「幂等判据要认哪些码/文案」。判据来自协议权威 Go 侧
// `IsAlreadyCheckin`（`internal/upstream/client.go:199-201,2071-2075`）。

test('⚠️ 14001 也是「今日已签到」（Go 侧已实测的码，初版只认 10001/1001）', async () => {
  const { dailyCheckin } = await import('../src/upstream/checkin.ts')
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"code":14001,"msg":"今日已签到"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    const r = await dailyCheckin({ uid: 'u1', accessToken: 't' }, {} as Env)
    assert.equal(r.alreadyDone, true, '14001 必须判为已签到，否则会误报失败')
    assert.equal(r.claimed, false)
  } finally {
    globalThis.fetch = original
  }
})

test('⚠️ 文案兜底只认「已签到」，不能把「活动已结束」误判成已签', async () => {
  const { dailyCheckin } = await import('../src/upstream/checkin.ts')
  const original = globalThis.fetch
  // 未知码 + 英文「活动已结束」文案：必须**不**被判为已签到。
  // 误报「已签」的方向是有害的 —— 用户以为签过了，当天积分就真的错过。
  globalThis.fetch = (async () =>
    new Response('{"code":99999,"msg":"activity already ended"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    await assert.rejects(
      () => dailyCheckin({ uid: 'u1', accessToken: 't' }, {} as Env),
      '未知码不得被当成签到成功',
    )
  } finally {
    globalThis.fetch = original
  }
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
  // 每个成长任务 2 步（动作 + 回读领奖）+ 1 个初始探测 + **1 个签到**
  // + **3 个活动类动作**（旅行 / 连登兑换 / 抽奖，各 1 步、无回读领奖）。
  //
  // ⚠️ `+1` 的签到步是**修缺陷后新增**的：早期 `planGrowth` 没有它，
  // 于是面板「执行每日任务」按承诺做「签到 → 成长任务」，实际**从未签到**。
  // 这条断言刻意把签到计入总步数 —— 若有人再把它删掉，这里会立刻变红。
  //
  // ⚠️ `+3` 的活动步同理：它们也是「承诺了但没接线」的功能
  //（`upstream/travel.ts` 早就实现了，计划表里却一直没有）。
  const activitySteps = steps.filter((s) =>
    ['travel', 'redeemStreak', 'lottery'].includes(s.action),
  )
  assert.equal(activitySteps.length, 3, '三个活动动作都必须在计划里')
  assert.equal(steps.length, actions.length * 2 + 2 + 3)
})

test('⚠️ 活动类动作**不得**带 verifyAndClaim（它们没有 task code）', () => {
  // 旅行/连登/抽奖是**独立活动**，奖励由活动接口直接发放，没有 task code。
  // 若给它们配 verifyAndClaim，会去任务列表里找一个不存在的任务 ——
  // 白跑一轮回读（约 12 秒）并留下一条假的「进度未达标」。
  const steps = planGrowth()
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]
    if (s === undefined) continue
    if (!['travel', 'redeemStreak', 'lottery'].includes(s.action)) continue
    const next = steps[i + 1]
    assert.notEqual(
      next?.action,
      'verifyAndClaim',
      `活动动作 ${s.action} 后面不该跟 verifyAndClaim`,
    )
  }
})

test('⚠️ 活动类动作必须排在成长任务之前（先拿确定性收益）', () => {
  // 旅行/连登/抽奖是**直接发积分**的；成长任务要靠回读确认、耗时更长。
  // 先做确定性收益，万一后面超时/中断，用户至少已经拿到活动的积分。
  const steps = planGrowth()
  const firstTaskIdx = steps.findIndex((s) => s.code === 'chat_5')
  const travelIdx = steps.findIndex((s) => s.action === 'travel')
  assert.ok(firstTaskIdx > 0 && travelIdx > 0, '两类步骤都应存在')
  assert.ok(travelIdx < firstTaskIdx, '活动动作应排在成长任务之前')
})

test('⚠️ 成长计划（「执行每日任务」按钮）必须包含签到步骤', () => {
  // 面板文案与后端注释都承诺「签到 → 全部成长任务 → 领奖」
  //（`src/panel/assets/index.html:50-53`、`src/index.ts:447`）。
  // 实测证据（2026-10-04，线上 `/admin/tasks/status`）：该按钮触发的运行里有
  // 23 步、若干成长任务，却**没有任何 checkin 步骤** —— 这就是用户报的
  // 「每日任务/签到不工作」。签到是幂等的，入队无副作用。
  const steps = planGrowth()
  assert.ok(
    steps.some((s) => s.action === 'checkin'),
    'growth 计划必须含 checkin（否则「执行每日任务」不会签到）',
  )
  // 开启真实对话时同样要含签到（两条分支不能分叉）
  assert.ok(
    planGrowth({ includeRealChat: true }).some((s) => s.action === 'checkin'),
    'includeRealChat=true 时也必须含 checkin',
  )
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


// ─────────────────── 旅行动作的「正常状态」不得报错 ───────────────────

test('⚠️ 旅行的「无可领取」必须判为正常（实测文案 no unclaimed travel）', () => {
  // 实测（2026-10-04 线上任务运行）：上游对「没有可领奖励」回
  // `no unclaimed travel`，而旧判据 `/not|arriv|未|还没/` **一个词都没命中**
  //（`unclaimed` 不含 `not`，`travel` 不含 `arriv`）⇒ 被当成未知错误抛出，
  // 面板上那一步显示**红色 ERR**，而真实情况是「正常，只是还没到领的时候」。
  assert.equal(isNoUnclaimedTravel(undefined, 'no unclaimed travel'), true, '必须匹配实测文案')
  assert.equal(isNoUnclaimedTravel(undefined, '尚未到达目的地'), true)
  assert.equal(isNoUnclaimedTravel(undefined, 'not arrived'), true)
  assert.equal(isNoUnclaimedTravel(10001, ''), true, '业务码 10001 是幂等码')
  // ⚠️ 真正的错误不能被误判成正常 —— 否则会**静默吞掉**真实故障
  assert.equal(isNoUnclaimedTravel(undefined, 'internal server error'), false)
  assert.equal(isNoUnclaimedTravel(500, 'unknown failure'), false)
})

test('⚠️ travelDepart 的判据要覆盖多种「已派过」文案', () => {
  assert.equal(isAlreadyDeparted(undefined, 'daily limit reached'), true)
  assert.equal(isAlreadyDeparted(undefined, 'already departed'), true)
  assert.equal(isAlreadyDeparted(undefined, 'cat is traveling'), true)
  assert.equal(isAlreadyDeparted(undefined, '今日已达上限'), true)
  assert.equal(isAlreadyDeparted(10001, ''), true)
  // 真错误不得被吞
  assert.equal(isAlreadyDeparted(500, 'internal error'), false)
})
