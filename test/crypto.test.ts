import { describe, expect, it } from "vitest";

import {
  CONTENT_KEY_BYTES,
  ContentCryptoError,
  KEY_ID_BYTES,
  contentKeyFromBytes,
  decodeContentKey,
  decryptContent,
  encodeContentKey,
  encryptContent,
  generateContentKey,
} from "../src/core/crypto.js";

const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

describe("内容密钥", () => {
  it("生成三十二字节密钥，并给出十六位密钥标识", () => {
    const key = generateContentKey();

    expect(key.bytes).toHaveLength(CONTENT_KEY_BYTES);
    expect(key.id).toHaveLength(KEY_ID_BYTES * 2);
    expect(key.id).toMatch(/^[0-9a-f]+$/);
  });

  it("同一份字节给出同一标识，不同字节给出不同标识", () => {
    expect(contentKeyFromBytes(bytes).id).toBe(contentKeyFromBytes(bytes).id);
    expect(contentKeyFromBytes(bytes).id).not.toBe(generateContentKey().id);
  });

  it("拒绝长度不对的密钥字节", () => {
    expect(() => contentKeyFromBytes(Buffer.alloc(16))).toThrow(/内容密钥应为 32 字节/);
  });
});

describe("密钥串", () => {
  it("往返之后得到同一把密钥", () => {
    const key = contentKeyFromBytes(bytes);
    const text = encodeContentKey(key);

    expect(text.startsWith("waystation-key-v1:")).toBe(true);
    expect(decodeContentKey(text).id).toBe(key.id);
    expect(decodeContentKey(text).bytes).toEqual(key.bytes);
  });

  it("容忍首尾空白", () => {
    const text = encodeContentKey(contentKeyFromBytes(bytes));

    expect(decodeContentKey(`  ${text}\n`).id).toBe(contentKeyFromBytes(bytes).id);
  });

  it("拒绝缺少前缀的文本", () => {
    expect(() => decodeContentKey(Buffer.from(bytes).toString("base64url"))).toThrow(/缺少前缀/);
  });

  it("拒绝含不合规字符的密钥串", () => {
    expect(() => decodeContentKey(`waystation-key-v1:${Buffer.from(bytes).toString("base64url")}!!`)).toThrow(
      /不合规的字符/,
    );
  });

  it("拒绝长度不对的密钥串", () => {
    const short = `waystation-key-v1:${Buffer.alloc(16).toString("base64url")}`;

    expect(() => decodeContentKey(short)).toThrow(/期望 32 字节/);
  });
});

describe("encryptContent 与 decryptContent", () => {
  const key = contentKeyFromBytes(bytes);
  const plaintext = Buffer.from(`{"paths":["notes/a.md"]}`, "utf8");

  it("加解密可以往返", () => {
    const encrypted = encryptContent(key, plaintext);

    expect(encrypted[0]).toBe(1);
    expect(Buffer.from(decryptContent(key, encrypted)).toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("密文里看不出明文，也不含密钥标识以外的元信息", () => {
    const encrypted = Buffer.from(encryptContent(key, plaintext));

    expect(encrypted.includes(plaintext)).toBe(false);
    expect(encrypted.length).toBe(1 + KEY_ID_BYTES + 12 + plaintext.length + 16);
  });

  it("同一份明文两次加密得到不同密文", () => {
    expect(Buffer.from(encryptContent(key, plaintext)).equals(Buffer.from(encryptContent(key, plaintext)))).toBe(false);
  });

  it("换一把密钥时拒绝解密", () => {
    const encrypted = encryptContent(generateContentKey(), plaintext);

    expect(() => decryptContent(key, encrypted)).toThrow(/密钥与当前密钥不同/);
  });

  it("密文被改动时拒绝解密", () => {
    const encrypted = Buffer.from(encryptContent(key, plaintext));
    const last = encrypted.length - 1;
    encrypted[last] = (encrypted[last] ?? 0) ^ 0x01;

    expect(() => decryptContent(key, encrypted)).toThrow(/校验未通过/);
  });

  it("拒绝过短或版本不同的密文", () => {
    expect(() => decryptContent(key, Buffer.alloc(10))).toThrow(/过短/);

    const encrypted = Buffer.from(encryptContent(key, plaintext));
    encrypted[0] = 2;
    expect(() => decryptContent(key, encrypted)).toThrow(/只认识 1/);
  });

  it("错误都属于同一种错误类型", () => {
    expect(() => decryptContent(key, Buffer.alloc(1))).toThrow(ContentCryptoError);
  });
});
