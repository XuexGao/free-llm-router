/**
 * MD5（RFC 1321）的**纯 TypeScript** 实现。
 *
 * ## 为什么必须在项目内自带一份（这是一个真实阻塞点）
 *
 * 讯飞账号（CAccount）端点的 HMAC-SHA1 签名里，第 4 段是 `Content-MD5`
 * （参考项目 `src/loomy-sign.ts:40-43`，由 `createHash('md5')` 产出）。
 * 而 **WebCrypto 压根没有 MD5**：`crypto.subtle.digest()` 支持的算法只有
 * SHA-1/256/384/512（`MD5` 会抛 `NotSupportedError`），且 Workers 里
 * 不可能引入 `node:crypto`。
 *
 * ⇒ 结论：**签名头这一整个能力**取决于「有没有 MD5」。故这里内联一份，
 * 使 `loomyAuthHeaders` 全链路可用（见 `loomy.ts`）。
 *
 * ## 它不是安全边界
 *
 * `Content-MD5` 是**完整性校验头**（防传输损坏），不是签名本身 ——
 * 签名是 HMAC-SHA1。所以「用了 MD5」不构成安全弱点，无需替换成 SHA-256：
 * 那样反而会让上游判签名不匹配。
 *
 * ## 实现纪律
 *
 * - **纯函数、零依赖**：只吃 `Uint8Array`，不碰 `Buffer`/`node:crypto`；
 * - 全部中间量用 32 位整数运算（`| 0` / `>>> 0` 保持无符号语义），
 *   不依赖 `BigInt`（Free 计划 CPU 只有 10ms，BigInt 明显更慢）；
 * - 已用已知向量锁死：`md5("")` = `d41d8cd98f00b204e9800998ecf8427e`、
 *   `md5("abc")` = `900150983cd24fb0d6963f7d28e17f72`、
 *   `md5("message digest")` = `f96b697d7cb7938d525a2f31aaf161d0`
 *   （RFC 1321 附录 A.5 的官方测试集，见 `tests/` 中同源断言）。
 */

/**
 * 每轮的左移位数（RFC 1321 的 `s` 表，4 轮 × 16 步）。
 *
 * ⚠️ 顺序**必须**按 `[round][step]` 展开：MD5 的四个轮次用的是不同函数
 * （F/G/H/I），但移位表是「每轮一个固定序列」，写成一张 16 项表循环会错。
 */
const SHIFTS: readonly number[] = [
  // 第 1 轮
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  // 第 2 轮
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  // 第 3 轮
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  // 第 4 轮
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/**
 * 正弦常量表 `K[i] = floor(abs(sin(i + 1)) * 2^32)`。
 *
 * ⚠️ **硬编码而不是运行时算**：`Math.sin` 在不同引擎上的最后一位可能有差异，
 * 而 MD5 对每一位都敏感 —— 运行时算会让「某个运行时的摘要与其它运行时不同」
 * 这种最坏形态成为可能。RFC 1321 已把这些常量列成表，照抄即可。
 */
const K: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

/** 32 位循环左移；`>>> 0` 保证无符号（否则高位移入会变成负数）。 */
function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

/**
 * 计算 MD5 摘要。
 *
 * @param bytes 任意长度输入（空输入合法，得 `d41d8cd98f00b204e9800998ecf8427e`）。
 * @returns **16 字节**的小端序摘要。
 */
export function md5Bytes(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  // 填充：0x80 + 若干个 0，直到 (len + 1 + pad) % 64 === 56（留 8 字节存比特长度）
  const paddedLength = (((length + 8) >>> 6) + 1) << 6
  const buffer = new Uint8Array(paddedLength)
  buffer.set(bytes)
  buffer[length] = 0x80

  // 末尾 8 字节 = 原始比特长度（**小端**）。用两个 32 位半字算，
  // 避免 `length * 8` 在超长输入上超出 2^53（Workers 里不可能，但代价为零）。
  const bitLengthLow = (length << 3) >>> 0
  const bitLengthHigh = (length >>> 29) >>> 0
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  view.setUint32(paddedLength - 8, bitLengthLow, true)
  view.setUint32(paddedLength - 4, bitLengthHigh, true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const words = new Uint32Array(16)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true)

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i += 1) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const tmp = d
      d = c
      c = b
      const sum = (a + f + (K[i] ?? 0) + (words[g] ?? 0)) >>> 0
      b = (b + rotateLeft(sum, SHIFTS[i] ?? 0)) >>> 0
      a = tmp
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return out
}

/** 小写 hex 摘要（32 字符）。 */
export function md5Hex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of md5Bytes(bytes)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Base64 摘要。
 *
 * ⚠️ 用 `btoa` 而不是 `Buffer`：后者在 Workers 里是 `nodejs_compat` 的补丁层，
 * 而本项目的供应商层纪律是**只用 Web 标准**（见 `types.ts` 的注释）。
 */
export function md5Base64(bytes: Uint8Array): string {
  const digest = md5Bytes(bytes)
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary)
}
