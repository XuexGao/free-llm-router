/**
 * 凭据加密的单测。
 *
 * ## 为什么这些断言重要
 *
 * 凭据层错了的后果是**不可逆的**：token 泄漏 = 账号被他人使用。
 * 而加密代码的错误往往是**静默**的（比如 IV 重用不会报错，
 * 但会破坏 GCM 的机密性与完整性保证）。
 *
 * 故这里把安全性质显式钉住。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  maskToken,
  requireCredentialKey,
} from '../src/store/crypto.ts'

const SECRET = 'test-secret-key-with-sufficient-entropy-abcdefgh'

test('加密 → 解密往返一致', async () => {
  const credential = { accessToken: 'at-123', refreshToken: 'rt-456', uid: 'u1' }
  const stored = await encryptCredential(SECRET, credential)
  const back = await decryptCredential<typeof credential>(SECRET, stored)
  assert.deepEqual(back, credential)
})

test('⚠️ 明文不出现在密文里（最基本的机密性）', async () => {
  const stored = await encryptCredential(SECRET, { accessToken: 'SUPER-SECRET-TOKEN-VALUE' })
  assert.ok(!stored.includes('SUPER-SECRET-TOKEN-VALUE'), '密文里不该出现明文 token')
})

test('⚠️ 每次加密的 IV 都不同（GCM 下 IV 重用是灾难性的）', async () => {
  const a = await encryptCredential(SECRET, { x: 'same' })
  const b = await encryptCredential(SECRET, { x: 'same' })
  const ivA = (JSON.parse(a) as { iv: string }).iv
  const ivB = (JSON.parse(b) as { iv: string }).iv
  assert.notEqual(ivA, ivB, '相同明文两次加密的 IV 必须不同')
  assert.notEqual(a, b, '密文也应不同（语义安全）')
})

test('换密钥无法解密（而不是返回垃圾）', async () => {
  const stored = await encryptCredential(SECRET, { token: 'x' })
  await assert.rejects(
    () => decryptCredential('a-completely-different-secret-value-here', stored),
    CredentialCryptoError,
  )
})

test('⚠️ 篡改密文会被检测到（GCM 认证标签）', async () => {
  const stored = await encryptCredential(SECRET, { token: 'x' })
  const payload = JSON.parse(stored) as { v: number; iv: string; ct: string }

  // ⚠️ 必须改**首字符**，不能改末字符。
  // 原因：base64 的**最后一个**字符若处于非 4 的倍数位置，其低位是"填充位"，
  // 解码器会忽略 —— 改末字符可能解码出**完全相同的字节**，于是篡改"没发生"，
  // 测试就会随机失败（本文件最初就踩了这个坑）。
  // 已实测：翻转首字符必定改变解码后的首字节。
  const first = payload.ct[0] ?? 'A'
  const replacement = first === 'A' ? 'B' : 'A'
  const tampered = { ...payload, ct: replacement + payload.ct.slice(1) }

  assert.notEqual(tampered.ct, payload.ct, '前置条件：密文确实被改了')
  await assert.rejects(() => decryptCredential(SECRET, JSON.stringify(tampered)), CredentialCryptoError)
})

test('⚠️ 篡改 IV 也会被检测到', async () => {
  const stored = await encryptCredential(SECRET, { token: 'y' })
  const payload = JSON.parse(stored) as { v: number; iv: string; ct: string }
  const first = payload.iv[0] ?? 'A'
  const tampered = { ...payload, iv: (first === 'A' ? 'B' : 'A') + payload.iv.slice(1) }
  await assert.rejects(() => decryptCredential(SECRET, JSON.stringify(tampered)), CredentialCryptoError)
})

test('损坏的 JSON 给出明确错误而不是崩溃', async () => {
  await assert.rejects(() => decryptCredential(SECRET, 'not-json-at-all'), CredentialCryptoError)
})

test('不支持的版本号被拒绝', async () => {
  const payload = { v: 99, iv: 'AAAA', ct: 'BBBB' }
  await assert.rejects(() => decryptCredential(SECRET, JSON.stringify(payload)), CredentialCryptoError)
})

test('⚠️ 缺 iv/ct 字段被拒绝', async () => {
  await assert.rejects(() => decryptCredential(SECRET, JSON.stringify({ v: 1 })), CredentialCryptoError)
})

test('⚠️ 未配置密钥时 requireCredentialKey 抛错（fail-closed，不静默明文）', () => {
  assert.throws(() => requireCredentialKey(undefined), CredentialCryptoError)
  assert.throws(() => requireCredentialKey(''), CredentialCryptoError)
  assert.throws(() => requireCredentialKey('   '), CredentialCryptoError)
})

test('配置了密钥时正常返回', () => {
  assert.equal(requireCredentialKey(SECRET), SECRET)
})

test('maskToken 不泄漏 token 主体', () => {
  const masked = maskToken('abcdefghijklmnopqrstuvwxyz')
  assert.ok(!masked.includes('ijklmnop'), '中间部分不该出现')
  assert.ok(masked.startsWith('abcd'))
  assert.ok(masked.endsWith('wxyz'))
  // 短 token 整个打掉
  assert.equal(maskToken('short'), '***')
  assert.equal(maskToken(''), '(空)')
})

test('可以加密非对象（数组 / 字符串）', async () => {
  const arr = await encryptCredential(SECRET, [1, 2, 3])
  assert.deepEqual(await decryptCredential(SECRET, arr), [1, 2, 3])
  const str = await encryptCredential(SECRET, 'plain')
  assert.equal(await decryptCredential(SECRET, str), 'plain')
})
