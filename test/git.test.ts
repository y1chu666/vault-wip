import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CollectError,
  collectStatus,
  createCommandRunner,
  gitVersion,
  normalizePath,
  parseRawDiff,
  parseStatusOutput,
  type CommandResult,
  type CommandRunner,
} from "../src/core/git.js";

/** 用 NUL 分隔的记录拼出一段输出，与 git 在 -z 下的写法一致。 */
function nulJoin(fields: readonly string[]): Uint8Array {
  return Buffer.from(`${fields.join("\u0000")}\u0000`, "utf8");
}

function result(stdout: Uint8Array, code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

const statusFixture = nulJoin([
  "# branch.oid f399e830dd10000958f87566b184f403ea168670",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
  "1 .D N... 100644 100644 000000 286c5f5776916d7d7d5849988ca9d83e722cf9c2 286c5f5776916d7d7d5849988ca9d83e722cf9c2 notes/del.md",
  "1 .M N... 100644 100644 100644 fbbee861521bd5355538b096fa3998541cd33909 fbbee861521bd5355538b096fa3998541cd33909 notes/eol.md",
  "1 .M N... 100644 100644 100755 af17f6cc87e4d5e4adec0018cbb73d3e2bd008c8 af17f6cc87e4d5e4adec0018cbb73d3e2bd008c8 notes/mode.md",
  "1 .M N... 100644 100644 100644 17e3475343c4c9b504473a7f0dc1d124cde7fa2a 17e3475343c4c9b504473a7f0dc1d124cde7fa2a notes/real.md",
  "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 6dc6f50f882402a0fda1e0ca2bbf1a1cd8a0c1e7 notes/added.md",
  "2 R. N... 100644 100644 100644 5a0ed06b24bcbc1e5f46457f37f97ef7a1ff922f 5a0ed06b24bcbc1e5f46457f37f97ef7a1ff922f R100 notes/renamed.md",
  "notes/old.md",
  "? notes/new.md",
  "? notes/带空格 的名字.md",
]);

const bareStatusFixture = nulJoin([
  "# branch.oid f399e830dd10000958f87566b184f403ea168670",
  "# branch.head (detached)",
  "1 .M N... 100644 100644 100644 17e3475343c4c9b504473a7f0dc1d124cde7fa2a 17e3475343c4c9b504473a7f0dc1d124cde7fa2a notes/real.md",
]);

const unmergedStatusFixture = nulJoin([
  "# branch.oid f399e830dd10000958f87566b184f403ea168670",
  "# branch.head main",
  "u UU N... 100644 100644 100644 100644 9f2c1d2b4c5e6f708192a3b4c5d6e7f8091a2b3c 3a1b2c3d4e5f60718293a4b5c6d7e8f901122334 5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f11223344 notes/merged.md",
]);

const unstagedDiffFixture = nulJoin([
  ":100644 000000 286c5f5 0000000 D",
  "notes/del.md",
  ":100644 100755 af17f6c af17f6c M",
  "notes/mode.md",
  ":100644 100644 17e3475 06a4e62 M",
  "notes/real.md",
]);

const stagedDiffFixture = nulJoin([
  ":100644 100644 5a0ed06 5a0ed06 R100",
  "notes/old.md",
  "notes/renamed.md",
]);

describe("parseStatusOutput", () => {
  it("读出分支、领先落后与各条改动", () => {
    const parsed = parseStatusOutput(statusFixture);

    expect(parsed.branch).toBe("main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      "notes/del.md",
      "notes/eol.md",
      "notes/mode.md",
      "notes/real.md",
      "notes/added.md",
      "notes/renamed.md",
      "notes/new.md",
      "notes/带空格 的名字.md",
    ]);
    expect(parsed.entries.map((entry) => entry.xy)).toEqual([".D", ".M", ".M", ".M", "A.", "R.", "??", "??"]);
  });

  it("分离头指针时不给出分支名", () => {
    const parsed = parseStatusOutput(bareStatusFixture);

    expect(parsed.branch).toBe("");
    expect(parsed.ahead).toBe(0);
    expect(parsed.behind).toBe(0);
  });

  it("保留含空格的路径", () => {
    const parsed = parseStatusOutput(statusFixture);

    expect(parsed.entries.at(-1)?.path).toBe("notes/带空格 的名字.md");
  });

  it("忽略空字段与未知记录", () => {
    const parsed = parseStatusOutput(nulJoin(["", "# branch.head main", "x 未知记录", "# 只有一段", "1 .M N... 100644"]));

    expect(parsed.branch).toBe("main");
    expect(parsed.entries).toEqual([]);
  });

  it("计数写法不合规时按零计", () => {
    const parsed = parseStatusOutput(nulJoin(["# branch.head main", "# branch.ab +abc -"]));

    expect(parsed.ahead).toBe(0);
    expect(parsed.behind).toBe(0);
  });

  it("把双方都新增的冲突也归入未合并", () => {
    const parsed = parseStatusOutput(
      nulJoin([
        "# branch.head main",
        "u AA N... 100644 100644 100644 100644 9f2c1d2b4c5e6f708192a3b4c5d6e7f8091a2b3c 3a1b2c3d4e5f60718293a4b5c6d7e8f901122334 5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f11223344 notes/both.md",
      ]),
    );

    expect(parsed.entries[0]?.xy).toBe("AA");
  });
});

