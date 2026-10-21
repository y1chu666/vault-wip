// 测试用的临时目录与仓库助手。
//
// 采集走的是真实的 git 命令，因此用例里就建一个真实的仓库：这样验的是本插件对
// git 输出的理解，而不是我们对它的假设。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StatusPayload } from "../../src/core/payload.js";

const created: string[] = [];

/** 建一个临时目录，记下来供用例结束时清理。 */
export function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

/** 删掉本次用例建出的全部临时目录。 */
export function cleanupTemporary(): void {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/** 在一个目录里建出有提交记录的仓库，并留下一处未提交改动。 */
export function initRepository(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };

  mkdirSync(join(root, "notes"), { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "notes", "a.md"), "第一行\n");
  git("add", "-A");
  // 身份在命令行里给全，免得用例受本机 git 配置影响，也不把真实身份写进历史。
  git(
    "-c",
    "user.name=示例",
    "-c",
    "user.email=example@example.invalid",
    "commit",
    "-q",
    "-m",
    "初次提交",
  );
  writeFileSync(join(root, "notes", "a.md"), "第一行\n改过的一行\n");
}

/** 一份只有文件名与名称不同的记录内容。 */
export function statusContent(label: string, paths: readonly string[]): StatusPayload {
  return {
    label,
    count: paths.length,
    truncated: false,
    paths: [...paths],
    kinds: paths.map(() => "M"),
    suspectFiles: [],
    conflictFiles: [],
  };
}
