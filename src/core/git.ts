// 本模块负责采集本机仓库的未提交状态。
//
// 采集只读不写：所有调用都是查询类子命令，不做拉取、不做暂存、不改设置。
// 输出解析与进程调用分开，解析部分以固定文本为输入，便于逐条固定行为；
// 检查与比较一律使用归一后的路径，避免同一文件在不同平台上被判为两个。
import { execFile } from "node:child_process";

import { decodeText, decodePaths } from "./text.js";
import { t } from "./i18n.js";

/** 一次外部命令的结果。 */
export interface CommandResult {
  /** 退出码。 */
  readonly code: number;
  /** 标准输出原文。 */
  readonly stdout: Uint8Array;
  /** 标准错误，供诊断显示。 */
  readonly stderr: string;
}

/**
 * 执行命令的方式。留成参数是为了让用例不必真的调用 git。
 *
 * `env` 是这一次执行额外带上的环境变量：仓库定义的过滤器要靠它压掉，缘由见
 * `filterOverrideEnv`。
 */
export type CommandRunner = (
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

/** 采集失败。消息面向使用者。 */
export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectError";
  }
}

/** 单条改动的种类。 */
export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "unmerged" | "untracked";

/** 一条改动。 */
export interface Change {
  /** 归一后的路径，用于跨设备比较。 */
  readonly path: string;
  /** 仓库中原样的路径，仅用于本地显示。 */
  readonly display: string;
  readonly kind: ChangeKind;
}

/** 一次采集的结果。 */
export interface CollectedStatus {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly changes: readonly Change[];
  /** 疑似假冲突的路径：差异看来只是行尾或权限位。 */
  readonly suspectFiles: readonly string[];
  /** 处于合并冲突状态的文件。 */
  readonly conflicted: readonly string[];
}

/** 已知的改动状态记录。 */
interface StatusEntry {
  readonly xy: string;
  readonly path: string;
}

/** 一条 raw 差异记录。 */
interface RawEntry {
  readonly srcMode: string;
  readonly dstMode: string;
  readonly srcHash: string;
  readonly dstHash: string;
  readonly status: string;
  readonly path: string;
}

const ZERO_HASH = "0000000000000000000000000000000000000000";

/** 采集超时（毫秒）。仓库异常大或位于网络盘时宁可放弃一次采集，也不要挂住上报。 */
const COLLECT_TIMEOUT_MS = 10_000;

/**
 * 每条命令都前置的取值，用来压过仓库自身配置。
 *
 * 仓库的 .git/config 随仓库一起被克隆、同步或改动，属于别人可以影响到的内容。
 * 其中的 core.fsmonitor 会让 git 执行指定的程序，diff.external 同理；采集只是
 * 只读查询，不该因此以本进程的权限执行仓库指定的任何程序。命令行取值的优先级
 * 高于仓库配置，因此这几项一旦写在这里，仓库里怎么写都不会被调用。
 */
const SAFE_CONFIG_ARGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "diff.external="];

/**
 * 列出仓库自己的配置里定义过的过滤器驱动名。
 *
 * 过滤器是另一条执行程序的路子，而且不能靠列举固定的名字堵住：驱动名由仓库自定，
 * 属性文件随仓库流转，一旦属性选中某个驱动，git 比对工作区文件时就会跑起该驱动
 * 指定的程序。因此先问一句仓库里定义过哪些驱动，再逐个压掉。
 *
 * 仓库自己的配置有几处来源：`.git/config` 本体、它用 include 引来的文件，以及开启
 * 工作区配置之后的 `.git/config.worktree`（后者同样可以再 include）。不问 include
 * 与工作区这两处，写在那里的驱动就压不住——而 git 比对内容时读的是生效配置，
 * 漏掉的照旧会被执行。因此两处都问，取并集。全局与系统配置属于本机自己的内容，
 * 不随仓库流转，不在此列。
 */
