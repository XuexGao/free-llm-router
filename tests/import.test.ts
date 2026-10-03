/**
 * 账号导入的单测（双形态 + 单位陷阱）。
 *
 * ## 为什么这些断言重要
 *
 * 导入是**迁移的入口**：格式认错 → 用户必须重新登录每个账号（每个都要浏览器授权）。
 * 而 `expiresAt` 单位搞错更隐蔽 —— token 会被判定为「早已过期」，
 * 表现为**反复续期打上游**，而不是一个显眼的报错。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ImportError,
  importAuthDocuments,
  normalizeExpiresAt,
  parseAuthDocument,
  parseAuthPayload,
} from '../src/upstream/import.ts'

// ─────────────────── 嵌套形（插件 OAuth 输出，主形态） ───────────────────

test('嵌套形：正确解析 auth + account + 顶层 device_token', () => {
  const credential = parseAuthDocument({
    auth: {
      accessToken: 'at-abc',
      refreshToken: 'rt-def',
      expiresAt: 1_700_000_000, // Unix 秒
      domain: 'copilot.tencent.com',
      realm: 'cn',
    },
    account: {
      uid: '0443bd6c-a2fc-4b0a-960d-1066484a8073',
      enterpriseId: 'ent-1',
      nickname: '我的账号',
    },
    device_token: 'dt-xyz',
  })

  assert.equal(credential.accessToken, 'at-abc')
  assert.equal(credential.refreshToken, 'rt-def')
  assert.equal(credential.uid, '0443bd6c-a2fc-4b0a-960d-1066484a8073')
  assert.equal(credential.enterpriseId, 'ent-1')
  assert.equal(credential.nickname, '我的账号')
  assert.equal(credential.realm, 'cn')
})

test('⚠️ 嵌套形：expiresAt 是 Unix 秒，必须转成毫秒', () => {
  const credential = parseAuthDocument({
    auth: { accessToken: 'at', expiresAt: 1_700_000_000 },
    account: { uid: 'u1' },
  })
  // 1_700_000_000 秒 = 1_700_000_000_000 毫秒
  assert.equal(credential.expiresAt, 1_700_000_000_000)
  // 反向验证：不转的话会落到 1970 年，续期逻辑会永远认为「需要续期」
  assert.ok(credential.expiresAt > 1e12, '毫秒级时间戳应大于 1e12')
})

// ─────────────────── 扁平形（手写 / 旧版） ───────────────────

test('扁平形：正确解析顶层字段', () => {
  const credential = parseAuthDocument({
    accessToken: 'flat-at',
    refreshToken: 'flat-rt',
    expiresAt: 1_700_000_000,
    domain: 'copilot.tencent.com',
    realm: 'cn',
    uid: 'u-flat',
    enterpriseId: 'e-flat',
    nickname: '扁平',
  })
  assert.equal(credential.accessToken, 'flat-at')
  assert.equal(credential.uid, 'u-flat')
  assert.equal(credential.nickname, '扁平')
})

test('⚠️ 判据是顶层有没有 auth 键（不能靠猜字段）', () => {
  // 扁平形也有 domain/expiresAt 等字段，但**没有 auth 键**
  const flat = parseAuthDocument({ accessToken: 'a', uid: 'u', domain: 'x', expiresAt: 1, realm: 'cn' })
  assert.equal(flat.accessToken, 'a')
  // 嵌套形
  const nested = parseAuthDocument({ auth: { accessToken: 'b' }, account: { uid: 'u2' } })
  assert.equal(nested.accessToken, 'b')
})

// ─────────────────── realm 回落 ───────────────────

test('realm 缺省时按 domain 回落', () => {
  const cn = parseAuthDocument({ accessToken: 'a', uid: 'u', domain: 'copilot.tencent.com' })
  assert.equal(cn.realm, 'cn')

  const global = parseAuthDocument({ accessToken: 'a', uid: 'u', domain: 'www.workbuddy.ai' })
  assert.equal(global.realm, 'global')

  // 完全缺 domain 也回落 cn（保守：CN 是主域）
  const bare = parseAuthDocument({ accessToken: 'a', uid: 'u' })
  assert.equal(bare.realm, 'cn')
})

// ─────────────────── 错误路径 ───────────────────

test('⚠️ 缺 accessToken 抛错（不能让空凭据进池）', () => {
  assert.throws(() => parseAuthDocument({ uid: 'u1' }), ImportError)
  assert.throws(() => parseAuthDocument({ auth: { refreshToken: 'rt' }, account: { uid: 'u1' } }), ImportError)
  // 空白串也算缺
  assert.throws(() => parseAuthDocument({ accessToken: '   ', uid: 'u1' }), ImportError)
})

test('⚠️ 缺 uid 抛错（它同时是 storage key 与面板标识）', () => {
  assert.throws(() => parseAuthDocument({ accessToken: 'at' }), ImportError)
  assert.throws(() => parseAuthDocument({ auth: { accessToken: 'at' }, account: {} }), ImportError)
})

test('非对象输入抛错', () => {
  assert.throws(() => parseAuthDocument(null), ImportError)
  assert.throws(() => parseAuthDocument('string'), ImportError)
  assert.throws(() => parseAuthDocument([1, 2]), ImportError)
})

test('错误信息带来源标识（便于定位是哪个文件坏了）', () => {
  try {
    parseAuthDocument({ uid: 'u' }, 'auths/workbuddy-u.json')
    assert.fail('应该抛错')
  } catch (error) {
    assert.ok(error instanceof ImportError)
    assert.ok(error.message.includes('auths/workbuddy-u.json'), '错误信息应带来源')
  }
})

// ─────────────────── 批量导入 ───────────────────

test('⚠️ 批量导入：单条失败不影响其他条（但原因必须回报）', () => {
  const outcome = importAuthDocuments([
    { raw: { accessToken: 'at1', uid: 'u1' }, source: 'good1.json' },
    { raw: { accessToken: 'at2' }, source: 'no-uid.json' }, // 失败
    { raw: { accessToken: 'at3', uid: 'u3' }, source: 'good2.json' },
  ])

  assert.equal(outcome.imported.length, 2)
  assert.equal(outcome.skipped.length, 1)
  assert.equal(outcome.skipped[0]?.source, 'no-uid.json')
  assert.ok(outcome.skipped[0]?.reason.includes('uid'), '失败原因应说明缺 uid')
  assert.deepEqual(outcome.imported.map((i) => i.uid), ['u1', 'u3'])
})

test('⚠️ 批量导入：uid 重复时保留首次并回报（不静默丢弃）', () => {
  const outcome = importAuthDocuments([
    { raw: { accessToken: 'first', uid: 'dup' }, source: 'a.json' },
    { raw: { accessToken: 'second', uid: 'dup' }, source: 'b.json' },
  ])
  assert.equal(outcome.imported.length, 1)
  assert.equal(outcome.skipped.length, 1)
  assert.ok(outcome.skipped[0]?.reason.includes('重复'))
})

test('⚠️ 批量导入的报告里不含 token（报告会进日志）', () => {
  const outcome = importAuthDocuments([
    { raw: { accessToken: 'SUPER-SECRET-TOKEN', uid: 'u1' } },
  ])
  const serialized = JSON.stringify(outcome)
  assert.ok(!serialized.includes('SUPER-SECRET-TOKEN'), '报告里不该出现 token')
})

// ─────────────────── 载荷形态 ───────────────────

test('parseAuthPayload：接受数组', () => {
  const entries = parseAuthPayload([{ a: 1 }, { b: 2 }])
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.source, '[0]')
})

test('parseAuthPayload：接受单个对象', () => {
  const entries = parseAuthPayload({ accessToken: 'x', uid: 'u' })
  assert.equal(entries.length, 1)
})

test('parseAuthPayload：接受 {accounts:[...]} 包裹', () => {
  const entries = parseAuthPayload({ accounts: [{ a: 1 }, { b: 2 }, { c: 3 }] })
  assert.equal(entries.length, 3)
  assert.equal(entries[1]?.source, 'accounts[1]')
})

test('parseAuthPayload：非法载荷抛错', () => {
  assert.throws(() => parseAuthPayload('string'), ImportError)
  assert.throws(() => parseAuthPayload(42), ImportError)
})

// ─────────────────── 单位归一化 ───────────────────

test('normalizeExpiresAt：秒 → 毫秒', () => {
  assert.equal(normalizeExpiresAt(1_700_000_000), 1_700_000_000_000)
})

test('normalizeExpiresAt：已是毫秒则不重复乘', () => {
  assert.equal(normalizeExpiresAt(1_700_000_000_000), 1_700_000_000_000)
})

test('normalizeExpiresAt：0 或负值返回 0（表示「未知」）', () => {
  assert.equal(normalizeExpiresAt(0), 0)
  assert.equal(normalizeExpiresAt(-100), 0)
})

// ─────────────────── 端到端：真实 Go 文件形状 ───────────────────

test('端到端：贴近真实 Go auths 文件（含 device_token）', () => {
  // 这个形状逐字取自 Go 侧 auth.SaveAtomic 的写出格式
  const realFile = {
    auth: {
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.fake.jwt',
      refreshToken: 'rt_fake_value',
      expiresAt: 1_760_000_000,
      domain: 'copilot.tencent.com',
      realm: 'cn',
    },
    account: {
      uid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      enterpriseId: 'ent_123',
      nickname: '测试账号',
    },
    device_token: 'device_token_value',
  }

  const outcome = importAuthDocuments([{ raw: realFile, source: 'workbuddy-a1b2c3d4.json' }])
  assert.equal(outcome.imported.length, 1)
  assert.equal(outcome.skipped.length, 0)
  assert.equal(outcome.imported[0]?.uid, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  assert.equal(outcome.imported[0]?.realm, 'cn')
  assert.equal(outcome.imported[0]?.expiresAt, 1_760_000_000_000)
})

// ─────────────────── DSH 插件 snake_case 形态 ───────────────────

test('⚠️ 扁平形 snake_case（DSH 插件 .credentials.yaml 形态）必须能导入', () => {
  // 结构逐字取自 ~/.dsh/.credentials.yaml 的实际形态
  const dshCredential = {
    access_token: 'eyJhbGciOiJSUzI1NiJ9.fake.jwt',
    refresh_token: 'rt_fake',
    expires_at: 1793427699000, // 毫秒（DSH 侧就是毫秒）
    domain: 'copilot.tencent.com',
    user_id: '5ad0e353-69c6-4732-bbbb-cccc-ddddeeeeffff',
    enterprise_id: 'ent_dsh',
    nickname: 'DSH账号',
    account_type: 'personal',
    token_type: 'Bearer',
  }

  const credential = parseAuthDocument(dshCredential)
  assert.equal(credential.accessToken, 'eyJhbGciOiJSUzI1NiJ9.fake.jwt')
  assert.equal(credential.uid, '5ad0e353-69c6-4732-bbbb-cccc-ddddeeeeffff', 'user_id 应被识别为 uid')
  assert.equal(credential.enterpriseId, 'ent_dsh')
  assert.equal(credential.nickname, 'DSH账号')
  assert.equal(credential.realm, 'cn')
})

test('⚠️ snake_case 的 expires_at 是毫秒，不该被再次放大', () => {
  const credential = parseAuthDocument({ access_token: 'a', user_id: 'u', expires_at: 1793427699000 })
  assert.equal(credential.expiresAt, 1793427699000, '毫秒值不该 ×1000')
})

test('camelCase 与 snake_case 混用也能解析', () => {
  const credential = parseAuthDocument({ accessToken: 'camel', user_id: 'u-snake', expires_at: 1_700_000_000 })
  assert.equal(credential.accessToken, 'camel')
  assert.equal(credential.uid, 'u-snake')
  // 秒级仍会被放大
  assert.equal(credential.expiresAt, 1_700_000_000_000)
})
