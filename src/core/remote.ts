// 本模块负责远端查询：向一个远端问一次某条分支指向哪笔提交，再与本机比较。
//
// 只读不写：只用 ls-remote、rev-parse、cat-file 与 rev-list 这类查询子命令，既不拉取
// 也不写引用，更不改配置。查到的结果只用于本机界面上的显示，不进记录、不上报，
// 因此别的设备看不到它。
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { firstLine, type CommandRunner } from "./git.js";
import { t } from "./i18n.js";
import { decodeText } from "./text.js";

/** 两次自动查询之间至少隔这么久；手工点的按钮不受此限。 */
export const REMOTE_QUERY_INTERVAL_MS = 10 * 60 * 1000;

/** 一笔提交的标识：四十位小写十六进制。 */
const HASH_PATTERN = /^[0-9a-f]{40}$/;

/**
 * 查询远端时所在的目录。
 *
 * 查询不能在仓库里发起：远端名、取回程序、地址改写、凭证助手这些都写在仓库自己的
 * 配置里，其中多数本身就是要执行的命令，git 一读就会跑起来。换一个不在任何仓库里
 * 的目录来问，仓库的配置就完全参与不进来。
 */
export const QUERY_DIRECTORY = tmpdir();

/** 远端查询的结果。失败也照实记下，界面按它显示。 */
export type RemoteQueryResult =
  | { readonly kind: "up-to-date"; readonly remote: string; readonly branch: string }
  | { readonly kind: "ahead"; readonly remote: string; readonly branch: string; readonly ahead: number }
  | { readonly kind: "behind"; readonly remote: string; readonly branch: string; readonly behind: number }
  | {
      readonly kind: "diverged";
      readonly remote: string;
      readonly branch: string;
      readonly ahead: number;
      readonly behind: number;
    }
  | { readonly kind: "unfetched"; readonly remote: string; readonly branch: string }
  | { readonly kind: "missing"; readonly remote: string; readonly branch: string }
  | { readonly kind: "no-branch" }
  | { readonly kind: "no-upstream" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * 向一个远端查一次。
 *
 * remote 为空时改用当前分支的上游；上游不存在就无从比较。整个过程只读远端：
 * ls-remote 只是问一句它有哪些引用，不会把远端的东西取回本地。
 */
export async function queryRemote(
  runner: CommandRunner,
  cwd: string,
  remote: string,
): Promise<RemoteQueryResult> {
  const branch = await currentBranch(runner, cwd);
  if (branch === null) {
    return { kind: "no-branch" };
  }

  const upstream = await upstreamOf(runner, cwd);
  const target = remote === "" ? (upstream?.remote ?? "") : remote;
  if (target === "") {
    return { kind: "no-upstream" };
  }
  if (target.startsWith("-")) {
    // 以短横线开头的名字会被 git 当成选项，配置校验也拦着，这里再挡一道。
    return { kind: "failed", reason: t("远端名不合规：{remote}", { remote: target }) };
  }

  // 上游正好落在要查的远端上时按上游的分支名走，否则假定同分支同名。
  const targetBranch = upstream !== null && upstream.remote === target ? upstream.branch : branch;

  // 查询只在仓库之外按地址发起：按远端名发出的查询会牵出仓库里为该远端写下的取回
  // 程序，那是一条执行任意命令的路子。
  const address = await remoteAddress(runner, cwd, target);
  if (address === null) {
    return { kind: "failed", reason: t("读不出远端 {remote} 的地址", { remote: target }) };
  }
  const listed = await runner(
    ["-c", "protocol.ext.allow=never", "ls-remote", "--heads", address, `refs/heads/${targetBranch}`],
    QUERY_DIRECTORY,
  );
  if (listed.code !== 0) {
    return { kind: "failed", reason: firstLine(listed.stderr) };
  }
  const head = parseLsRemote(decodeText(listed.stdout));
  if (head === null) {
    return { kind: "missing", remote: target, branch: targetBranch };
  }
  if (!HASH_PATTERN.test(head.sha)) {
    return { kind: "failed", reason: t("远端给出的提交标识不合规") };
  }

  const local = await runner(["rev-parse", "HEAD"], cwd);
  if (local.code !== 0) {
    return { kind: "failed", reason: firstLine(local.stderr) };
  }
  const ours = decodeText(local.stdout).trim();
  if (ours === head.sha) {
    return { kind: "up-to-date", remote: target, branch: targetBranch };
  }

  // 远端那笔提交若不在本机对象库里，就数不出相距多远：多半是别人推上去而本机还没拉过。
  const known = await runner(["cat-file", "-e", `${head.sha}^{commit}`], cwd);
  if (known.code !== 0) {
    return { kind: "unfetched", remote: target, branch: targetBranch };
  }

  const ahead = await countCommits(runner, cwd, `${head.sha}..HEAD`);
  const behind = await countCommits(runner, cwd, `HEAD..${head.sha}`);
  if (ahead === null || behind === null) {
    return { kind: "failed", reason: t("无法比较本地与远端") };
  }

  const where = { remote: target, branch: targetBranch };
  if (ahead > 0 && behind > 0) {
    return { ...where, kind: "diverged", ahead, behind };
  }
  if (ahead > 0) {
    return { ...where, kind: "ahead", ahead };
  }
  if (behind > 0) {
    return { ...where, kind: "behind", behind };
  }
  // 标识不同而两边都不多：只可能出现在极端情形，按一致处理，免得给出自相矛盾的提示。
  return { ...where, kind: "up-to-date" };
}

/**
 * 一句界面上的说明。
 *
 * 尚未查询过时也说得清楚，免得读者把「没查过」当成「一切正常」。
 */
export function remoteSummary(result: RemoteQueryResult | null): string {
  if (result === null) {
    return t("尚未查询");
  }
  switch (result.kind) {
    case "up-to-date":
      return t("远端与本机一致");
    case "ahead":
      return t("本机有 {count} 个提交尚未推上去", { count: result.ahead });
    case "behind":
      return t("远端有 {count} 个提交本机还没有", { count: result.behind });
    case "diverged":
      return t("本地与远端已经分开：远端有 {behind} 个本机没有，本机有 {ahead} 个尚未推上去", {
        behind: result.behind,
        ahead: result.ahead,
      });
    case "unfetched":
      return t("远端分支指向本机还不认识的提交，可以先拉取一次");
    case "missing":
      return t("远端上没有这个分支：{ref}", { ref: refName(result) });
    case "no-branch":
      return t("当前不在任何分支上，无从比较远端");
    case "no-upstream":
      return t("当前分支没有可查询的上游，请在设置里填写远端");
    case "failed":
      return t("查询失败：{reason}", { reason: result.reason });
  }
}

/** 远端与分支合起来的写法，形如 origin/main。 */
export function refName(where: { readonly remote: string; readonly branch: string }): string {
  return `${where.remote}/${where.branch}`;
}

/** 距上次查询是否已经够久，够久才值得自动再问一次。 */
export function remoteQueryDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= REMOTE_QUERY_INTERVAL_MS;
}

