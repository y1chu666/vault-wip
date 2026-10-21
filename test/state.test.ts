import { describe, expect, it } from "vitest";

import type { StatusPayload } from "../src/core/payload.js";
import {
  activePeers,
  displayName,
  findConflicts,
  mergePeers,
  nextSequence,
  payloadDigest,
  peersWithChanges,
  type DeviceStatus,
} from "../src/core/state.js";

/** 构造一份记录内容，只写出用例关心的部分。 */
function payload(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    label: "",
    count: 0,
    truncated: false,
    paths: [],
    kinds: [],
    suspectFiles: [],
    conflictFiles: [],
    ...overrides,
  };
}

/** 构造一台设备的状态。 */
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

describe("nextSequence", () => {
  it("每次上报加一", () => {
    expect(nextSequence(0)).toBe(1);
    expect(nextSequence(41)).toBe(42);
  });
});

describe("mergePeers", () => {
  it("采纳新的设备", () => {
    const result = mergePeers([], [device("aa", { sequence: 3 })]);

    expect(result.peers).toHaveLength(1);
    expect(result.accepted).toEqual(["aa"]);
    expect(result.anomalies).toEqual([]);
  });

  it("采纳序号更大的记录", () => {
    const known = [device("aa", { sequence: 3, label: "旧" })];
    const result = mergePeers(known, [device("aa", { sequence: 4, label: "新" })]);

    expect(result.peers[0]?.sequence).toBe(4);
    expect(result.peers[0]?.label).toBe("新");
    expect(result.accepted).toEqual(["aa"]);
  });

  it("忽略序号更小的记录并记为异常", () => {
    const known = [device("aa", { sequence: 5 })];
    const result = mergePeers(known, [device("aa", { sequence: 4 })]);

    expect(result.peers[0]?.sequence).toBe(5);
    expect(result.accepted).toEqual([]);
    expect(result.anomalies).toEqual([
      { fingerprint: "aa", kind: "stale", knownSequence: 5, incomingSequence: 4 },
    ]);
  });

  it("同序号同内容时静默忽略", () => {
    const known = [device("aa", { sequence: 5, payload: payload({ count: 2, paths: ["a.md"] }) })];
    const result = mergePeers(known, [
      device("aa", { sequence: 5, payload: payload({ count: 2, paths: ["a.md"] }) }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it("同序号不同内容时保留既有记录并记为异常", () => {
    const known = [device("aa", { sequence: 5, payload: payload({ count: 2, paths: ["a.md"] }) })];
    const result = mergePeers(known, [device("aa", { sequence: 5, payload: payload({ count: 9, paths: ["b.md"] }) })]);

    expect(result.peers[0]?.payload.count).toBe(2);
    expect(result.anomalies).toEqual([
      { fingerprint: "aa", kind: "mismatch", knownSequence: 5, incomingSequence: 5 },
    ]);
  });

  it("按指纹排序，便于界面稳定显示", () => {
    const result = mergePeers([], [device("cc"), device("aa"), device("bb")]);

    expect(result.peers.map((peer) => peer.fingerprint)).toEqual(["aa", "bb", "cc"]);
  });
});

describe("payloadDigest", () => {
  it("清单顺序不同但内容相同则摘要一致", () => {
    const left = payload({ paths: ["a.md", "b.md"], suspectFiles: ["b.md"], conflictFiles: ["c.md"] });
    const right = payload({ paths: ["b.md", "a.md"], suspectFiles: ["b.md"], conflictFiles: ["c.md"] });

    expect(payloadDigest(left)).toBe(payloadDigest(right));
  });

  it("内容不同则摘要不同", () => {
    expect(payloadDigest(payload({ count: 1 }))).not.toBe(payloadDigest(payload({ count: 2 })));
  });
});

describe("activePeers", () => {
  it("剔除被吊销的设备", () => {
    const peers = [device("aa"), device("bb")];

    expect(activePeers(peers, ["aa"]).map((peer) => peer.fingerprint)).toEqual(["bb"]);
    expect(activePeers(peers, [])).toHaveLength(2);
  });
});

describe("findConflicts", () => {
  it("没有本地记录时不判断", () => {
    expect(findConflicts(null, [device("aa", { payload: payload({ count: 1, paths: ["a.md"] }) })])).toEqual([]);
  });

  it("只报两端都改过的文件", () => {
    const local = payload({ count: 2, paths: ["notes/a.md", "notes/b.md"] });
    const peers = [
      device("aa", { label: "书房台式机", payload: payload({ count: 1, paths: ["notes/b.md"] }) }),
      device("bb", { payload: payload({ count: 1, paths: ["notes/c.md"] }) }),
    ];

    const conflicts = findConflicts(local, peers);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.path).toBe("notes/b.md");
    expect(conflicts[0]?.peers).toEqual([{ fingerprint: "aa", name: "书房台式机" }]);
    expect(conflicts[0]?.localSuspect).toBe(false);
    expect(conflicts[0]?.peerSuspect).toBe(false);
  });

  it("多台对端改到同一文件时都列出来", () => {
    const local = payload({ count: 1, paths: ["notes/a.md"] });
    const peers = [
      device("bb", { label: "客厅笔记本", payload: payload({ count: 1, paths: ["notes/a.md"] }) }),
      device("aa", { label: "书房台式机", payload: payload({ count: 1, paths: ["notes/a.md"] }) }),
    ];

    const conflicts = findConflicts(local, peers);

    expect(conflicts[0]?.peers).toEqual([
      { fingerprint: "aa", name: "书房台式机" },
      { fingerprint: "bb", name: "客厅笔记本" },
    ]);
  });

  it("标注疑似假冲突，但不把它排除在外", () => {
    const local = payload({ count: 1, paths: ["notes/a.md"], suspectFiles: ["notes/a.md"] });
    const peers = [device("aa", { payload: payload({ count: 1, paths: ["notes/a.md"] }) })];

    const conflicts = findConflicts(local, peers);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.localSuspect).toBe(true);
    expect(conflicts[0]?.peerSuspect).toBe(false);
  });

  it("对端为疑似假冲突时也标注", () => {
    const local = payload({ count: 1, paths: ["notes/a.md"] });
    const peers = [
      device("aa", { payload: payload({ count: 1, paths: ["notes/a.md"], suspectFiles: ["notes/a.md"] }) }),
    ];

    expect(findConflicts(local, peers)[0]?.peerSuspect).toBe(true);
  });

  it("按路径排序", () => {
    const local = payload({ count: 2, paths: ["b.md", "a.md"] });
    const peers = [device("aa", { payload: payload({ count: 2, paths: ["b.md", "a.md"] }) })];

    expect(findConflicts(local, peers).map((conflict) => conflict.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("peersWithChanges", () => {
  it("只留有改动或有冲突残留的对端", () => {
    const peers = [
      device("aa", { payload: payload({ count: 0 }) }),
      device("bb", { payload: payload({ count: 3 }) }),
    ];

    expect(peersWithChanges(peers).map((peer) => peer.fingerprint)).toEqual(["bb"]);
  });
});

describe("displayName", () => {
  it("有名称时用名称，没有时用指纹前几位", () => {
    expect(displayName(device("aa", { label: "书房台式机" }))).toBe("书房台式机");
    expect(displayName(device("56475aa75463474c"))).toBe("设备 56475aa7");
  });
});
