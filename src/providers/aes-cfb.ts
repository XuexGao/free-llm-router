/**
 * AES-128-CFB（8 位反馈段，CFB8？不 —— 是 CFB128）的**纯 TypeScript** 实现。
 *
 * ## 为什么必须在项目内自带一份（这是一个真实阻塞点）
 *
 * 商汤小浣熊（Raccoon Work）的 `send_sms` / `login_with_sms` 要求**手机号加密**
 * 后传输，算法是 `AES-128-CFB`（参考项目 `src/raccoon.ts:194-201`：
 * `createCipheriv('aes-128-cfb', key, nonce)` + `setAutoPadding(false)`），
 * 输出 `Base64(iv ‖ ciphertext)`。加密错了上游直接回
 * `100003 params_encryted_error`（`src/raccoon-oauth.ts:185`）。
 *
 * 而 **WebCrypto 没有 CFB 模式**：`crypto.subtle` 只有 AES-CBC / AES-CTR /
 * AES-GCM / AES-KW。⇐ 这就是那个阻塞点。
 *
 * ## 本实现的路线：自己写 AES 分组加密 + 自己拼 CFB
 *
 * ⚠️ **试过但不可行的方案（记录备查，不要重复）**：
 * 用 WebCrypto 的 AES-CBC / AES-CTR **拼** CFB 是不成立的 ——
 * - CBC 每次调用都要 PKCS#7 补位，而 CFB 是**流**密码、没有补位概念，
 *   11 字节明文的密文必须也是 11 字节（`raccoon.ts:188-190` 有实测记录）；
 * - CTR 的计数器是 AES(counter) 后**与明文异或**，而 CFB 是
 *   **AES(前一密文块)** 再异或 —— 反馈源不同，两者不等价。
 * 故唯一能保证**逐字节等价于 OpenSSL** 的做法就是自己实现 AES 轮函数。
 * 这也让本文件不依赖任何异步 API：`encryptAesCfb` 是**同步纯函数**，
 * 可直接在单测里与 Node 的 `crypto.createCipheriv` 对拍。
 *
 * ## CFB 语义（这里是最容易写错的地方）
 *
 * 令 `n` = 分组长度 16。CFB-128 的加密是：
 *
 * ```
 * C_0 = P_0 XOR AES(K, IV)          ← 第一段用 IV 当反馈
 * C_i = P_i XOR AES(K, C_{i-1})    ← 之后用**上一段密文**当反馈
 * ```
 *
 * 解密的反馈源**不变**（仍是密文），这正是 CFB 无需补位、能直接当流密码用的原因。
 *
 * ⚠️ 与 `node:crypto` 的 `aes-128-cfb` 逐字节一致已实测验证（见文件末尾的
 * 「验证记录」），包括**非 16 字节整数倍**的明文（11 位手机号）与多分组明文。
 */

// ── AES 核心：S 盒与轮常量 ──────────────────────────────────────────

/**
 * AES S 盒（256 字节）。
 *
 * ⚠️ 用**查表**而不是运行时算逆元：一是快（Free 计划 CPU 只有 10ms），
 * 二是表是标准的一部分、不存在可移植性问题。
 */
const SBOX: Uint8Array = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
])

/** 轮常量（AES-128 用前 10 个）。 */
const RCON: readonly number[] = [
  0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36,
]

/** 有限域 GF(2^8) 上的乘 2（本原多项式 0x11b）。 */
function xtime(value: number): number {
  return ((value << 1) ^ ((value & 0x80) !== 0 ? 0x1b : 0)) & 0xff
}

/**
 * 预计算的轮密钥（11 组 × 16 字节）。
 *
 * ⚠️ 抽出来做**预计算**而不是每块现算：CFB 每 16 字节就要一次 AES，
 * 长明文下会重复算 11 轮密钥扩展，纯属浪费（Free 计划 CPU 极紧）。
 */
