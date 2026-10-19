// 本模块负责设备密钥、身份指纹与签名校验。
//
// 身份即公钥的指纹：服务端不分配标识，各设备只认指纹。私钥的落盘形式是
// 种子字节的十六进制文本，与服务端一致；文件权限与存放位置由调用方负责，
// 私钥永远不导出、不导入，也不进入版本库。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { t } from "./i18n.js";

/** 种子字节数。 */
export const SEED_BYTES = 32;

/** 公钥字节数。 */
export const PUBLIC_KEY_BYTES = 32;

/** 签名字节数。 */
export const SIGNATURE_BYTES = 64;

/** 指纹的十六进制字符数。 */
export const FINGERPRINT_LENGTH = 64;

/**
 * PKCS#8 与 SPKI 对 Ed25519 的固定前缀。
 *
 * Node 只提供密钥对象的导入导出，不给原始字节，因此要自己拼前缀取种子与公钥；
 * 前缀由 Ed25519 的算法标识决定，不随密钥变化。
 */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * 本地设备的密钥对。
 *
 * 种子与密钥对象都留在内部，只有公钥、指纹与签名的入口对外，
 * 这样调用方拿不到私钥材料，也不会在日志或窗口标题里把它带出去。
 */
export class DeviceKey {
  private constructor(
    private readonly keyObject: KeyObject,
    private readonly seedText: string,
    readonly publicKey: Uint8Array,
    readonly fingerprint: string,
  ) {}

  /** 生成新的设备密钥对。 */
  static generate(): DeviceKey {
    const { privateKey } = generateKeyPairSync("ed25519");
    return DeviceKey.fromKeyObject(privateKey);
  }

  /** 由三十二字节种子构造密钥对。 */
  static fromSeed(seed: Uint8Array): DeviceKey {
    if (seed.length !== SEED_BYTES) {
      throw new Error(t("种子应为 {expected} 字节，实际为 {actual} 字节", { expected: SEED_BYTES, actual: seed.length }));
    }
    const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]);
    return DeviceKey.fromKeyObject(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  }

  /** 解析十六进制种子文本，与服务端的私钥编码一致。 */
  static fromSeedText(text: string): DeviceKey {
    if (!/^[0-9a-f]{64}$/.test(text)) {
      throw new Error(t("私钥应为 {length} 位小写十六进制", { length: SEED_BYTES * 2 }));
    }
    return DeviceKey.fromSeed(Buffer.from(text, "hex"));
  }

  /** 对本设备发出的内容签名。 */
  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, message, this.keyObject));
  }

  /**
   * 返回私钥种子的十六进制文本，供落盘使用。
   *
   * 这是本模块唯一一次把私钥交出去的地方：种子一旦泄露，持有者即可冒充本设备。
   * 调用方只能把它写进权限收紧的密钥文件，不得写入日志、界面或任何会外传的内容。
   */
  seedHexForStorage(): string {
    return this.seedText;
  }

  private static fromKeyObject(keyObject: KeyObject): DeviceKey {
    const der = keyObject.export({ format: "der", type: "pkcs8" });
    if (!der.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX)) {
      throw new Error(t("私钥不是 Ed25519 的 PKCS#8 编码"));
    }

    const seed = der.subarray(der.length - SEED_BYTES);
    const spki = createPublicKey(keyObject).export({ format: "der", type: "spki" });
    const publicKey = spki.subarray(spki.length - PUBLIC_KEY_BYTES);

    return new DeviceKey(keyObject, seed.toString("hex"), new Uint8Array(publicKey), fingerprintOf(publicKey));
  }
}

/** 计算公钥指纹。 */
export function fingerprintOf(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(t("公钥应为 {expected} 字节，实际为 {actual} 字节", { expected: PUBLIC_KEY_BYTES, actual: publicKey.length }));
  }
  return createHash("sha256").update(publicKey).digest("hex");
}

/** 校验指纹文本，通过则返回原文本。 */
export function parseFingerprint(text: string): string {
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(t("指纹应为 {length} 位小写十六进制", { length: FINGERPRINT_LENGTH }));
  }
  return text;
}

/**
 * 校验其他设备与服务端的签名。
 *
 * 长度不合规时直接返回假，不交给底层：底层的长度检查会抛出异常，
 * 而这里更希望「验不过」是一个普通的判断结果。
 */
export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) {
    return false;
  }
  return verify(null, message, publicKeyFromBytes(publicKey), signature);
}

/** 由三十二字节原文构造公钥对象，供验签使用。 */
function publicKeyFromBytes(publicKey: Uint8Array): KeyObject {
  const der = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
