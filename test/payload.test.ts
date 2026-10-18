import { describe, expect, it } from "vitest";

import {
  MAX_PATHS,
  StatusPayloadError,
  buildStatusPayload,
  decodeStatusPayload,
  encodeStatusPayload,
} from "../src/core/payload.js";
import { encodeText } from "../src/core/text.js";

/** 一份典型内容：四类改动各占若干。 */
const collected = {
  paths: ["notes/a.md", "notes/b.md", "notes/a.md"],
  suspectFiles: ["notes/b.md"],
  conflictFiles: ["notes/c.md"],
};

describe("buildStatusPayload", () => {
  it("去掉重复并给出总数", () => {
    const payload = buildStatusPayload(collected);

    expect(payload.count).toBe(2);
    expect(payload.paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(payload.truncated).toBe(false);
    expect(payload.suspectFiles).toEqual(["notes/b.md"]);
    expect(payload.conflictFiles).toEqual(["notes/c.md"]);
  });

  it("清单过长时截断，但总数保持真实", () => {
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, index) => `notes/${String(index)}.md`);
    const payload = buildStatusPayload({ paths: many, suspectFiles: [], conflictFiles: [] });

    expect(payload.count).toBe(MAX_PATHS + 5);
    expect(payload.paths).toHaveLength(MAX_PATHS);
    expect(payload.truncated).toBe(true);
  });

  it("没有改动时给出空清单", () => {
    const payload = buildStatusPayload({ paths: [], suspectFiles: [], conflictFiles: [] });

    expect(payload).toEqual({ count: 0, truncated: false, paths: [], suspectFiles: [], conflictFiles: [] });
  });
});

describe("encodeStatusPayload 与 decodeStatusPayload", () => {
  it("往返之后得到同一份内容", () => {
    const payload = buildStatusPayload(collected);

    expect(decodeStatusPayload(encodeStatusPayload(payload))).toEqual(payload);
  });

  it("拒绝不是 JSON 的字节", () => {
    expect(() => decodeStatusPayload(Buffer.from("不是 JSON", "utf8"))).toThrow(/不是合法的 JSON/);
  });

  it("拒绝非 UTF-8 的字节", () => {
    expect(() => decodeStatusPayload(Buffer.from([0xff, 0xfe]))).toThrow(/不是合法的 JSON/);
  });

  it("拒绝顶层不是对象的内容", () => {
    expect(() => decodeStatusPayload(encodeText("[]"))).toThrow(/应当是一个对象/);
    expect(() => decodeStatusPayload(encodeText(`"文本"`))).toThrow(/应当是一个对象/);
  });

  it("拒绝不认识的字段", () => {
    const text = JSON.stringify({
      count: 0,
      truncated: false,
      paths: [],
      suspectFiles: [],
      conflictFiles: [],
      extra: 1,
    });

    expect(() => decodeStatusPayload(encodeText(text))).toThrow(/不认识的字段：extra/);
  });

  it("拒绝类型不符的字段", () => {
    const base = { count: 1, truncated: false, paths: ["a.md"], suspectFiles: [], conflictFiles: [] };

    expect(() => decodeStatusPayload(encodeText(JSON.stringify({ ...base, count: "1" })))).toThrow(
      /改动文件数不合规/,
    );
    expect(() => decodeStatusPayload(encodeText(JSON.stringify({ ...base, count: -1 })))).toThrow(
      /改动文件数不合规/,
    );
    expect(() => decodeStatusPayload(encodeText(JSON.stringify({ ...base, truncated: 1 })))).toThrow(
      /截断标记不合规/,
    );
    expect(() => decodeStatusPayload(encodeText(JSON.stringify({ ...base, paths: "a.md" })))).toThrow(
      /paths 应当是数组/,
    );
  });

  it("拒绝总数小于清单长度的内容", () => {
    const text = JSON.stringify({
      count: 1,
      truncated: false,
      paths: ["a.md", "b.md"],
      suspectFiles: [],
      conflictFiles: [],
    });

    expect(() => decodeStatusPayload(encodeText(text))).toThrow(/小于清单长度/);
  });

  it("拒绝不合规的路径", () => {
    const make = (paths: unknown) =>
      encodeText(
        JSON.stringify({ count: 1, truncated: false, paths, suspectFiles: [], conflictFiles: [] }),
      );

    expect(() => decodeStatusPayload(make([1]))).toThrow(/非字符串条目/);
    expect(() => decodeStatusPayload(make([""]))).toThrow(/不合规的路径/);
    expect(() => decodeStatusPayload(make([`a${String.fromCharCode(0)}b`]))).toThrow(/不合规的路径/);
    expect(() => decodeStatusPayload(make(["a".repeat(4097)]))).toThrow(/不合规的路径/);
  });

  it("拒绝超过上限的清单", () => {
    const paths = Array.from({ length: MAX_PATHS + 1 }, (_, index) => `notes/${String(index)}.md`);
    const text = JSON.stringify({ count: paths.length, truncated: true, paths, suspectFiles: [], conflictFiles: [] });

    expect(() => decodeStatusPayload(encodeText(text))).toThrow(new RegExp(`超过 ${String(MAX_PATHS)} 条`));
  });

  it("错误都属于同一种错误类型", () => {
    expect(() => decodeStatusPayload(Buffer.alloc(0))).toThrow(StatusPayloadError);
  });
});