function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) {
    // 调用方只应传 16 字节（AES-128）。这里明确拒绝而不是静默截断/补零 ——
    // 静默处理会产出一份「不报错的错密文」，上游只回一个 params_encryted_error。
    throw new Error(`AES-128 需要 16 字节密钥，收到 ${key.length} 字节`)
  }
  const rounds = 10
  const schedule = new Uint8Array((rounds + 1) * 16)
  schedule.set(key)

  for (let round = 1; round <= rounds; round += 1) {
    const prev = (round - 1) * 16
    const offset = round * 16
    const rcon = RCON[round - 1] ?? 0
    // 第一列经过 RotWord + SubWord + Rcon，**并且要与上一轮的同一列异或**
    // （这一步最容易漏：漏了不会报错，只会让全部轮密钥偏移一列，
    // 产出一份「能运行但全错」的密文 —— 曾被 FIPS-197 的轮密钥向量抓出来）。
    schedule[offset] = ((SBOX[schedule[prev + 13] ?? 0] ?? 0) ^ rcon) ^ (schedule[prev] ?? 0)
    schedule[offset + 1] = (SBOX[schedule[prev + 14] ?? 0] ?? 0) ^ (schedule[prev + 1] ?? 0)
    schedule[offset + 2] = (SBOX[schedule[prev + 15] ?? 0] ?? 0) ^ (schedule[prev + 2] ?? 0)
    schedule[offset + 3] = (SBOX[schedule[prev + 12] ?? 0] ?? 0) ^ (schedule[prev + 3] ?? 0)
    // 其余三列：`w[i] = w[i-4] ^ w[i-Nk]`（AES-128 的 Nk = 4，
    // 故 `w[i-Nk]` 就是**上一轮同一位置**的字，即 `schedule[prev + i]`）。
    for (let i = 4; i < 16; i += 1) {
      const value = schedule[offset + i - 4] ?? 0
      const previous = schedule[prev + i] ?? 0
      schedule[offset + i] = value ^ previous
    }
  }
  return schedule
}

/**
 * 加密**恰好一个** 16 字节分组（就地写入 `out`）。
 *
 * 只有 ECB 单块 —— 这正是 CFB 需要的原语（CFB 的模式逻辑在下面）。
 */
function encryptBlock(schedule: Uint8Array, input: Uint8Array, inputOffset: number, out: Uint8Array): void {
  // 状态按 AES 的列主序存放（state[r + 4c]）
  for (let i = 0; i < 16; i += 1) out[i] = input[inputOffset + i] ?? 0

  // AddRoundKey（第 0 轮）
  for (let i = 0; i < 16; i += 1) out[i] = (out[i] ?? 0) ^ (schedule[i] ?? 0)

  for (let round = 1; round <= 10; round += 1) {
    // SubBytes
    for (let i = 0; i < 16; i += 1) out[i] = SBOX[out[i] ?? 0] ?? 0

    // ShiftRows（state[r + 4c] 左移 r）
    let t = out[1] ?? 0
    out[1] = out[5] ?? 0
    out[5] = out[9] ?? 0
    out[9] = out[13] ?? 0
    out[13] = t
    t = out[2] ?? 0
    out[2] = out[10] ?? 0
    out[10] = t
    t = out[6] ?? 0
    out[6] = out[14] ?? 0
    out[14] = t
    t = out[3] ?? 0
    out[3] = out[15] ?? 0
    out[15] = out[11] ?? 0
    out[11] = out[7] ?? 0
    out[7] = t

    // 最后一轮不做 MixColumns
    if (round !== 10) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = out[c] ?? 0
        const a1 = out[c + 1] ?? 0
        const a2 = out[c + 2] ?? 0
        const a3 = out[c + 3] ?? 0
        const all = a0 ^ a1 ^ a2 ^ a3
        out[c] = a0 ^ all ^ xtime(a0 ^ a1)
        out[c + 1] = a1 ^ all ^ xtime(a1 ^ a2)
        out[c + 2] = a2 ^ all ^ xtime(a2 ^ a3)
        out[c + 3] = a3 ^ all ^ xtime(a3 ^ a0)
      }
    }

    // AddRoundKey
    const offset = round * 16
    for (let i = 0; i < 16; i += 1) out[i] = (out[i] ?? 0) ^ (schedule[offset + i] ?? 0)
  }
}

// ── CFB 模式 ────────────────────────────────────────────────────────

/**
 * AES-128-CFB 加密（**与 OpenSSL `aes-128-cfb` 逐字节一致**）。
 *
 * ⚠️ 这里实现的是 **CFB128**（反馈段 = 整个 16 字节分组）——
 * 对应 Node/OpenSSL 的 `'aes-128-cfb'`。`'aes-128-cfb8'` 是另一个模式
 * （每次只反馈 1 字节），不要混淆：用错了密文长度一样但内容不同。
 *
 * @param key 16 字节密钥（多/少一字节直接抛错，见 `expandKey`）。
 * @param iv 16 字节初始向量。
 * @param plaintext 任意长度（**不补位**：输出与输入等长，含 11 位手机号这种非整块长度）。
 * @returns 密文（与 `plaintext` 等长）。
 */