async function localFilterDrivers(runner: CommandRunner, cwd: string): Promise<string[]> {
  const names = new Set<string>();
  for (const scope of ["--local", "--worktree"]) {
    const result = await runner(
      ["config", scope, "--includes", "--name-only", "--get-regexp", "^filter\\."],
      cwd,
    );
    if (result.code !== 0) {
      // 一条过滤器都没有时 git 以非零退出；没开启工作区配置时 --worktree 也会如此。
      continue;
    }
    for (const key of decodePaths(result.stdout).split("\n")) {
      const name = driverNameOf(key);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** 从 `filter.<驱动名>.<项>` 这样的键里剥出驱动名；不成形时返回 null。 */
function driverNameOf(key: string): string | null {
  // 驱动名本身可以含点，因此只剥掉首尾两段。
  const parts = key.trim().split(".");
  if (parts.length < 3 || parts[0] !== "filter") {
    return null;
  }
  const name = parts.slice(1, -1).join(".");
  return name === "" ? null : name;
}

/**
 * 把仓库自己定义的过滤器逐个清空，做成随命令带过去的一组环境变量。
 *
 * 清空取值而不改仓库文件：命令行一带上就压过仓库里的写法。这里不走 `-c`，因为
 * `-c` 按第一个等号拆「键=值」，而驱动名本身可以含等号（`[filter "a=b"]`），那样
 * 拼出来的键会被拆错，真正要压的驱动反而压不住。`GIT_CONFIG_*` 这组环境变量把键
 * 整条给出，含等号也对得上。顺带把驱动标为非必需，免得压掉取值之后 git 因
 * 「驱动不见了」直接报错。
 */
async function filterOverrideEnv(runner: CommandRunner, cwd: string): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const name of await localFilterDrivers(runner, cwd)) {
    for (const slot of ["clean", "process", "smudge"]) {
      entries.push([`filter.${name}.${slot}`, ""]);
    }
    entries.push([`filter.${name}.required`, "false"]);
  }
  if (entries.length === 0) {
    return {};
  }

  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** 默认的命令执行方式：不经外壳，直接调用可执行文件。 */
export function createCommandRunner(gitPath: string, timeoutMs = COLLECT_TIMEOUT_MS): CommandRunner {
  const executable = gitPath === "" ? "git" : gitPath;

  return (args, cwd, env) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        [...SAFE_CONFIG_ARGS, ...args],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          // 取原始字节：路径与输出都不必经过一层字符串编码再解回来。
          encoding: "buffer",
          // 固定语言与关闭可选锁，使输出不随环境变化，也不与使用者的 git 操作互相干扰；
          // 禁止交互式询问，避免在没有终端时静静等下去。
          env: {
            ...process.env,
            LC_ALL: "C",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            ...env,
          },
        },
        (error, stdout, stderr) => {
          const out = { stdout, stderr: stderr.toString("utf8") };
          if (error === null) {
            resolve({ code: 0, ...out });
            return;
          }
          if (error.killed === true) {
            reject(
              new CollectError(
                t("git 未在 {seconds} 秒内返回，本次采集放弃", {
                  seconds: Math.max(1, Math.round(timeoutMs / 1000)),
                }),
              ),
            );
            return;
          }
          if (typeof error.code === "string") {
            // 进程根本起不来时错误码是字符串，例如可执行文件不存在。
            reject(new CollectError(t("无法执行 {executable}：{reason}", { executable, reason: error.message })));
            return;
          }
          // 非零退出码交给调用方判断：不同子命令下它的含义不同。
          resolve({ code: typeof error.code === "number" ? error.code : 1, ...out });
        },
      );
    });
}

/** 检查 git 是否可用，并返回其版本。 */
export async function gitVersion(runner: CommandRunner, cwd: string): Promise<string> {
  const result = await runner(["--version"], cwd);
  if (result.code !== 0) {
    throw new CollectError(t("git 不可用，请检查 git 可执行文件路径设置"));
  }
  return decodeText(result.stdout).trim();
}

