import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CLOCK_SKEW_SECONDS,
  NONCE_BYTES,
  digestHex,
  formatRfc3339,
  newNonce,
  nowSeconds,
  parseRfc3339,
  recordSigningText,
  requestSigningText,
  responseSigningText,
  signRecord,
  signRequest,
  verifyRecord,
  verifyResponse,
} from "../src/core/envelope.js";
import { DeviceKey, verifySignature } from "../src/core/identity.js";

const key = DeviceKey.fromSeed(Buffer.from(Array.from({ length: 32 }, (_, index) => index)));
const other = DeviceKey.generate();

const body = Buffer.from(`{"channel":"vault-example"}`, "utf8");

describe("requestSigningText", () => {
  it("按固定顺序拼出规范文本", () => {
    const text = requestSigningText({
      method: "POST",
      path: "/v1/report",
      fingerprint: key.fingerprint,
      timestampSeconds: 1700000000,
      nonce: "ab".repeat(32),
      body,
    });

    expect(text.split("\n")).toEqual([
      "waystation-request-v1",
      "POST",
      "/v1/report",
      key.fingerprint,
      "1700000000",
      "ab".repeat(32),
      digestHex(body),
    ]);
  });

  it("方法与路径不同则文本不同，签名不能挪用", () => {
    const base = {
      method: "POST",
      path: "/v1/report",
      fingerprint: key.fingerprint,
      timestampSeconds: 1700000000,
      nonce: "ab".repeat(32),
      body,
    };

    expect(requestSigningText({ ...base, method: "GET" })).not.toBe(requestSigningText(base));
    expect(requestSigningText({ ...base, path: "/v1/revoke" })).not.toBe(requestSigningText(base));
  });

  it("签出的请求可被对端以公钥验证", () => {
    const elements = {
      method: "POST",
      path: "/v1/register",
      fingerprint: key.fingerprint,
      timestampSeconds: 1700000000,
      nonce: "cd".repeat(32),
      body,
    };
    const signature = signRequest(key, elements);

    expect(verifySignature(key.publicKey, Buffer.from(requestSigningText(elements), "utf8"), signature)).toBe(true);
    expect(verifySignature(other.publicKey, Buffer.from(requestSigningText(elements), "utf8"), signature)).toBe(false);
  });
});

describe("responseSigningText", () => {
  it("按固定顺序拼出规范文本", () => {
    const text = responseSigningText({ fingerprint: key.fingerprint, status: 200, body });

    expect(text.split("\n")).toEqual([
      "waystation-response-v1",
      key.fingerprint,
      "200",
      digestHex(body),
    ]);
  });
});

describe("verifyResponse", () => {
  const elements = { fingerprint: key.fingerprint, status: 200, body };
  const signature = key.sign(Buffer.from(responseSigningText(elements), "utf8"));

  it("指纹相符且签名正确时通过", () => {
    expect(verifyResponse(key.fingerprint, key.publicKey, elements, signature)).toBe(true);
  });

  it("指纹与钉住值不符时拒绝，即使签名本身成立", () => {
    expect(verifyResponse(other.fingerprint, key.publicKey, elements, signature)).toBe(false);
  });

  it("正文被替换后拒绝", () => {
    const replaced = { ...elements, body: Buffer.from(`{"channel":"改过的"}`, "utf8") };

    expect(verifyResponse(key.fingerprint, key.publicKey, replaced, signature)).toBe(false);
  });

  it("状态码被替换后拒绝", () => {
    expect(verifyResponse(key.fingerprint, key.publicKey, { ...elements, status: 500 }, signature)).toBe(false);
  });

  it("换了公钥后拒绝", () => {
    expect(verifyResponse(key.fingerprint, other.publicKey, elements, signature)).toBe(false);
  });
});

