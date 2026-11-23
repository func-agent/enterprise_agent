/**
 * SHA-256（纯 JS 实现）—— PKCE code_challenge 的兜底摘要。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 浏览器只在**安全上下文**（secure context）里提供 `crypto.subtle`：
 *   · https://  ✅
 *   · http://localhost / http://127.0.0.1  ✅（浏览器视为可信来源）
 *   · http://<公网 IP>:5173  ❌ —— 明文 HTTP 的非本机来源不是安全上下文
 *
 * 控制台通过公网 IP（明文 HTTP）访问时 `crypto.subtle` 为 `undefined`，
 * `await crypto.subtle.digest(...)` 会抛
 * `TypeError: Cannot read properties of undefined (reading 'digest')`，
 * 于是登录按钮点了没反应、页面报错。
 *
 * 有 `crypto.subtle` 时仍优先用原生实现（更快、经过浏览器审计）；
 * 没有时退回这里，保证任何来源都能算出 S256。
 *
 * 实现遵循 FIPS 180-4，无外部依赖。
 */

/** SHA-256 轮常量（前 64 个素数的立方根小数部分的前 32 位） */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 初始散列值（前 8 个素数的平方根小数部分的前 32 位） */
const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** 32 位循环右移 */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * 计算 SHA-256 摘要。
 *
 * @param message 待摘要的字节序列
 * @returns 32 字节的摘要
 */
export function sha256(message: Uint8Array): Uint8Array {
  // ── 填充：追加 0x80，补 0 到长度 ≡ 56 (mod 64)，末尾写 64 位大端比特长度
  const blockCount = Math.floor((message.length + 8) / 64) + 1;
  const padded = new Uint8Array(blockCount * 64);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = message.length * 8;
  // 高 32 位：按比特长度除以 2^32 取整（超过 512 MB 的输入才会用到）
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = INITIAL.slice();
  const w = new Uint32Array(64);

  for (let block = 0; block < blockCount; block++) {
    const offset = block * 64;

    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    digestView.setUint32(i * 4, h[i]);
  }
  return digest;
}