/**
 * 采集一次状态。
 *
 * 假冲突的判定只用于措辞：它依赖带行尾过滤的差异输出，因此仅在确实存在改动时才多跑两次 git。
 */
export async function collectStatus(runner: CommandRunner, cwd: string): Promise<CollectedStatus> {
  // 仓库自己定义的过滤器先取一次，随后每条命令都带着压掉它们的取值。
  const filterEnv = await filterOverrideEnv(runner, cwd);

  const statusResult = await runner(["status", "--porcelain=v2", "-z", "--branch"], cwd, filterEnv);
  if (statusResult.code !== 0) {
    throw new CollectError(t("读取仓库状态失败：{detail}", { detail: firstLine(statusResult.stderr) }));
  }

  const parsed = parseStatusOutput(statusResult.stdout);
  const changes = parsed.entries.map((entry) => ({
    path: normalizePath(entry.path),
    display: entry.path,
    kind: kindOf(entry.xy),
  }));

  let suspectFiles: string[] = [];
  if (changes.length > 0) {
    suspectFiles = await detectFalseConflicts(runner, cwd, changes, filterEnv);
  }

  return {
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
    changes,
    suspectFiles,
    conflicted: changes.filter((change) => change.kind === "unmerged").map((change) => change.path),
  };
}

/**
 * 找出「看似有改动，实则无需担心」的文件。
 *
 * 判定依据是 git 自己的比较结果，而不是自行推断行尾或权限的处理方式：
 * 加上忽略行尾差异的过滤后仍无差异，说明差异只在行尾；两侧内容一致而权限位不同，
 * 说明差异只在权限位。两者都只影响提示措辞。
 */
async function detectFalseConflicts(
  runner: CommandRunner,
  cwd: string,
  changes: readonly Change[],
  filterEnv: Readonly<Record<string, string>>,
): Promise<string[]> {
  const unstaged = parseRawDiff((await runDiff(runner, cwd, false, filterEnv)).stdout);
  const staged = parseRawDiff((await runDiff(runner, cwd, true, filterEnv)).stdout);
  const differed = new Set<string>([...unstaged, ...staged].map((entry) => normalizePath(entry.path)));

  const suspects = new Set<string>();
  for (const change of changes) {
    if (change.kind === "modified" && !differed.has(change.path)) {
      // 两侧都记为改动，忽略行尾后却没有差异，只可能是行尾不同。
      suspects.add(change.path);
    }
  }
  for (const entry of [...unstaged, ...staged]) {
    if (isModeOnly(entry)) {
      suspects.add(normalizePath(entry.path));
    }
  }
  return [...suspects].sort();
}

function runDiff(
  runner: CommandRunner,
  cwd: string,
  staged: boolean,
  filterEnv: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  // --no-ext-diff 显式关掉外部差异程序：raw 格式本就用不到它，写在这里是为了
  // 即便日后改动了参数，也不会顺手把仓库配置里的程序带上。
  const args = ["diff", "--raw", "-z", "--ignore-cr-at-eol", "--no-ext-diff"];
  if (staged) {
    args.push("--cached");
  }
  return runner(args, cwd, filterEnv);
}

/** 同一个文件的两侧内容一致而权限位不同，即为仅权限差异。 */
function isModeOnly(entry: RawEntry): boolean {
  if (entry.srcHash === ZERO_HASH || entry.dstHash === ZERO_HASH || entry.srcHash !== entry.dstHash) {
    return false;
  }
  return entry.srcMode !== entry.dstMode;
}

