/**
 * 凭证加解密 —— 控制台写入的 provider 凭证落库前加密（见 8.5 凭证安全）。
 *
 * 为什么必须加密而不是明文存库：
 *   · 厂商 key 是**平台级**资产，泄一次就是全部厂商同时沦陷；
 *   · 方案 8.5 要求「凭证仅网关进程可见，业务组件不可见」——
 *     明文入库等于把凭证交给所有能读库的人（运维、备份、误开的只读副本）；
 *   · 加密后，**只有网关进程**（持有主密钥）能还原出可用的 key。
 *
 * 算法：AES-256-GCM（带认证标签，密文被篡改会解密失败而不是给出垃圾明文）。
 * 密文格式：`v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`。
 *
 * 主密钥来自环境变量 `EAP_CREDENTIAL_MASTER_KEY`：
 *   · **不入库**（仓库 public，凭证绝不能进版本库）；
 *   · 没配主密钥时禁止写入凭证（fail closed），已存的凭证则降级为不可用，
 *     平台自动回落到环境变量 / 本地凭证文件，不会因为缺主密钥就起不来。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** 标准 base64 字符集（带 padding） */
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 严格 base64 解码。
 *
 * 为什么不能用 `Buffer.from(x, 'base64')` 直接解：
 * Node 的 base64 解码器**很宽松** —— 尾部多一个字符会被静默丢弃
 * （例如 "YWJjZA" 解出来是 "abcd"，末尾的 A 被吞掉）。
 * 这会让「密文被篡改」看起来没被发现：GCM 标签校验的是**实际解出的字节**，
 * 而被吞掉的那截根本没进密文。
 * 所以这里额外做「解码后再编码必须与原文逐字节相同」的回环校验，
 * 任何多余/缺失/非法字符都会直接判定为格式错误。
 */
function decodeBase64Strict(value: string): Buffer | undefined {
  if (!value || !B64_RE.test(value)) return undefined;
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) return undefined;
  return buf;
}

/** 由主密钥派生 32 字节对称密钥 */
export function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

/** 加密明文凭证 */
export function encryptSecret(plain: string, masterKey: string): string {
  if (!masterKey) throw new Error('缺少凭证主密钥，无法加密');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * 解密；主密钥不对 / 数据被篡改 / 格式不对时返回 undefined。
 *
 * 刻意**不抛异常**：凭证不可用时应降级（回落到环境变量），而不是让整个请求 500。
 */
export function decryptSecret(payload: string, masterKey: string): string | undefined {
  if (!payload || !masterKey) return undefined;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
  const iv = decodeBase64Strict(parts[1]);
  const tag = decodeBase64Strict(parts[2]);
  const ciphertext = decodeBase64Strict(parts[3]);
  if (!iv || !tag || !ciphertext) return undefined;
  if (iv.length !== IV_BYTES) return undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(masterKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * 掩码 —— 只保留后 4 位。
 *
 * 后 4 位足以让管理员确认「换没换成那把 key」，又不至于让 key 从截图里被抄走。
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '***';
  return `***${secret.slice(-4)}`;
}
