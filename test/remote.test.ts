import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/core/git.js";
import {
  REMOTE_QUERY_INTERVAL_MS,
  parseLsRemote,
  queryRemote,
  refName,
  remoteQueryDue,
  remoteSummary,
  type RemoteQueryResult,
} from "../src/core/remote.js";

const HEAD_SHA = "a".repeat(40);
const REMOTE_SHA = "b".repeat(40);

/** 一段输出的字节形式。 */
function out(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 一次成功的答复。 */
function ok(text = ""): CommandResult {
  return { code: 0, stdout: out(text), stderr: "" };
}

/** 一次失败的答复。 */
function bad(stderr: string, code = 128): CommandResult {
  return { code, stdout: out(""), stderr };
}

/** 按整条命令行给出答复的执行方式；没写到的命令一律算意外。 */
function runnerFor(replies: Record<string, CommandResult>): CommandRunner {
  return (args) => {
    const reply = replies[args.join(" ")];
    return Promise.resolve(reply ?? bad(`意外的命令：${args.join(" ")}`));
  };
}

/** 一份齐全的答复，只改需要改的那几项。 */
function replies(overrides: Record<string, CommandResult> = {}): Record<string, CommandResult> {
  return {
    "rev-parse --abbrev-ref HEAD": ok("main\n"),
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("origin/main\n"),
    "ls-remote --heads origin refs/heads/main": ok(`${REMOTE_SHA}\trefs/heads/main\n`),
    "rev-parse HEAD": ok(`${HEAD_SHA}\n`),
    [`cat-file -e ${REMOTE_SHA}^{commit}`]: ok(),
    [`rev-list --count ${REMOTE_SHA}..HEAD`]: ok("0\n"),
    [`rev-list --count HEAD..${REMOTE_SHA}`]: ok("0\n"),
    ...overrides,
  };
}

describe("远端查询", () => {
  it("两边指同一笔提交时认为一致", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "ls-remote --heads origin refs/heads/main": ok(`${HEAD_SHA}\trefs/heads/main\n`) })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "up-to-date", remote: "origin", branch: "main" });
  });

  it("本机多出来的提交算作尚未推上去", async () => {
    const result = await queryRemote(
      runnerFor(replies({ [`rev-list --count ${REMOTE_SHA}..HEAD`]: ok("3\n") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "ahead", remote: "origin", branch: "main", ahead: 3 });
  });

  it("远端多出来的提交算作本机还没有", async () => {
    const result = await queryRemote(
      runnerFor(replies({ [`rev-list --count HEAD..${REMOTE_SHA}`]: ok("2\n") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "behind", remote: "origin", branch: "main", behind: 2 });
  });

  it("两边各有多出来的提交算作分开", async () => {
    const result = await queryRemote(
      runnerFor(
        replies({
          [`rev-list --count ${REMOTE_SHA}..HEAD`]: ok("1\n"),
          [`rev-list --count HEAD..${REMOTE_SHA}`]: ok("4\n"),
        }),
      ),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "diverged", remote: "origin", branch: "main", ahead: 1, behind: 4 });
  });

  it("远端那笔提交本机不认识时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(replies({ [`cat-file -e ${REMOTE_SHA}^{commit}`]: bad("", 1) })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "unfetched", remote: "origin", branch: "main" });
  });

  it("远端没有这条分支时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "ls-remote --heads origin refs/heads/main": ok("") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "missing", remote: "origin", branch: "main" });
  });

  it("不在任何分支上时不去问远端", async () => {
    const seen: string[] = [];
    const result = await queryRemote(
      (args) => {
        seen.push(args.join(" "));
        return Promise.resolve(ok("HEAD\n"));
      },
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "no-branch" });
    expect(seen).toEqual(["rev-parse --abbrev-ref HEAD"]);
  });

  it("没有上游而又没指定远端时说清该填哪一项", async () => {
    const result = await queryRemote(
      runnerFor(
        replies({ "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": bad("fatal: no upstream") }),
      ),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "no-upstream" });
  });

  it("指定了远端就按它查，分支名沿用本地分支", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = (args) => {
      seen.push(args.join(" "));
      const reply = replies({
        "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": bad("fatal: no upstream"),
        "ls-remote --heads mirror refs/heads/main": ok(`${HEAD_SHA}\trefs/heads/main\n`),
      })[args.join(" ")];
      return Promise.resolve(reply ?? bad(`意外的命令：${args.join(" ")}`));
    };

    const result = await queryRemote(runner, "/vault", "mirror");

    expect(result).toEqual({ kind: "up-to-date", remote: "mirror", branch: "main" });
    expect(seen).toContain("ls-remote --heads mirror refs/heads/main");
  });

  it("上游落在别的分支上时沿用上游的分支名", async () => {
    const seen: string[] = [];
    const runner: CommandRunner = (args) => {
      seen.push(args.join(" "));
      const reply = replies({
        "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("origin/trunk\n"),
        "ls-remote --heads origin refs/heads/trunk": ok(`${HEAD_SHA}\trefs/heads/trunk\n`),
      })[args.join(" ")];
      return Promise.resolve(reply ?? bad(`意外的命令：${args.join(" ")}`));
    };

    const result = await queryRemote(runner, "/vault", "");

    expect(result).toEqual({ kind: "up-to-date", remote: "origin", branch: "trunk" });
    expect(seen).toContain("ls-remote --heads origin refs/heads/trunk");
  });

  it("远端名以短横线开头时不去问，直接说名字不合规", async () => {
    const result = await queryRemote(runnerFor(replies()), "/vault", "--upload-pack=evil");

    expect(result.kind).toBe("failed");
    expect(remoteSummary(result)).toContain("远端名不合规");
  });

  it("命令失败时把 stderr 的第一行收进提示", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "ls-remote --heads origin refs/heads/main": bad("fatal: 连不上\n第二行") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "failed", reason: "fatal: 连不上" });
  });

  it("远端给出的标识不像提交时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "ls-remote --heads origin refs/heads/main": ok("zzzz\trefs/heads/main\n") })),
      "/vault",
      "",
    );

    expect(result.kind).toBe("failed");
  });

  it("读不出本机提交时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "rev-parse HEAD": bad("fatal: 没有提交\n第二行") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "failed", reason: "fatal: 没有提交" });
  });

  it("上游写得不含远端名时当作没有上游", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("main\n") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "no-upstream" });
  });

  it("标识不同而两边都不多时按一致处理", async () => {
    const result = await queryRemote(runnerFor(replies()), "/vault", "");

    expect(result).toEqual({ kind: "up-to-date", remote: "origin", branch: "main" });
  });

  it("数不出相距多远时说清无法比较", async () => {
    const result = await queryRemote(
      runnerFor(replies({ [`rev-list --count ${REMOTE_SHA}..HEAD`]: bad("fatal: bad revision", 128) })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "failed", reason: "无法比较本地与远端" });
  });
});

