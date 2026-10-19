import { beforeEach, describe, expect, it } from "vitest";

import { ENGLISH, LOCALES, PLUGIN_NAME, getLocale, isLocale, setLocale, t } from "../src/core/i18n.js";

/** 取出一句话里的占位名称，便于核对中英两份是否对得上。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("文案", () => {
  beforeEach(() => {
    setLocale("zh");
  });

  it("默认说中文，取到的就是原句", () => {
    expect(getLocale()).toBe("zh");
    expect(t("注册完成")).toBe("注册完成");
  });

  it("换成英文之后取译文", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("注册完成")).toBe("registration complete");
  });

  it("按名称替换占位", () => {
    setLocale("zh");
    expect(t("已吊销设备 {fingerprint}", { fingerprint: "0123456789abcdef" })).toBe(
      "已吊销设备 0123456789abcdef",
    );
    setLocale("en");
    expect(t("已吊销设备 {fingerprint}", { fingerprint: "0123456789abcdef" })).toBe(
      "revoked device 0123456789abcdef",
    );
  });

  it("没给出实参的占位原样留下", () => {
    expect(t("已吊销设备 {fingerprint}")).toBe("已吊销设备 {fingerprint}");
    expect(t("已吊销设备 {fingerprint}", { other: "x" })).toBe("已吊销设备 {fingerprint}");
  });

  it("数出来的实参照实写进句子", () => {
    setLocale("en");
    expect(t("冲突 {count}", { count: 3 })).toBe("conflicts 3");
  });

  it("每条译文都不夹中文", () => {
    for (const [key, value] of Object.entries(ENGLISH)) {
      expect(value, key).not.toMatch(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/);
    }
  });

  it("中英两份的占位一一对应", () => {
    for (const [key, value] of Object.entries(ENGLISH)) {
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });


  it("认得出支持的语言，其余的都不认", () => {
    expect(LOCALES).toEqual(["zh", "en"]);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh-cn")).toBe(false);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });

  it("插件名不随语言变", () => {
    setLocale("en");
    expect(t("{name}：{text}", { name: PLUGIN_NAME, text: t("注册完成") })).toBe(
      `${PLUGIN_NAME}: registration complete`,
    );
  });
});
