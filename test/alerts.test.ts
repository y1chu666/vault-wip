import { describe, expect, it } from "vitest";

import {
  Alerts,
  conflictNotice,
  failureNotice,
  formatDuration,
  recoveredNotice,
  startupNotice,
  type AlertInput,
  type FailureState,
} from "../src/core/alerts.js";
import type { StatusPayload } from "../src/core/payload.js";
import type { Conflict, DeviceStatus } from "../src/core/state.js";

function payload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return { count: 0, truncated: false, paths: [], suspectFiles: [], conflictFiles: [], ...overrides };
}

function device(fingerprint: string, overrides: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    fingerprint,
    label: "",
    sequence: 1,
    collectedAt: "2023-11-14T22:15:23Z",
    payload: payload(),
    ...overrides,
  };
}

/** 一次判断的输入，未写的部分取「一切正常」。 */
function input(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    now: 1_700_000_000_000,
    focused: true,
    conflicts: [],
    peersWithChanges: [],
    relayName: "自家服务器",
    failure: null,
    ...overrides,
  };
}

const conflict: Conflict = {
  path: "notes/a.md",
  peers: [{ fingerprint: "aa", name: "书房台式机" }],
  localSuspect: false,
  peerSuspect: false,
};

describe("Alerts 的冲突提示", () => {
  it("新的冲突立刻提示，同一文件不重复提示", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    expect(alerts.evaluate(input({ conflicts: [conflict] }))).toHaveLength(1);
    expect(alerts.evaluate(input({ conflicts: [conflict] }))).toEqual([]);
  });

  it("冲突消失后再次出现，可以再提示一次", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    alerts.evaluate(input({ conflicts: [conflict] }));
    alerts.evaluate(input({ conflicts: [] }));

    expect(alerts.evaluate(input({ conflicts: [conflict] }))).toHaveLength(1);
  });

  it("窗口不在前台时不提示，也不记账", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    expect(alerts.evaluate(input({ focused: false, conflicts: [conflict] }))).toEqual([]);
    expect(alerts.evaluate(input({ conflicts: [conflict] }))).toHaveLength(1);
  });
});

describe("Alerts 的启动提示", () => {
  it("对端有改动时提示一次", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });
    const peers = [device("aa", { label: "书房台式机", payload: payload({ count: 3 }) })];

    const first = alerts.evaluate(input({ peersWithChanges: peers }));

    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("peerChanges");
    expect(alerts.evaluate(input({ peersWithChanges: peers }))).toEqual([]);
  });

  it("对端没有改动时什么都不提示", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    expect(alerts.evaluate(input())).toEqual([]);
  });

  it("窗口不在前台时留到聚焦后再提示", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });
    const peers = [device("aa", { payload: payload({ count: 1 }) })];

    expect(alerts.evaluate(input({ focused: false, peersWithChanges: peers }))).toEqual([]);
    expect(alerts.evaluate(input({ peersWithChanges: peers }))).toHaveLength(1);
  });
});

describe("Alerts 的故障提示", () => {
  const failure: FailureState = { since: 1_699_999_400_000, message: "连接被拒绝" };

  it("故障开始即提示，未到间隔不重复", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    expect(alerts.evaluate(input({ failure }))).toHaveLength(1);
    expect(alerts.evaluate(input({ failure, now: 1_700_000_000_000 + 599_000 }))).toEqual([]);
    expect(alerts.evaluate(input({ failure, now: 1_700_000_000_000 + 600_000 }))).toHaveLength(1);
  });

  it("关闭重提醒后只提示一次", () => {
    const alerts = new Alerts({ repeatSeconds: 0 });

    expect(alerts.evaluate(input({ failure }))).toHaveLength(1);
    expect(alerts.evaluate(input({ failure, now: 1_700_000_000_000 + 86_400_000 }))).toEqual([]);
  });

  it("恢复时提示一次，并重置重提醒", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    alerts.evaluate(input({ failure }));
    const recovered = alerts.evaluate(input({ failure: null }));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.kind).toBe("recovered");
    expect(alerts.evaluate(input({ failure: null }))).toEqual([]);

    expect(alerts.evaluate(input({ failure }))).toHaveLength(1);
  });

  it("恢复时窗口不在前台，则留到聚焦后再提示", () => {
    const alerts = new Alerts({ repeatSeconds: 600 });

    alerts.evaluate(input({ failure }));
    expect(alerts.evaluate(input({ focused: false, failure: null }))).toEqual([]);
    expect(alerts.evaluate(input({ failure: null }))[0]?.kind).toBe("recovered");
  });
});

describe("提示的文字", () => {
  it("单个冲突说明涉及哪些设备", () => {
    const notice = conflictNotice(conflict, 1);

    expect(notice.title).toBe("可能冲突的改动");
    expect(notice.body).toContain("「notes/a.md」");
    expect(notice.body).toContain("书房台式机");
    expect(notice.body).not.toContain("等");
  });

  it("多个冲突时说明总数", () => {
    expect(conflictNotice(conflict, 3).body).toContain("「notes/a.md」等 3 个文件");
  });

  it("本地疑似假冲突时说明无需过于担心", () => {
    expect(conflictNotice({ ...conflict, localSuspect: true }, 1).body).toContain("本地这边的差异");
  });

  it("对端疑似假冲突时如实说明", () => {
    expect(conflictNotice({ ...conflict, peerSuspect: true }, 1).body).toContain("对端那边的差异");
  });

  it("启动提示列出各端的改动数量", () => {
    const notice = startupNotice([
      device("aa", { label: "书房台式机", payload: payload({ count: 3 }) }),
      device("bb", { payload: payload({ count: 1 }) }),
    ]);

    expect(notice.body).toContain("书房台式机有 3 处未提交改动");
    expect(notice.body).toContain("设备 bb有 1 处未提交改动");
  });

  it("故障提示带上持续时间与原因", () => {
    const notice = failureNotice("自家服务器", { since: 1_699_999_400_000, message: "连接被拒绝" }, 1_700_000_000_000);

    expect(notice.body).toContain("已持续 10 分钟");
    expect(notice.body).toContain("自家服务器");
    expect(notice.body).toContain("连接被拒绝");
  });

  it("恢复提示说明恢复的是哪台中继", () => {
    expect(recoveredNotice("自家服务器").body).toContain("自家服务器");
  });
});

describe("formatDuration", () => {
  it("按中文习惯给时长", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(59)).toBe("59 秒");
    expect(formatDuration(60)).toBe("1 分钟");
    expect(formatDuration(3599)).toBe("59 分钟");
    expect(formatDuration(3600)).toBe("1 小时");
    expect(formatDuration(3900)).toBe("1 小时 5 分钟");
    expect(formatDuration(86_400)).toBe("24 小时");
  });
});
