// 本模块负责状态记录内容的加密与密钥的文本表示。
//
// 记录内容用 AES-256-GCM 加密，密钥按仓库划分：中继只见到密文，
// 拿不到文件名，也读不出改动情况。密文自带密钥标识，使一把密钥轮换之后
// 旧记录仍可解出，无需保留旁表。
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
const KEY_STRING_PREFIX = "waystation-key-v1:";

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
    throw new ContentCryptoError(`内容密钥应为 ${CONTENT_KEY_BYTES} 字节，实际为 ${bytes.length} 字节`);
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
    throw new ContentCryptoError("密钥串缺少前缀，可能不是本插件的密钥");
  }
  const body = trimmed.slice(KEY_STRING_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new ContentCryptoError("密钥串含有不合规的字符");
  }

  const bytes = Buffer.from(body, "base64url");
  if (bytes.length !== CONTENT_KEY_BYTES) {
    throw new ContentCryptoError(`密钥串解出的长度为 ${bytes.length} 字节，期望 ${CONTENT_KEY_BYTES} 字节`);
  }
  return contentKeyFromBytes(bytes);
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
    throw new ContentCryptoError("密文过短，无法解出");
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new ContentCryptoError(`密文版本为 ${String(bytes[0])}，本版本只认识 ${ENVELOPE_VERSION}`);
  }

  const keyId = bytes.subarray(1, 1 + KEY_ID_BYTES).toString("hex");
  if (!constantTimeEquals(keyId, key.id)) {
    throw new ContentCryptoError("密文所用的密钥与当前密钥不同");
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
    throw new ContentCryptoError("密文校验未通过，内容可能已被改动");
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