describe("远端查询的显示", () => {
  it("从 ls-remote 的输出里取出第一条分支记录", () => {
    expect(parseLsRemote(`${REMOTE_SHA}\trefs/tags/v1\n${HEAD_SHA}\trefs/heads/main\n`)).toEqual({
      sha: HEAD_SHA,
      ref: "refs/heads/main",
    });
    expect(parseLsRemote("")).toBeNull();
  });

  it("每种结果都有一句说明", () => {
    const cases: readonly RemoteQueryResult[] = [
      { kind: "up-to-date", remote: "origin", branch: "main" },
      { kind: "ahead", remote: "origin", branch: "main", ahead: 2 },
      { kind: "behind", remote: "origin", branch: "main", behind: 3 },
      { kind: "diverged", remote: "origin", branch: "main", ahead: 1, behind: 2 },
      { kind: "unfetched", remote: "origin", branch: "main" },
      { kind: "missing", remote: "origin", branch: "main" },
      { kind: "no-branch" },
      { kind: "no-upstream" },
      { kind: "failed", reason: "连不上" },
    ];

    expect(remoteSummary(null)).toBe("尚未查询");
    for (const result of cases) {
      const text = remoteSummary(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("{");
    }
    expect(remoteSummary(cases[1] ?? null)).toBe("本机有 2 个提交尚未推上去");
    expect(remoteSummary(cases[3] ?? null)).toBe(
      "本地与远端已经分开：远端有 2 个本机没有，本机有 1 个尚未推上去",
    );
  });

  it("只有问到远端的结果才写得出远端与分支", () => {
    expect(refName({ remote: "origin", branch: "main" })).toBe("origin/main");
  });

  it("两次自动查询之间隔得够久才再问一次", () => {
    expect(remoteQueryDue(null, 1_000)).toBe(true);
    expect(remoteQueryDue(1_000, 1_000 + REMOTE_QUERY_INTERVAL_MS - 1)).toBe(false);
    expect(remoteQueryDue(1_000, 1_000 + REMOTE_QUERY_INTERVAL_MS)).toBe(true);
  });
});
