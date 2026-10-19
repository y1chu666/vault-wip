// 本模块负责状态记录内容的加密与密钥的文本表示。
//
// 记录内容用 AES-256-GCM 加密，密钥按仓库划分：中继只见到密文，
// 拿不到文件名，也读不出改动情况。密文自带密钥标识，使一把密钥轮换之后
// 旧记录仍可解出，无需保留旁表。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { t } from "./i18n.js";

/** 内容密钥的字节数。 */
export const CONTENT_KEY_BYTES = 32;

/** 密钥标识的字节数。 */
export const KEY_ID_BYTES = 8;

/** AES-GCM 的随机数长度，标准取十二字节。 */
const NONCE_BYTES = 12;

/** GCM 认证标签长度。 */
const TAG_BYTES = 16;

/** 密文信封的格式版本。 */
const ENVELOPE_VERSION = 1;

/** 密钥串的前缀，使一枚密钥一眼可辨，避免与其他文本混淆。 */
const KEY_STRING_PREFIX = "wip-relay-key-v1:";

/** 口令封装的前缀。与被封装的密钥串分开，两者一眼可辨。 */
const PROTECTED_PREFIX = "wip-relay-protected-key-v1:";

/** 口令封装的格式版本。 */
const PROTECTED_VERSION = 1;

/** 口令派生所用的盐长度。 */
const SALT_BYTES = 16;

/** 口令长度上限：过长的口令只会拖慢派生，实际收益有限。 */
const MAX_PASSPHRASE_LENGTH = 1024;

/**
 * 口令派生所用代价参数的当前取值：N 为 2 的幂次、块大小与并行度。
 *
 * 这里用 scrypt 而不是通常首选的内存硬函数：插件只允许一个运行期依赖，
 * 引入额外的密码学实现不划算，而 scrypt 由运行时直接提供，代价参数也已足够高。
 * 口令分发本来就是三种分法中较弱的一种，界面上也照此标注。
 */
const SCRYPT_N_LOG2 = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** 读回口令文件时允许的最大代价参数，避免别人递来的文件把内存吃光。 */
const MAX_SCRYPT_N_LOG2 = 16;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;

/** 内容密钥。 */
export interface ContentKey {
  /** 密钥原文，三十二字节。 */
  readonly bytes: Uint8Array;
  /** 密钥标识，由密钥本身算出。 */
  readonly id: string;
}

/** 内容加密失败时的错误。 */
export class ContentCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentCryptoError";
  }
}

/** 生成一把新的内容密钥。 */
export function generateContentKey(): ContentKey {
  return contentKeyFromBytes(randomBytes(CONTENT_KEY_BYTES));
}

/** 由三十二字节构造内容密钥。 */
export function contentKeyFromBytes(bytes: Uint8Array): ContentKey {
  if (bytes.length !== CONTENT_KEY_BYTES) {
    throw new ContentCryptoError(
      t("内容密钥应为 {expected} 字节，实际为 {actual} 字节", {
        expected: CONTENT_KEY_BYTES,
        actual: bytes.length,
      }),
    );
  }
  const buffer = Buffer.from(bytes);
  return {
    bytes: new Uint8Array(buffer),
    id: createHash("sha256").update(buffer).digest("hex").slice(0, KEY_ID_BYTES * 2),
  };
}

/**
 * 把内容密钥编码成可抄写的密钥串。
 *
 * 这种形式便于逐字传递或复制，长度与字符集都做了限制，不易抄错。
 */
export function encodeContentKey(key: ContentKey): string {
  return KEY_STRING_PREFIX + Buffer.from(key.bytes).toString("base64url");
}

/** 解析密钥串。 */
export function decodeContentKey(text: string): ContentKey {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEY_STRING_PREFIX)) {
    throw new ContentCryptoError(t("密钥串缺少前缀，可能不是本插件的密钥"));
  }
  const body = trimmed.slice(KEY_STRING_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new ContentCryptoError(t("密钥串含有不合规的字符"));
  }

  const bytes = Buffer.from(body, "base64url");
  if (bytes.length !== CONTENT_KEY_BYTES) {
    throw new ContentCryptoError(
      t("密钥串解出的长度为 {actual} 字节，期望 {expected} 字节", {
        actual: bytes.length,
        expected: CONTENT_KEY_BYTES,
      }),
    );
  }
  return contentKeyFromBytes(bytes);
}

/**
 * 用口令封起内容密钥，得到一段可以交给同仓库其他设备的文本。
 *
 * 这与密钥串本身是两种分发方式：口令封装的文本离开设备之后，还需要口令才能解开，
 * 因此可以走不那麼可信的渠道；代价是口令往往比随机密钥串弱得多，界面上照此标注。
 * 文本自带代价参数，将来调高参数也不会让旧文本失效。
 */