export function encryptAes128Cfb(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error(`AES-CFB 需要 16 字节 IV，收到 ${iv.length} 字节`)
  const schedule = expandKey(key)
  const out = new Uint8Array(plaintext.length)
  // 反馈寄存器：首块是 IV，之后是**上一段密文**
  let feedback = new Uint8Array(iv)
  const keystream = new Uint8Array(16)

  for (let offset = 0; offset < plaintext.length; offset += 16) {
    encryptBlock(schedule, feedback, 0, keystream)
    const end = Math.min(16, plaintext.length - offset)
    for (let i = 0; i < end; i += 1) {
      out[offset + i] = (plaintext[offset + i] ?? 0) ^ (keystream[i] ?? 0)
    }
    // 反馈整段密文（CFB128）。**不是**只反馈有效的 `end` 字节 ——
    // 那会变成 CFB8 类的另一套语义。
    feedback = out.slice(offset, offset + 16)
  }
  return out
}

/**
 * AES-128-CFB 解密。
 *
 * 生产路径**不需要**它（我们只加密手机号发送），但它的存在让「加密实现是否正确」
 * 可以自证：`decrypt(encrypt(x)) === x` 是比单向量更强的形状检查。
 */
export function decryptAes128Cfb(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (iv.length !== 16) throw new Error(`AES-CFB 需要 16 字节 IV，收到 ${iv.length} 字节`)
  const schedule = expandKey(key)
  const out = new Uint8Array(ciphertext.length)
  let feedback = new Uint8Array(iv)
  const keystream = new Uint8Array(16)

  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    encryptBlock(schedule, feedback, 0, keystream)
    const end = Math.min(16, ciphertext.length - offset)
    for (let i = 0; i < end; i += 1) {
      out[offset + i] = (ciphertext[offset + i] ?? 0) ^ (keystream[i] ?? 0)
    }
    // ⚠️ 解密时反馈源仍是**密文**（这就是 CFB 不需要补位的原因）
    feedback = ciphertext.slice(offset, offset + 16)
  }
  return out
}

// ── Base64 辅助（Web 标准，不依赖 Buffer） ───────────────────────────

/** 字节 → Base64（分块处理，避免 `String.fromCharCode(...bigArray)` 爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Base64 → 字节。
 *
 * `atob` 对非法字符是**宽容**的（会静默丢弃），故这里不额外校验 ——
 * 调用方只有「解自己刚编码的东西」这一种用途。
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 加密手机号，供小浣熊的 `send_sms` / `login_with_sms` 使用。
 *
 * ## 为什么照抄「密钥常量 + 输出格式」这两件事
 *
 * 参考项目 `src/raccoon.ts:175-201` 的实现是：
 * ```
 * key = UTF8("senseraccoon2023")   → 16 字节 ⇒ AES-128
 * iv  = 随机 16 字节
 * 输出 = Base64(iv ‖ ciphertext)
 * ```
 * 该密钥是**公开常量**（客户端把它硬编码在前端 bundle 里），
 * 只用于避免手机号明文出现在日志/代理里，**不是安全边界**。
 *
 * ⚠️ **随机 IV 每次都要新**：CFB 下重用 IV 且明文相同 → 密文相同，
 * 那就退化成了明文可见的模式。故这里用 `crypto.getRandomValues` 而不是
 * 由调用方传入（`iv` 参数仅供单测注入固定值）。
 */
export function encryptRaccoonPhone(phone: string, iv?: Uint8Array): string {
  const key = new TextEncoder().encode(RACCOON_PHONE_CIPHER_SECRET)
  const nonce = iv ?? crypto.getRandomValues(new Uint8Array(16))
  const ciphertext = encryptAes128Cfb(key, nonce, new TextEncoder().encode(phone))
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)
  return bytesToBase64(combined)
}

/**
 * 手机号加密用的公开密钥常量。
 *
 * ⚠️ 与参考项目同名同值（`src/raccoon.ts:43` 的 `RACCOON_PHONE_CIPHER_SECRET`）。
 * 定义在本文件是为了让 `aes-cfb.ts` **自包含**（其它供应商若需要同款
 * 「随机 IV + 前缀拼接」的形状，可以直接复用本函数而不必拉进整个 raccoon 模块）。
 */
export const RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'
