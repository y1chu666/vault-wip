import { describe, expect, it } from "vitest";

import { maskSecret, maskUrl } from "../src/core/mask.js";

describe("maskSecret", () => {
  it("遮去中段并保留首尾各四位", () => {
    expect(maskSecret("6b0b26f6c7ee064e2e1bf4e98c96d590")).toBe("6b0b************************d590");
  });

  it("遮罩与原文等长", () => {
    const value = "abcdefghij";
    expect(maskSecret(value)).toBe("abcd**ghij");
    expect(maskSecret(value)).toHaveLength(value.length);
  });

  it("长度恰为八时不保留任何字符", () => {
    expect(maskSecret("12345678")).toBe("********");
  });

  it("短值整段遮掉", () => {
    expect(maskSecret("abc")).toBe("***");
  });

  it("空串保持为空", () => {
    expect(maskSecret("")).toBe("");
  });
});

describe("maskUrl", () => {
  it("IPv4 留首末网段，端口固定遮成四位", () => {
    expect(maskUrl("https://121.41.191.214:6247")).toBe("https://121.***.***.214:****");
  });

  it("域名逐段遮罩并保留顶级域", () => {
    expect(maskUrl("https://relay1.example.com/api")).toBe("https://re**y1.ex***le.com/****");
    expect(maskUrl("https://relay.example.com")).toBe("https://r***y.ex***le.com");
  });

  it("过短的域名单段降级", () => {
    expect(maskUrl("qq.com")).toBe("q*.com");
    expect(maskUrl("x.com")).toBe("*.com");
  });

  it("单段主机没有顶级域可留", () => {
    expect(maskUrl("http://localhost:8080")).toBe("http://lo*****st:****");
  });

  it("IPv6 留首尾组，短地址整段遮住", () => {
    expect(maskUrl("https://[2001:db8::1]:6247")).toBe("https://[2001:****:1]:****");
    expect(maskUrl("https://[::1]")).toBe("https://[****]");
  });

  it("查询与片段只留首个分隔符", () => {
    expect(maskUrl("https://example.com?token=abc")).toBe("https://ex***le.com?****");
    expect(maskUrl("https://example.com#top")).toBe("https://ex***le.com#****");
  });

  it("解析不出地址时退回整段遮罩", () => {
    expect(maskUrl("")).toBe("");
    expect(maskUrl("https://")).toBe("********");
    expect(maskUrl("随手写的一行字")).toBe("*******");
  });
});
