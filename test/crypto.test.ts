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
  protectContentKey,
  unprotectContentKey,
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

    expect(text.startsWith("wip-relay-key-v1:")).toBe(true);
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
    expect(() => decodeContentKey(`wip-relay-key-v1:${Buffer.from(bytes).toString("base64url")}!!`)).toThrow(
      /不合规的字符/,
    );
  });

  it("拒绝长度不对的密钥串", () => {
    const short = `wip-relay-key-v1:${Buffer.alloc(16).toString("base64url")}`;

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

describe("口令封装的密钥", () => {
  const passphrase = "示例口令一二三";

  it("往返之后得到同一把密钥", () => {
    const key = generateContentKey();

    const text = protectContentKey(key, passphrase);

    expect(text.startsWith("wip-relay-protected-key-v1:")).toBe(true);
    expect(unprotectContentKey(text, passphrase).bytes).toEqual(key.bytes);
  });

  it("同一把密钥两次封装得到不同文本", () => {
    const key = generateContentKey();

    expect(protectContentKey(key, passphrase)).not.toBe(protectContentKey(key, passphrase));
  });

  it("口令不对时解不开", () => {
    const text = protectContentKey(generateContentKey(), passphrase);

    expect(() => unprotectContentKey(text, "别的口令")).toThrow(/口令不对/);
  });

  it("文本被改动时解不开", () => {
    const text = protectContentKey(generateContentKey(), passphrase);
    const body = Buffer.from(text.slice("wip-relay-protected-key-v1:".length), "base64url");
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0xff;

    expect(() => unprotectContentKey(`wip-relay-protected-key-v1:${body.toString("base64url")}`, passphrase)).toThrow(
      /口令不对|已被改动/,
    );
  });

  it("拒绝空口令与过长口令", () => {
    expect(() => protectContentKey(generateContentKey(), "")).toThrow(/不能为空/);
    expect(() => protectContentKey(generateContentKey(), "a".repeat(1025))).toThrow(/最长 1024/);
    expect(() => unprotectContentKey("wip-relay-protected-key-v1:AAAA", "")).toThrow(/不能为空/);
  });

  it("拒绝不是本插件导出的文本", () => {
    expect(() => unprotectContentKey("随手一段文本", passphrase)).toThrow(/不是本插件导出/);
  });

  it("拒绝过短的文本", () => {
    expect(() => unprotectContentKey("wip-relay-protected-key-v1:AAAA", passphrase)).toThrow(/过短/);
  });

  it("拒绝版本不同的文本", () => {
    const text = protectContentKey(generateContentKey(), passphrase);
    const body = Buffer.from(text.slice("wip-relay-protected-key-v1:".length), "base64url");
    body[0] = 9;

    expect(() =>
      unprotectContentKey(`wip-relay-protected-key-v1:${body.toString("base64url")}`, passphrase),
    ).toThrow(/只认识 1/);
  });

  it("拒绝代价参数超出范围的文本", () => {
    const text = protectContentKey(generateContentKey(), passphrase);
    const body = Buffer.from(text.slice("wip-relay-protected-key-v1:".length), "base64url");
    body[1] = 30;

    expect(() =>
      unprotectContentKey(`wip-relay-protected-key-v1:${body.toString("base64url")}`, passphrase),
    ).toThrow(/超出允许范围/);
  });
});