/** 读出远端地址并整理成可直接使用的形式；读不出来时返回 null。 */
async function remoteAddress(runner: CommandRunner, cwd: string, remote: string): Promise<string | null> {
  const result = await runner(["remote", "get-url", remote], cwd);
  if (result.code !== 0) {
    return null;
  }
  const url = decodeText(result.stdout).trim();
  return url === "" ? null : resolveAddress(url, cwd);
}

/**
 * 把远端地址整理成可直接使用的形式。
 *
 * 相对路径在 git 里是相对仓库根而言的，而查询要挪到仓库之外发起，因此先按仓库根
 * 补成绝对路径。带协议、形如 scp 的写法、以短横线之外的符号开头的绝对路径连同
 * 家目录写法一律原样保留，git 自己认得。
 */
export function resolveAddress(url: string, root: string): string {
  if (
    url.startsWith("~") ||
    url.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(url) ||
    url.includes("://") ||
    /^[^/]*:/.test(url)
  ) {
    return url;
  }
  return resolve(root, url);
}

/** 当前分支名；不在任何分支上时返回 null。 */
async function currentBranch(runner: CommandRunner, cwd: string): Promise<string | null> {
  const result = await runner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const name = decodeText(result.stdout).trim();
  if (name === "" || name === "HEAD") {
    return null;
  }
  return name;
}

/** 当前分支的上游，形如 origin/main；没有上游时返回 null。 */
async function upstreamOf(
  runner: CommandRunner,
  cwd: string,
): Promise<{ readonly remote: string; readonly branch: string } | null> {
  const result = await runner(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
  if (result.code !== 0) {
    return null;
  }
  const text = decodeText(result.stdout).trim();
  const cut = text.indexOf("/");
  if (cut <= 0 || cut === text.length - 1) {
    return null;
  }
  return { remote: text.slice(0, cut), branch: text.slice(cut + 1) };
}

/** 从 `git ls-remote` 的输出里取出第一条分支记录。 */
export function parseLsRemote(output: string): { readonly sha: string; readonly ref: string } | null {
  for (const line of output.split("\n")) {
    const parts = line.trim().split("\t");
    const ref = parts[1] ?? "";
    if (ref.startsWith("refs/heads/")) {
      return { sha: parts[0] ?? "", ref };
    }
  }
  return null;
}

/** 数一段区间里有几笔提交；数不出来时返回 null。 */
async function countCommits(
  runner: CommandRunner,
  cwd: string,
  range: string,
): Promise<number | null> {
  const result = await runner(["rev-list", "--count", range], cwd);
  if (result.code !== 0) {
    return null;
  }
  const value = Number.parseInt(decodeText(result.stdout).trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
