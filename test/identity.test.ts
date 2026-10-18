import { describe, expect, it } from "vitest";

import {
  DeviceKey,
  FINGERPRINT_LENGTH,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  fingerprintOf,
  parseFingerprint,
  verifySignature,
} from "../src/core/identity.js";

/** 一段固定种子，仅用于确认同一输入得到同一结果。 */
const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const seedText = seed.toString("hex");

describe("DeviceKey", () => {
  it("生成的密钥给出三十二字节公钥与六十四位指纹", () => {
    const key = DeviceKey.generate();

    expect(key.publicKey).toHaveLength(PUBLIC_KEY_BYTES);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(key.fingerprint).toHaveLength(FINGERPRINT_LENGTH);
    expect(key.fingerprint).toBe(fingerprintOf(key.publicKey));
  });

  it("同一台设备两次生成得到不同的密钥", () => {
    expect(DeviceKey.generate().fingerprint).not.toBe(DeviceKey.generate().fingerprint);
  });

  it("由种子构造的密钥可重复得到", () => {
    const first = DeviceKey.fromSeed(seed);
    const second = DeviceKey.fromSeed(seed);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.seedHexForStorage()).toBe(seedText);
  });

  it("种子文本可以往返", () => {
    const key = DeviceKey.fromSeedText(seedText);

    expect(key.seedHexForStorage()).toBe(seedText);
    expect(DeviceKey.fromSeedText(key.seedHexForStorage()).fingerprint).toBe(key.fingerprint);
  });

  it("签名可以自验", () => {
    const key = DeviceKey.fromSeed(seed);
    const message = Buffer.from("待签名的内容", "utf8");
    const signature = key.sign(message);

    expect(signature).toHaveLength(SIGNATURE_BYTES);
    expect(verifySignature(key.publicKey, message, signature)).toBe(true);
  });

  it("消息被改动后验证不通过", () => {
    const key = DeviceKey.fromSeed(seed);
    const signature = key.sign(Buffer.from("原件", "utf8"));

    expect(verifySignature(key.publicKey, Buffer.from("改件", "utf8"), signature)).toBe(false);
  });

  it("换一把公钥后验证不通过", () => {
    const key = DeviceKey.fromSeed(seed);
    const other = DeviceKey.generate();
    const message = Buffer.from("内容", "utf8");

    expect(verifySignature(other.publicKey, message, key.sign(message))).toBe(false);
  });

  it("拒绝长度不对的种子与种子文本", () => {
    expect(() => DeviceKey.fromSeed(Buffer.alloc(31))).toThrow(/31 字节/);
    expect(() => DeviceKey.fromSeedText(seedText.slice(0, 62))).toThrow(/小写十六进制/);
    expect(() => DeviceKey.fromSeedText(seedText.toUpperCase())).toThrow(/小写十六进制/);
    expect(() => DeviceKey.fromSeedText(`${seedText}zz`)).toThrow(/小写十六进制/);
  });

  it("拒绝长度不对的公钥与签名", () => {
    const key = DeviceKey.fromSeed(seed);
    const message = Buffer.from("内容", "utf8");
    const signature = key.sign(message);

    expect(verifySignature(Buffer.alloc(31), message, signature)).toBe(false);
    expect(verifySignature(key.publicKey, message, signature.subarray(0, 63))).toBe(false);
  });
});

describe("fingerprintOf", () => {
  it("拒绝长度不对的公钥", () => {
    expect(() => fingerprintOf(Buffer.alloc(33))).toThrow(/公钥应为 32 字节/);
  });
});

describe("parseFingerprint", () => {
  it("接受六十四位小写十六进制", () => {
    const text = "a".repeat(64);

    expect(parseFingerprint(text)).toBe(text);
  });

  it("拒绝长度或字符不合规的文本", () => {
    expect(() => parseFingerprint("a".repeat(63))).toThrow(/小写十六进制/);
    expect(() => parseFingerprint("A".repeat(64))).toThrow(/小写十六进制/);
    expect(() => parseFingerprint("g".repeat(64))).toThrow(/小写十六进制/);
  });
});