/** 解析 `git status --porcelain=v2 -z --branch` 的输出。 */
export function parseStatusOutput(output: Uint8Array): {
  branch: string;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
} {
  const fields = splitNullTerminated(output);
  const entries: StatusEntry[] = [];
  let branch = "";
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record === "") {
      continue;
    }

    if (record.startsWith("# ")) {
      const [key, value] = splitOnce(record.slice(2), " ");
      if (key === "branch.head" && value !== "(detached)") {
        branch = value ?? "";
      } else if (key === "branch.ab") {
        const counts = (value ?? "").split(" ");
        ahead = parseCount(counts[0], "+");
        behind = parseCount(counts[1], "-");
      }
      continue;
    }

    const type = record[0];
    if (type === "1") {
      const parts = splitLimit(record, " ", 8);
      const path = parts[8];
      const xy = parts[1];
      if (path !== undefined && xy !== undefined) {
        entries.push({ xy, path });
      }
    } else if (type === "2") {
      // 重命名记录把改名前的路径放在下一个字段，这里只用改名后的路径。
      const parts = splitLimit(record, " ", 9);
      const path = parts[9];
      const xy = parts[1];
      if (path !== undefined && xy !== undefined) {
        entries.push({ xy, path });
      }
      index += 1;
    } else if (type === "u") {
      const parts = splitLimit(record, " ", 10);
      const path = parts[10];
      const xy = parts[1];
      if (path !== undefined && xy !== undefined) {
        entries.push({ xy, path });
      }
    } else if (type === "?") {
      // 只取未跟踪文件；`!` 表示被忽略的文件，本插件不关心，也不必向 git 索要。
      const path = record.slice(2);
      if (path !== "") {
        entries.push({ xy: "??", path });
      }
    }
  }

  return { branch, ahead, behind, entries };
}

/** 解析 `git diff --raw -z` 的输出。 */
export function parseRawDiff(output: Uint8Array): RawEntry[] {
  // 每条记录的元信息与路径各占一个 NUL 字段；重命名再多一个字段。
  const fields = splitNullTerminated(output);
  const entries: RawEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index];
    if (meta === undefined || !meta.startsWith(":")) {
      continue;
    }

    const parts = meta.slice(1).split(" ");
    const [srcMode, dstMode, srcHash, dstHash, status] = parts;
    const first = fields[index + 1];
    const second = fields[index + 2];
    if (
      srcMode === undefined ||
      dstMode === undefined ||
      srcHash === undefined ||
      dstHash === undefined ||
      status === undefined ||
      first === undefined
    ) {
      continue;
    }

    // 重命名与复制给出两个路径，顺序是先改动前、后改动后；这里只取改动后的那个。
    const renamed = status.startsWith("R") || status.startsWith("C");
    const path = renamed ? second : first;
    if (path === undefined || path === "") {
      continue;
    }
    index += renamed ? 2 : 1;

    entries.push({ srcMode, dstMode, srcHash, dstHash, status, path });
  }

  return entries;
}

/** 把两字符的状态码归入一种改动。 */
function kindOf(xy: string): ChangeKind {
  if (xy === "??") {
    return "untracked";
  }
  const index = xy[0] ?? ".";
  const worktree = xy[1] ?? ".";
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) {
    return "unmerged";
  }
  if (index === "R" || worktree === "R" || index === "C" || worktree === "C") {
    return "renamed";
  }
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  if (index === "A") {
    return "added";
  }
  return "modified";
}

/**
 * 归一化路径。
 *
 * 统一为小写并做 Unicode 归一，同时把分隔符统一成斜杠：同一文件在不同平台、
 * 不同输入法下的写法可能不同，只有归一之后才能可靠地比对。
 */
export function normalizePath(path: string): string {
  return path.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function splitNullTerminated(output: Uint8Array): string[] {
  return decodePaths(output).split("\u0000");
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  if (at < 0) {
    return [text, undefined];
  }
  return [text.slice(0, at), text.slice(at + separator.length)];
}

/** 按分隔符切分，末段保留其中的分隔符：路径本身可能含空格。 */
function splitLimit(text: string, separator: string, count: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < count) {
    const at = rest.indexOf(separator);
    if (at < 0) {
      break;
    }
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  parts.push(rest);
  return parts;
}

function parseCount(value: string | undefined, sign: string): number {
  if (value === undefined || !value.startsWith(sign)) {
    return 0;
  }
  const count = Number.parseInt(value.slice(1), 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** 取输出里的第一行：把 git 的长篇 stderr 收成一句能放进提示的话。 */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
