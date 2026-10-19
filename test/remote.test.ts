import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/core/git.js";
import {
  QUERY_DIRECTORY,
  REMOTE_QUERY_INTERVAL_MS,
  parseLsRemote,
  queryRemote,
  refName,
  remoteQueryDue,
  remoteSummary,
  resolveAddress,
  type RemoteQueryResult,
} from "../src/core/remote.js";

const HEAD_SHA = "a".repeat(40);
const REMOTE_SHA = "b".repeat(40);
const ADDRESS = "https://git.example.invalid/vault.git";

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

/** 去掉前置的取值参数，只留子命令本身，便于按命令给出答复。 */
function withoutConfigArgs(args: readonly string[]): string {
  let index = 0;
  while (args[index] === "-c") {
    index += 2;
  }
  return args.slice(index).join(" ");
}

/** 按整条命令行给出答复的执行方式；没写到的命令一律算意外。 */
function runnerFor(replies: Record<string, CommandResult>): CommandRunner {
  return (args) => {
    const command = withoutConfigArgs(args);
    return Promise.resolve(replies[command] ?? bad(`意外的命令：${command}`));
  };
}

/** 一份齐全的答复，只改需要改的那几项。 */
function replies(overrides: Record<string, CommandResult> = {}): Record<string, CommandResult> {
  return {
    "rev-parse --abbrev-ref HEAD": ok("main\n"),
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("origin/main\n"),
    "remote get-url origin": ok(`${ADDRESS}\n`),
    [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok(`${REMOTE_SHA}\trefs/heads/main\n`),
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
      runnerFor(
        replies({ [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok(`${HEAD_SHA}\trefs/heads/main\n`) }),
      ),
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
      runnerFor(replies({ [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok("") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "missing", remote: "origin", branch: "main" });
  });

  it("不在任何分支上时不去问远端", async () => {
    const seen: string[] = [];
    const result = await queryRemote(
      (args) => {
        seen.push(withoutConfigArgs(args));
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
    const table = replies({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": bad("fatal: no upstream"),
      "remote get-url mirror": ok(`${ADDRESS}\n`),
      [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok(`${HEAD_SHA}\trefs/heads/main\n`),
    });
    const runner: CommandRunner = (args) => {
      const command = withoutConfigArgs(args);
      seen.push(command);
      return Promise.resolve(table[command] ?? bad(`意外的命令：${command}`));
    };

    const result = await queryRemote(runner, "/vault", "mirror");

    expect(result).toEqual({ kind: "up-to-date", remote: "mirror", branch: "main" });
    expect(seen).toContain(`ls-remote --heads -- ${ADDRESS} refs/heads/main`);
  });

  it("上游落在别的分支上时沿用上游的分支名", async () => {
    const seen: string[] = [];
    const table = replies({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": ok("origin/trunk\n"),
      [`ls-remote --heads -- ${ADDRESS} refs/heads/trunk`]: ok(`${HEAD_SHA}\trefs/heads/trunk\n`),
    });
    const runner: CommandRunner = (args) => {
      const command = withoutConfigArgs(args);
      seen.push(command);
      return Promise.resolve(table[command] ?? bad(`意外的命令：${command}`));
    };

    const result = await queryRemote(runner, "/vault", "");

    expect(result).toEqual({ kind: "up-to-date", remote: "origin", branch: "trunk" });
    expect(seen).toContain(`ls-remote --heads -- ${ADDRESS} refs/heads/trunk`);
  });

  it("查询挪到仓库之外发起", async () => {
    const seen: { readonly command: string; readonly cwd: string }[] = [];
    const table = replies({
      [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok(`${HEAD_SHA}\trefs/heads/main\n`),
    });
    const runner: CommandRunner = (args, cwd) => {
      const command = withoutConfigArgs(args);
      seen.push({ command, cwd });
      return Promise.resolve(table[command] ?? bad(`意外的命令：${command}`));
    };

    await queryRemote(runner, "/vault", "");

    // 查询这一步不在仓库里跑：仓库配置里的取回程序、地址改写、凭证助手都写在仓库
    // 自己的文件里，留在仓库里发起查询就会被它们牵动。
    const listed = seen.find((call) => call.command.startsWith("ls-remote "));
    expect(listed?.cwd).toBe(QUERY_DIRECTORY);
    expect(listed?.cwd).not.toBe("/vault");
    for (const call of seen.filter((entry) => entry.command.startsWith("rev-parse "))) {
      expect(call.cwd).toBe("/vault");
    }
  });

  it("地址以短横线开头时不去问，直接跳过", async () => {
    // 仓库里把远端地址写成 `--upload-pack=…`，git 会把它当成选项而不是地址：
    // 那一句就会被当作取回程序执行，因此这种地址一律不送去查询。
    const seen: string[] = [];
    const table = replies({ "remote get-url origin": ok("--upload-pack=sh -c 'touch 别处' ://\n") });
    const runner: CommandRunner = (args) => {
      const command = withoutConfigArgs(args);
      seen.push(command);
      return Promise.resolve(table[command] ?? bad(`意外的命令：${command}`));
    };

    const result = await queryRemote(runner, "/vault", "");

    expect(result).toEqual({ kind: "failed", reason: "远端地址不合规，已跳过查询" });
    expect(seen.some((command) => command.startsWith("ls-remote "))).toBe(false);
  });

  it("读不出远端地址时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(replies({ "remote get-url origin": bad("fatal: 没有这个远端") })),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "failed", reason: "读不出远端 origin 的地址" });
  });

  it("远端名以短横线开头时不去问，直接说名字不合规", async () => {
    const result = await queryRemote(runnerFor(replies()), "/vault", "--upload-pack=evil");

    expect(result.kind).toBe("failed");
    expect(remoteSummary(result)).toContain("远端名不合规");
  });

  it("命令失败时把 stderr 的第一行收进提示", async () => {
    const result = await queryRemote(
      runnerFor(
        replies({ [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: bad("fatal: 连不上\n第二行") }),
      ),
      "/vault",
      "",
    );

    expect(result).toEqual({ kind: "failed", reason: "fatal: 连不上" });
  });

  it("远端给出的标识不像提交时如实说出", async () => {
    const result = await queryRemote(
      runnerFor(
        replies({ [`ls-remote --heads -- ${ADDRESS} refs/heads/main`]: ok("zzzz\trefs/heads/main\n") }),
      ),
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

describe("远端地址的整理", () => {
  it("相对路径按仓库根补成绝对路径", () => {
    expect(resolveAddress("../other.git", "/vault")).toBe("/other.git");
    expect(resolveAddress("sub/repo.git", "/vault")).toBe("/vault/sub/repo.git");
  });

  it("绝对路径、家目录写法、盘符、协议与 scp 写法原样保留", () => {
    expect(resolveAddress("/srv/git/vault.git", "/vault")).toBe("/srv/git/vault.git");
    expect(resolveAddress("~/git/vault.git", "/vault")).toBe("~/git/vault.git");
    expect(resolveAddress("D:/git/vault.git", "/vault")).toBe("D:/git/vault.git");
    expect(resolveAddress("https://git.example.invalid/vault.git", "/vault")).toBe(
      "https://git.example.invalid/vault.git",
    );
    expect(resolveAddress("git@git.example.invalid:vault.git", "/vault")).toBe(
      "git@git.example.invalid:vault.git",
    );
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
