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
  label: "示例设备甲",
  paths: ["notes/a.md", "notes/b.md", "notes/a.md"],
  suspectFiles: ["notes/b.md"],
  conflictFiles: ["notes/c.md"],
};

/**
 * 拼一份内容文本。
 *
 * 各用例只写出关心的字段，其余取空值，免得每处都重复一遍完整形状。
 */
function raw(fields: Record<string, unknown>): Uint8Array {
  return encodeText(
    JSON.stringify({
      label: "",
      count: 0,
      truncated: false,
      paths: [],
      suspectFiles: [],
      conflictFiles: [],
      ...fields,
    }),
  );
}

describe("buildStatusPayload", () => {
  it("去掉重复并给出总数", () => {
    const payload = buildStatusPayload(collected);

    expect(payload.label).toBe("示例设备甲");
    expect(payload.count).toBe(2);
    expect(payload.paths).toEqual(["notes/a.md", "notes/b.md"]);
    expect(payload.truncated).toBe(false);
    expect(payload.suspectFiles).toEqual(["notes/b.md"]);
    expect(payload.conflictFiles).toEqual(["notes/c.md"]);
  });

  it("清单过长时截断，但总数保持真实", () => {
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, index) => `notes/${String(index)}.md`);
    const payload = buildStatusPayload({ label: "", paths: many, suspectFiles: [], conflictFiles: [] });

    expect(payload.count).toBe(MAX_PATHS + 5);
    expect(payload.paths).toHaveLength(MAX_PATHS);
    expect(payload.truncated).toBe(true);
  });

  it("没有改动时给出空清单", () => {
    const payload = buildStatusPayload({ label: "", paths: [], suspectFiles: [], conflictFiles: [] });

    expect(payload).toEqual({
      label: "",
      count: 0,
      truncated: false,
      paths: [],
      suspectFiles: [],
      conflictFiles: [],
    });
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
    expect(() => decodeStatusPayload(raw({ extra: 1 }))).toThrow(/不认识的字段：extra/);
  });

  it("拒绝类型不符的字段", () => {
    expect(() => decodeStatusPayload(raw({ count: "1" }))).toThrow(/改动文件数不合规/);
    expect(() => decodeStatusPayload(raw({ count: -1 }))).toThrow(/改动文件数不合规/);
    expect(() => decodeStatusPayload(raw({ truncated: 1 }))).toThrow(/截断标记不合规/);
    expect(() => decodeStatusPayload(raw({ paths: "a.md" }))).toThrow(/paths 应当是数组/);
  });

  it("拒绝不合规的设备名称", () => {
    expect(() => decodeStatusPayload(raw({ label: 1 }))).toThrow(/设备名称不合规/);
    expect(() => decodeStatusPayload(raw({ label: "甲".repeat(65) }))).toThrow(/设备名称不合规/);
    expect(() => decodeStatusPayload(raw({ label: `甲${String.fromCharCode(7)}乙` }))).toThrow(
      /设备名称不合规/,
    );
    expect(() => decodeStatusPayload(raw({ label: "示例设备甲" }))).not.toThrow();
  });

  it("拒绝总数小于清单长度的内容", () => {
    expect(() => decodeStatusPayload(raw({ count: 1, paths: ["a.md", "b.md"] }))).toThrow(/小于清单长度/);
  });

  it("拒绝不合规的路径", () => {
    const make = (paths: unknown) => raw({ count: 1, paths });

    expect(() => decodeStatusPayload(make([1]))).toThrow(/非字符串条目/);
    expect(() => decodeStatusPayload(make([""]))).toThrow(/不合规的路径/);
    expect(() => decodeStatusPayload(make([`a${String.fromCharCode(0)}b`]))).toThrow(/不合规的路径/);
    expect(() => decodeStatusPayload(make(["a".repeat(4097)]))).toThrow(/不合规的路径/);
  });

  it("拒绝超过上限的清单", () => {
    const paths = Array.from({ length: MAX_PATHS + 1 }, (_, index) => `notes/${String(index)}.md`);

    expect(() => decodeStatusPayload(raw({ count: paths.length, truncated: true, paths }))).toThrow(
      new RegExp(`超过 ${String(MAX_PATHS)} 条`),
    );
  });

  it("错误都属于同一种错误类型", () => {
    expect(() => decodeStatusPayload(Buffer.alloc(0))).toThrow(StatusPayloadError);
  });
});