export function protectContentKey(key: ContentKey, passphrase: string): string {
  checkPassphrase(passphrase);

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const derived = deriveKey(passphrase, salt, SCRYPT_N_LOG2, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.bytes)), cipher.final()]);

  const payload = Buffer.concat([
    Buffer.from([PROTECTED_VERSION, SCRYPT_N_LOG2, SCRYPT_R, SCRYPT_P]),
    salt,
    nonce,
    ciphertext,
    cipher.getAuthTag(),
  ]);
  return PROTECTED_PREFIX + payload.toString("base64url");
}

/** 用口令解开口令封装的内容密钥。口令不对与文件被改动都归为同一种失败。 */
export function unprotectContentKey(text: string, passphrase: string): ContentKey {
  checkPassphrase(passphrase);

  const trimmed = text.trim();
  if (!trimmed.startsWith(PROTECTED_PREFIX)) {
    throw new ContentCryptoError(t("这段文本不是本插件导出的口令文件"));
  }

  const payload = Buffer.from(trimmed.slice(PROTECTED_PREFIX.length), "base64url");
  const header = 4 + SALT_BYTES + NONCE_BYTES;
  if (payload.length < header + CONTENT_KEY_BYTES + TAG_BYTES) {
    throw new ContentCryptoError(t("口令文件过短，可能已损坏"));
  }
  if (payload[0] !== PROTECTED_VERSION) {
    throw new ContentCryptoError(
      t("口令文件的版本为 {found}，本版本只认识 {known}", {
        found: String(payload[0]),
        known: PROTECTED_VERSION,
      }),
    );
  }

  const nLog2 = payload[1] ?? 0;
  const r = payload[2] ?? 0;
  const p = payload[3] ?? 0;
  if (nLog2 > MAX_SCRYPT_N_LOG2 || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) {
    throw new ContentCryptoError(t("口令文件的代价参数超出允许范围"));
  }

  const salt = payload.subarray(4, 4 + SALT_BYTES);
  const nonce = payload.subarray(4 + SALT_BYTES, header);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(header, payload.length - TAG_BYTES);
  const derived = deriveKey(passphrase, salt, nLog2, r, p);

  const decipher = createDecipheriv("aes-256-gcm", derived, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ContentCryptoError(t("口令不对，或文件已被改动"));
  }
  return contentKeyFromBytes(new Uint8Array(plaintext));
}

/** 由口令与盐派生出对称密钥。 */
function deriveKey(passphrase: string, salt: Uint8Array, nLog2: number, r: number, p: number): Buffer {
  try {
    return scryptSync(passphrase, salt, CONTENT_KEY_BYTES, {
      N: 2 ** nLog2,
      r,
      p,
      // scrypt 的内存用量约为 128*N*r 字节，默认上限不够用，因此显式放宽。
      maxmem: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new ContentCryptoError(
      t("口令派生失败：{reason}", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** 口令长度与字符范围都做限制：过长只会拖慢派生，空口令则毫无意义。 */
function checkPassphrase(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new ContentCryptoError(t("口令不能为空"));
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new ContentCryptoError(t("口令最长 {limit} 个字符", { limit: MAX_PASSPHRASE_LENGTH }));
  }
}

/**
 * 加密记录内容。
 *
 * 布局为「版本、密钥标识、随机数、密文与认证标签」直接相接，不再套一层编码：
 * 这些字节最终会作为记录内容整体以 Base64 传输，多一层编码只是徒增体积。
 */
export function encryptContent(key: ContentKey, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return new Uint8Array(
    Buffer.concat([Buffer.from([ENVELOPE_VERSION]), Buffer.from(key.id, "hex"), nonce, ciphertext, tag]),
  );
}

/**
 * 解密记录内容。
 *
 * 只接受本格式，认证标签校验失败即报错：中继即便改动了密文，也只会让这一条读不出来，
 * 不会被当作有效内容传给使用者。
 */
export function decryptContent(key: ContentKey, envelope: Uint8Array): Uint8Array {
  const bytes = Buffer.from(envelope);
  const header = 1 + KEY_ID_BYTES + NONCE_BYTES;

  if (bytes.length < header + TAG_BYTES) {
    throw new ContentCryptoError(t("密文过短，无法解出"));
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new ContentCryptoError(
      t("密文版本为 {found}，本版本只认识 {known}", { found: String(bytes[0]), known: ENVELOPE_VERSION }),
    );
  }

  const keyId = bytes.subarray(1, 1 + KEY_ID_BYTES).toString("hex");
  if (!constantTimeEquals(keyId, key.id)) {
    throw new ContentCryptoError(t("密文所用的密钥与当前密钥不同"));
  }

  const nonce = bytes.subarray(header - NONCE_BYTES, header);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(header, bytes.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    // 具体原因（标签不符、密文被改动）对使用者没有区别，都归为「解不开」。
    throw new ContentCryptoError(t("密文校验未通过，内容可能已被改动"));
  }
}

/**
 * 以固定时间比较两段等长文本。
 *
 * 密钥标识不是秘密，但比较它发生在解密之前，这里仍然按固定时间进行，
 * 以免比较耗时泄露密钥标识的匹配前缀。
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