describe("parseRawDiff", () => {
  it("读出一条记录的模式、摘要与状态", () => {
    const entries = parseRawDiff(unstagedDiffFixture);

    expect(entries).toEqual([
      {
        srcMode: "100644",
        dstMode: "000000",
        srcHash: "286c5f5",
        dstHash: "0000000",
        status: "D",
        path: "notes/del.md",
      },
      {
        srcMode: "100644",
        dstMode: "100755",
        srcHash: "af17f6c",
        dstHash: "af17f6c",
        status: "M",
        path: "notes/mode.md",
      },
      {
        srcMode: "100644",
        dstMode: "100644",
        srcHash: "17e3475",
        dstHash: "06a4e62",
        status: "M",
        path: "notes/real.md",
      },
    ]);
  });

  it("重命名记录只用改名后的路径，并跳过改名前的路径", () => {
    const entries = parseRawDiff(stagedDiffFixture);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("R100");
    expect(entries[0]?.path).toBe("notes/renamed.md");
  });

  it("复制记录同样取改动后的路径", () => {
    const entries = parseRawDiff(
      nulJoin([":100644 100644 5a0ed06 5a0ed06 C75", "notes/source.md", "notes/copy.md"]),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("notes/copy.md");
  });

  it("忽略不成形的记录", () => {
    expect(parseRawDiff(nulJoin(["没有前缀", ":不完整"]))).toEqual([]);
    // 重命名记录少了后一个路径时不能把改名前的路径当成现名。
    expect(parseRawDiff(nulJoin([":100644 100644 5a0ed06 5a0ed06 R100", "notes/source.md"]))).toEqual([]);
  });
});

describe("normalizePath", () => {
  it("统一为小写、斜杠与 Unicode 归一形式", () => {
    expect(normalizePath("Notes/README.md")).toBe("notes/readme.md");
    expect(normalizePath(".\\notes\\A.md")).toBe("notes/a.md");
    expect(normalizePath("./notes/a.md")).toBe("notes/a.md");
    // 同一个字符的组合写法与预组合写法归一后应当一致。
    expect(normalizePath("notes/e\u0301.md")).toBe(normalizePath("notes/\u00e9.md"));
  });
});

describe("collectStatus", () => {
  /** 去掉前置的取值参数，只留子命令本身，便于按命令给出输出。 */
  function withoutConfigArgs(args: readonly string[]): string {
    let index = 0;
    while (args[index] === "-c") {
      index += 2;
    }
    return args.slice(index).join(" ");
  }

  /**
   * 从一次执行带回的环境变量里，取出被压掉的配置项。
   *
   * 压过滤器不走 `-c`（键里可能含等号，会被拆错），而是走 `GIT_CONFIG_*` 这一组。
   */
  function overridePairs(env: Readonly<Record<string, string>> | undefined): Map<string, string> {
    const pairs = new Map<string, string>();
    for (let index = 0; index < Number(env?.["GIT_CONFIG_COUNT"] ?? 0); index += 1) {
      pairs.set(env?.[`GIT_CONFIG_KEY_${index}`] ?? "", env?.[`GIT_CONFIG_VALUE_${index}`] ?? "");
    }
    return pairs;
  }

  /** 按调用参数返回预先准备的输出。 */
  function stubRunner(overrides: Record<string, CommandResult> = {}): CommandRunner {
    const defaults: Record<string, CommandResult> = {
      // 仓库里没有定义过滤器时，这两条命令以非零退出。
      "config --local --includes --name-only --get-regexp ^filter\\.": result(Buffer.alloc(0), 1),
      "config --worktree --includes --name-only --get-regexp ^filter\\.": result(Buffer.alloc(0), 1),
      "status --porcelain=v2 -z --branch": result(statusFixture),
      "diff --raw -z --ignore-cr-at-eol --no-ext-diff": result(unstagedDiffFixture),
      "diff --raw -z --ignore-cr-at-eol --no-ext-diff --cached": result(stagedDiffFixture),
    };
    const table = { ...defaults, ...overrides };

    return (args) => Promise.resolve(table[withoutConfigArgs(args)] ?? result(Buffer.alloc(0)));
  }

  it("给出归一后的改动清单与假冲突清单", async () => {
    const collected = await collectStatus(stubRunner(), "/repo");

    expect(collected.branch).toBe("main");
    expect(collected.changes.map((change) => change.path)).toEqual([
      "notes/del.md",
      "notes/eol.md",
      "notes/mode.md",
      "notes/real.md",
      "notes/added.md",
      "notes/renamed.md",
      "notes/new.md",
      "notes/带空格 的名字.md",
    ]);
    expect(collected.changes.map((change) => change.kind)).toEqual([
      "deleted",
      "modified",
      "modified",
      "modified",
      "added",
      "renamed",
      "untracked",
      "untracked",
    ]);
    expect(collected.changes[7]?.display).toBe("notes/带空格 的名字.md");
    // 行尾差异与权限差异都只影响措辞，因此单独列出来。
    expect(collected.suspectFiles).toEqual(["notes/eol.md", "notes/mode.md"]);
    expect(collected.conflicted).toEqual([]);
  });

  it("没有改动时不再多跑两次差异命令", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = (args) => {
      calls.push(withoutConfigArgs(args));
      const command = withoutConfigArgs(args);
      if (command.startsWith("config ")) {
        return Promise.resolve(result(Buffer.alloc(0), 1));
      }
      if (command.startsWith("status ")) {
        return Promise.resolve(result(nulJoin(["# branch.head main"])));
      }
      return Promise.reject(new Error(`不该调用：${args.join(" ")}`));
    };

    const collected = await collectStatus(runner, "/repo");

    expect(collected.changes).toEqual([]);
    // 仓库自己的配置问两处（本体含 include、工作区配置），随后只跑一次状态命令。
    expect(calls).toEqual([
      "config --local --includes --name-only --get-regexp ^filter\\.",
      "config --worktree --includes --name-only --get-regexp ^filter\\.",
      "status --porcelain=v2 -z --branch",
    ]);
  });

  it("仓库定义的过滤器逐个压掉", async () => {
    // 属性文件随仓库流转，驱动名由仓库自定，因此这里不能靠列举固定名字：
    // 先把仓库里定义过的驱动取出来，随后每条命令都把它们清空。
    const envs: Readonly<Record<string, string>>[] = [];
    const runner: CommandRunner = (args, _cwd, env) => {
      const command = withoutConfigArgs(args);
      if (command.startsWith("config ")) {
        return Promise.resolve(
          result(Buffer.from("filter.evil.clean\nfilter.evil.x.process\nfilter.evil.required\n", "utf8")),
        );
      }
      envs.push(env ?? {});
      // 有改动时才会多跑两次差异命令，这里给一份带改动的状态，好把每条命令都看到。
      return Promise.resolve(
        command.startsWith("status ") ? result(statusFixture) : result(Buffer.alloc(0)),
      );
    };

    const collected = await collectStatus(runner, "/repo");

    expect(collected.branch).toBe("main");
    const pairs = overridePairs(envs[0]);
    expect(pairs.get("filter.evil.clean")).toBe("");
    expect(pairs.get("filter.evil.process")).toBe("");
    expect(pairs.get("filter.evil.smudge")).toBe("");
    expect(pairs.get("filter.evil.required")).toBe("false");
    // 驱动名里的点属于驱动名的一部分，不能当成层级分隔。
    expect(pairs.has("filter.evil.x.clean")).toBe(true);
    // 每条命令都要带上：漏掉哪一条，那条命令就可能跑起仓库指定的程序。
    expect(envs.length).toBeGreaterThan(1);
    expect(envs.every((env) => env["GIT_CONFIG_COUNT"] === envs[0]?.["GIT_CONFIG_COUNT"])).toBe(true);
  });

  it("驱动名含等号时同样压得住", async () => {
    // `-c` 按第一个等号拆「键=值」，驱动名含等号时会被拆错，压的其实是另一个键。
    const envs: Readonly<Record<string, string>>[] = [];
    const runner: CommandRunner = (args, _cwd, env) => {
      const command = withoutConfigArgs(args);
      if (command.startsWith("config ")) {
        return Promise.resolve(result(Buffer.from("filter.a=b.clean\nfilter.a=b.process\n", "utf8")));
      }
      envs.push(env ?? {});
      return Promise.resolve(result(nulJoin(["# branch.head main"])));
    };

    await collectStatus(runner, "/repo");

    const pairs = overridePairs(envs[0]);
    expect(pairs.get("filter.a=b.clean")).toBe("");
    expect(pairs.get("filter.a=b.process")).toBe("");
  });

  it("把处于合并冲突的文件单列", async () => {
    const collected = await collectStatus(
      stubRunner({
        "status --porcelain=v2 -z --branch": result(unmergedStatusFixture),
        "diff --raw -z --ignore-cr-at-eol --no-ext-diff": result(Buffer.alloc(0)),
        "diff --raw -z --ignore-cr-at-eol --no-ext-diff --cached": result(Buffer.alloc(0)),
      }),
      "/repo",
    );

    expect(collected.conflicted).toEqual(["notes/merged.md"]);
    expect(collected.changes[0]?.kind).toBe("unmerged");
  });

  it("读取状态失败时给出仓库的报错首行", async () => {
    const runner = stubRunner({
      "status --porcelain=v2 -z --branch": result(Buffer.alloc(0), 128, "fatal: 不是一个 git 仓库\n第二行"),
    });

    await expect(collectStatus(runner, "/repo")).rejects.toThrow(/不是一个 git 仓库/);
    await expect(collectStatus(runner, "/repo")).rejects.toBeInstanceOf(CollectError);
  });
});