describe("recordSigningText", () => {
  const collectedAt = new Date(1700000123_000);

  it("按固定顺序拼出规范文本", () => {
    const text = recordSigningText({
      fingerprint: key.fingerprint,
      channel: "0f8c1a2b3c4d5e6f708192a3b4c5d6e7",
      sequence: 7,
      collectedAt,
      payload: Buffer.from("ciphertext", "utf8"),
    });

    expect(text.split("\n")).toEqual([
      "waystation-record-v1",
      "0f8c1a2b3c4d5e6f708192a3b4c5d6e7",
      key.fingerprint,
      "7",
      "2023-11-14T22:15:23Z",
      digestHex(Buffer.from("ciphertext", "utf8")),
    ]);
  });

  it("把时间折算为协调世界时", () => {
    const local = new Date(1700000123_000);
    const elements = {
      fingerprint: key.fingerprint,
      channel: "channel",
      sequence: 1,
      collectedAt: local,
      payload: Buffer.alloc(0),
    };

    expect(recordSigningText(elements)).toContain("2023-11-14T22:15:23Z");
  });
});

describe("signRecord 与 verifyRecord", () => {
  const elements = {
    fingerprint: key.fingerprint,
    channel: "0f8c1a2b3c4d5e6f708192a3b4c5d6e7",
    sequence: 7,
    collectedAt: new Date(1700000123_000),
    payload: Buffer.from("ciphertext", "utf8"),
  };

  it("本设备签出的记录可被他人以公钥验证", () => {
    expect(verifyRecord(key.publicKey, elements, signRecord(key, elements))).toBe(true);
  });

  it("序号、频道、时间或内容被改动后验证不通过", () => {
    const signature = signRecord(key, elements);

    expect(verifyRecord(key.publicKey, { ...elements, sequence: 8 }, signature)).toBe(false);
    expect(verifyRecord(key.publicKey, { ...elements, channel: "另一个频道" }, signature)).toBe(false);
    expect(verifyRecord(key.publicKey, { ...elements, collectedAt: new Date(1700000124_000) }, signature)).toBe(false);
    expect(verifyRecord(key.publicKey, { ...elements, payload: Buffer.from("改过的") }, signature)).toBe(false);
  });

  it("换成别的公钥后验证不通过", () => {
    expect(verifyRecord(other.publicKey, elements, signRecord(key, elements))).toBe(false);
  });
});

describe("formatRfc3339", () => {
  it("不带小数秒，并以 Z 表示协调世界时", () => {
    expect(formatRfc3339(new Date(1700000123_456))).toBe("2023-11-14T22:15:23Z");
    expect(formatRfc3339(new Date(0))).toBe("1970-01-01T00:00:00Z");
  });

  it("拒绝无效时间", () => {
    expect(() => formatRfc3339(new Date(Number.NaN))).toThrow(/时间无效/);
  });
});

describe("parseRfc3339", () => {
  it("接受带 Z 与带偏移的写法", () => {
    expect(parseRfc3339("2023-11-14T22:15:23Z").getTime()).toBe(1700000123_000);
    expect(parseRfc3339("2023-11-14T23:15:23+01:00").getTime()).toBe(1700000123_000);
    expect(parseRfc3339("2023-11-14T22:15:23.500Z").getTime()).toBe(1700000123_500);
  });

  it("拒绝不合法的时间文本", () => {
    expect(() => parseRfc3339("2023-11-14 22:15:23")).toThrow(/RFC 3339/);
    expect(() => parseRfc3339("2023-11-14T22:15:23")).toThrow(/RFC 3339/);
    expect(() => parseRfc3339("随便写的")).toThrow(/RFC 3339/);
  });
});

describe("newNonce 与 nowSeconds", () => {
  it("一次性随机值为三十二字节的十六进制文本", () => {
    const first = newNonce();

    expect(first).toHaveLength(NONCE_BYTES * 2);
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(first).not.toBe(newNonce());
  });

  it("时间戳截到整秒", () => {
    expect(nowSeconds(new Date(1700000123_999))).toBe(1700000123);
    expect(CLOCK_SKEW_SECONDS).toBe(60);
  });
});

describe("digestHex", () => {
  it("给出 SHA-256 的十六进制摘要", () => {
    expect(digestHex(Buffer.alloc(0))).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });
});
