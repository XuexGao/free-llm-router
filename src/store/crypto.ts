/**
 * 凭据加密存储（AES-GCM）。
 *
 * ## 为什么必须加密，不能像 Go 侧那样明文存盘
 *
 * Go 侧把 accessToken / refreshToken **明文**写进 `auths/*.json`
 * （其 README 自己也承认这是「已知弱点」，并警告第三方分发包可能窃取凭据）。
 * 上游 token 是**明文 bearer** —— 拿到即等于拿到账号。
 *
 * ⇒ 本项目不继承这个弱点：凭据落 DO SQLite 前必须加密（AGENTS.md §7.1）。
 *
 * ## 设计取舍
 *
 * - **密钥来源**：Worker secret `CREDENTIAL_KEY`（不落代码、不落仓库）。
 * - **未配置密钥时拒绝写入**，而不是静默明文落盘 —— 静默降级是最糟的选择，
 *   因为用户会以为「已经加密了」。
 * - **AES-GCM**：带认证标签，篡改会解密失败（而不是得到垃圾明文）。
 * - **每次加密用新 IV**：GCM 下 IV 重用是**灾难性**的（会泄漏明文异或值并
 *   允许伪造认证标签），故绝不复用。
 */

/** 加密后的凭据载荷（存进 DO SQLite 的形态）。 */
export interface EncryptedPayload {
  /** 算法标识（便于将来轮换）。 */
  v: 1
  /** base64url 编码的 IV（12 字节，GCM 标准长度）。 */
  iv: string
  /** base64url 编码的密文（含 GCM 认证标签）。 */
  ct: string
}

/** 凭据加密/解密错误。 */
export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialCryptoError'
  }
}

/** base64url 编码（无填充，与 URL 安全）。 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** base64url 解码。 */
function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 从 secret 派生 AES-GCM 密钥。
 *
 * ⚠️ 用 SHA-256 派生（而不是直接用 secret 当密钥）：secret 是任意长度字符串，
 * 而 AES-GCM 要求 128/192/256 位密钥。SHA-256 给它固定 256 位。
 *
 * 注意：这不是 KDF（无 salt、无迭代），因为它不是从**低熵密码**派生 ——
 * `CREDENTIAL_KEY` 应当是高熵随机串（用 `openssl rand -base64 32` 生成）。
 * 若将来要支持用户自设密码，必须换成 PBKDF2/scrypt。
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * 解析并校验 `CREDENTIAL_KEY`。
 *
 * ⚠️ **未配置就抛错**（fail-closed），不静默降级成明文。
 */
export function requireCredentialKey(secret: string | undefined): string {
  if (secret === undefined || secret.trim() === '') {
    throw new CredentialCryptoError(
      '未配置 CREDENTIAL_KEY，拒绝存储凭据（不静默明文落盘）。' +
        '请执行：wrangler secret put CREDENTIAL_KEY（值用 `openssl rand -base64 32` 生成）',
    )
  }
  return secret
}

/** 加密任意可 JSON 序列化的凭据对象。 */
export async function encryptCredential(secret: string, plaintext: unknown): Promise<string> {
  const key = await deriveKey(secret)
  // ⚠️ 每次新 IV：GCM 下 IV 重用会同时破坏机密性与完整性
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(plaintext))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)

  const payload: EncryptedPayload = {
    v: 1,
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(payload)
}

/**
 * 解密凭据。
 *
 * 解密失败（篡改 / 换错密钥 / 格式损坏）会**抛错而不是返回垃圾** ——
 * GCM 的认证标签保证这一点。
 */
export async function decryptCredential<T = unknown>(secret: string, stored: string): Promise<T> {
  let payload: EncryptedPayload
  try {
    payload = JSON.parse(stored) as EncryptedPayload
  } catch {
    throw new CredentialCryptoError('凭据密文不是合法 JSON（数据损坏？）')
  }

  if (payload.v !== 1) {
    throw new CredentialCryptoError(`不支持的凭据版本：${String(payload.v)}`)
  }
  if (typeof payload.iv !== 'string' || typeof payload.ct !== 'string') {
    throw new CredentialCryptoError('凭据密文缺少 iv/ct 字段')
  }

  const key = await deriveKey(secret)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(payload.iv) },
      key,
      fromBase64Url(payload.ct),
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    // 不区分「密钥错」与「密文坏」：给攻击者的信息越少越好
    throw new CredentialCryptoError('凭据解密失败（密钥不匹配或密文被篡改）')
  }
}

/** 脱敏：token 只留首尾各 4 字符，用于日志与面板展示。 */
export function maskToken(token: string): string {
  if (token === '') return '(空)'
  if (token.length <= 12) return '***'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}