describe("真实仓库上的采集", () => {
  let available = false;
  let directory = "";

  const git = createCommandRunner("");

  /** 直接调用 git，不带任何压制：用来确认待压制的向量本身是活的。 */
  const rawGit = (cwd: string): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile("git", ["status", "--porcelain=v2"], { cwd }, (error) => {
        if (error === null) {
          resolve();
          return;
        }
        reject(error instanceof Error ? error : new Error("直接调用 git 失败"));
      });
    });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "vault-wip-collect-"));
    try {
      await gitVersion(git, directory);
      available = true;
    } catch {
      available = false;
      return;
    }

    const commit = async (message: string): Promise<void> => {
      await git(["-c", "user.email=dev@example.invalid", "-c", "user.name=device-a", "commit", "-q", "-m", message], directory);
    };

    await git(["init", "-q", "-b", "main", "."], directory);
    await git(["config", "core.fileMode", "true"], directory);
    await mkdir(join(directory, "notes"), { recursive: true });
    await writeFile(join(directory, "notes", "a.md"), "alpha\nbeta\n");
    await writeFile(join(directory, "notes", "eol.md"), "alpha\nbeta\n");
    await writeFile(join(directory, "notes", "mode.md"), "gamma\n");
    await git(["add", "-A"], directory);
    await commit("初始化");

    await writeFile(join(directory, "notes", "a.md"), "alpha\nbeta\ndelta\n");
    await writeFile(join(directory, "notes", "eol.md"), "alpha\r\nbeta\r\n");
    await writeFile(join(directory, "notes", "new.md"), "新的文件\n");
    await git(["update-index", "--chmod=+x", "notes/mode.md"], directory);
  });

  afterAll(async () => {
    if (directory !== "") {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("在真实仓库上认出改动与假冲突", async () => {
    if (!available) {
      return;
    }

    const collected = await collectStatus(git, directory);
    const paths = collected.changes.map((change) => change.path).sort();

    expect(paths).toContain("notes/a.md");
    expect(paths).toContain("notes/new.md");
    expect(collected.branch).toBe("main");
    expect(collected.suspectFiles).toContain("notes/eol.md");
  });

  it("对不存在的仓库给出可读的失败", async () => {
    if (!available) {
      return;
    }

    await expect(collectStatus(git, join(directory, "并不存在的目录"))).rejects.toBeInstanceOf(CollectError);
  });

  it("找不到 git 可执行文件时明确报错", async () => {
    const missing = createCommandRunner("/并不存在的/git");

    await expect(gitVersion(missing, directory)).rejects.toBeInstanceOf(CollectError);
  });

  it("只读查询不执行仓库配置指定的程序", async () => {
    if (!available) {
      return;
    }

    // 仓库的 .git/config 随仓库一起被克隆或同步，属于别人可以影响到的内容。
    // 采集只是只读查询，不该因为跑一次 git status 就把里面写的程序执行起来。
    const root = await mkdtemp(join(tmpdir(), "vault-wip-fsmonitor-"));
    try {
      const marker = join(root, "marker.txt");
      const hook = join(root, "hook.sh");
      await writeFile(hook, `#!/bin/sh\necho 执行了 >> "${marker}"\nprintf "1\\n"\n`, { mode: 0o755 });
      await git(["init", "-q", "."], root);
      await git(["config", "core.fsmonitor", hook], root);
      await writeFile(join(root, "a.md"), "alpha\n");

      await collectStatus(git, root);

      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("只读查询不执行仓库配置里的过滤器", async () => {
    if (!available) {
      return;
    }

    // 属性文件与驱动名都由仓库给出，且随仓库一起流转，因此采集必须自己把仓库
    // 定义过的过滤器压掉，而不是等着仓库不用它们。
    const root = await mkdtemp(join(tmpdir(), "vault-wip-filter-"));
    try {
      const marker = join(root, "marker.txt");
      const hook = join(root, "hook.sh");
      await git(["init", "-q", "."], root);
      await writeFile(join(root, "a.md"), "alpha\nbeta\n");
      await git(["add", "-A"], root);
      await git(["-c", "user.email=dev@example.invalid", "-c", "user.name=device-a", "commit", "-q", "-m", "初始化"], root);

      // 提交之后再让仓库带上过滤器：先前那次 git add 自己就会执行它，测不出采集的行为。
      await writeFile(hook, `#!/bin/sh\necho 执行了 >> "${marker}"\ncat\n`, { mode: 0o755 });
      await git(["config", "filter.evil.clean", hook], root);
      await git(["config", "filter.evil.process", hook], root);
      await writeFile(join(root, ".gitattributes"), "*.md filter=evil\n");
      // 改动前后等长：git 只凭文件大小就能判定改动时不读内容，也就不会跑过滤器，
      // 这条向量正落在需要读内容的那一侧。
      await writeFile(join(root, "a.md"), "alpha\nBETA\n");

      // 先确认这条向量确实是活的：不加任何压制时，仓库指定的程序会被跑起来。
      await rawGit(root);
      expect(await readFile(marker)).toBeTruthy();
      await rm(marker);

      await collectStatus(git, root);

      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("只读查询不执行 include 进来的过滤器", async () => {
    if (!available) {
      return;
    }

    // 驱动定义可以写在被 include 的文件里，而那个文件也能随仓库一起流转；只问
    // .git/config 本体是问不到的，因此这一处要单独盯住。
    const root = await mkdtemp(join(tmpdir(), "vault-wip-filter-include-"));
    try {
      const marker = join(root, "marker.txt");
      const hook = join(root, "hook.sh");
      await git(["init", "-q", "."], root);
      await writeFile(join(root, "a.md"), "alpha\nbeta\n");
      await git(["add", "-A"], root);
      await git(
        ["-c", "user.email=dev@example.invalid", "-c", "user.name=device-a", "commit", "-q", "-m", "初始化"],
        root,
      );

      await writeFile(hook, `#!/bin/sh\necho 执行了 >> "${marker}"\ncat\n`, { mode: 0o755 });
      const included = join(root, "nested", "filters.conf");
      await mkdir(dirname(included), { recursive: true });
      await writeFile(included, `[filter "evil"]\n\tclean = ${hook}\n\tprocess = ${hook}\n`);
      await appendFile(join(root, ".git", "config"), `\n[include]\n\tpath = ${included}\n`);
      await writeFile(join(root, ".gitattributes"), "*.md filter=evil\n");
      await writeFile(join(root, "a.md"), "alpha\nBETA\n");

      await rawGit(root);
      expect(await readFile(marker)).toBeTruthy();
      await rm(marker);

      await collectStatus(git, root);

      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("只读查询不执行名字里带等号的过滤器", async () => {
    if (!available) {
      return;
    }

    // 驱动名里可以有等号（`[filter "a=b"]`）。若是拼成 `-c filter.a=b.clean=`，git 按
    // 第一个等号拆键值，压住的是另一个键，真正要压的驱动照旧被执行。
    const root = await mkdtemp(join(tmpdir(), "vault-wip-filter-equals-"));
    try {
      const marker = join(root, "marker.txt");
      const hook = join(root, "hook.sh");
      await git(["init", "-q", "."], root);
      await writeFile(join(root, "a.md"), "alpha\nbeta\n");
      await git(["add", "-A"], root);
      await git(
        ["-c", "user.email=dev@example.invalid", "-c", "user.name=device-a", "commit", "-q", "-m", "初始化"],
        root,
      );

      await writeFile(hook, `#!/bin/sh\necho 执行了 >> "${marker}"\ncat\n`, { mode: 0o755 });
      await appendFile(
        join(root, ".git", "config"),
        `\n[filter "a=b"]\n\tclean = ${hook}\n\tprocess = ${hook}\n`,
      );
      await writeFile(join(root, ".gitattributes"), "*.md filter=a=b\n");
      await writeFile(join(root, "a.md"), "alpha\nBETA\n");

      await rawGit(root);
      expect(await readFile(marker)).toBeTruthy();
      await rm(marker);

      await collectStatus(git, root);

      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("只读查询不执行工作区配置里的过滤器", async () => {
    if (!available) {
      return;
    }

    // 开启工作区配置之后，驱动定义可以落在 .git/config.worktree 里；那时只问
    // 本地配置同样问不到，因此这一处也要单独盯住。
    const root = await mkdtemp(join(tmpdir(), "vault-wip-filter-worktree-"));
    try {
      const marker = join(root, "marker.txt");
      const hook = join(root, "hook.sh");
      await git(["init", "-q", "."], root);
      await writeFile(join(root, "a.md"), "alpha\nbeta\n");
      await git(["add", "-A"], root);
      await git(
        ["-c", "user.email=dev@example.invalid", "-c", "user.name=device-a", "commit", "-q", "-m", "初始化"],
        root,
      );

      await writeFile(hook, `#!/bin/sh\necho 执行了 >> "${marker}"\ncat\n`, { mode: 0o755 });
      await git(["config", "extensions.worktreeConfig", "true"], root);
      await writeFile(
        join(root, ".git", "config.worktree"),
        `[filter "evil"]\n\tclean = ${hook}\n\tprocess = ${hook}\n`,
      );
      await writeFile(join(root, ".gitattributes"), "*.md filter=evil\n");
      await writeFile(join(root, "a.md"), "alpha\nBETA\n");

      await rawGit(root);
      expect(await readFile(marker)).toBeTruthy();
      await rm(marker);

      await collectStatus(git, root);

      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("git 迟迟不返回时放弃本次采集", async () => {
    const script = join(directory, "slow.sh");
    await writeFile(script, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });

    const runner = createCommandRunner(script, 200);

    await expect(gitVersion(runner, directory)).rejects.toThrow(/未在 1 秒内返回/);
  });
});
