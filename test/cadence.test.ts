import { describe, expect, it } from "vitest";

import { Cadence, DEBOUNCE_MS } from "../src/core/cadence.js";

const settings = { intervalSeconds: 15, idleAfterSeconds: 300, idleIntervalSeconds: 60 };

/** 可控的时钟。 */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("Cadence 的立即上报", () => {
  it("启动时一定上报", () => {
    const cadence = new Cadence(settings, makeClock().now);

    expect(cadence.shouldReportNow("startup")).toBe(true);
  });

  it("防抖窗口内合并连续触发", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    expect(cadence.shouldReportNow("save")).toBe(true);
    expect(cadence.shouldReportNow("save")).toBe(false);
    expect(cadence.shouldReportNow("fileSwitch")).toBe(false);

    clock.advance(DEBOUNCE_MS);
    expect(cadence.shouldReportNow("fileSwitch")).toBe(true);
  });

  it("窗口重新聚焦也在防抖之列", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    cadence.shouldReportNow("save");
    clock.advance(1000);

    expect(cadence.shouldReportNow("focus")).toBe(false);
  });
});

describe("Cadence 的定时节奏", () => {
  it("聚焦时用常规间隔", () => {
    const cadence = new Cadence(settings, makeClock().now);

    expect(cadence.isIdle()).toBe(false);
    expect(cadence.timerSeconds()).toBe(15);
  });

  it("失焦未久时仍是常规间隔", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    cadence.setFocused(false);
    clock.advance(299_000);

    expect(cadence.isIdle()).toBe(false);
    expect(cadence.timerSeconds()).toBe(15);
  });

  it("失焦够久之后放慢", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    cadence.setFocused(false);
    clock.advance(300_000);

    expect(cadence.isIdle()).toBe(true);
    expect(cadence.timerSeconds()).toBe(60);
  });

  it("反复收到失焦通知不会推迟放慢", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    cadence.setFocused(false);
    clock.advance(290_000);
    cadence.setFocused(false);
    clock.advance(11_000);

    expect(cadence.isIdle()).toBe(true);
  });

  it("重新聚焦后回到常规间隔", () => {
    const clock = makeClock();
    const cadence = new Cadence(settings, clock.now);

    cadence.setFocused(false);
    clock.advance(600_000);
    cadence.setFocused(true);

    expect(cadence.isIdle()).toBe(false);
    expect(cadence.timerSeconds()).toBe(15);
  });

  it("配置为不放慢时始终用常规间隔", () => {
    const clock = makeClock();
    const cadence = new Cadence({ ...settings, idleAfterSeconds: 0 }, clock.now);

    cadence.setFocused(false);
    clock.advance(3_600_000);

    expect(cadence.timerSeconds()).toBe(15);
  });
});
