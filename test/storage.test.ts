import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateContentKey } from "../src/core/crypto.js";
import {
  SECRET_FILE_NAMES,
  STATE_VERSION,
  StorageError,
  ensureSecretIgnore,
  fileExists,
  loadOrCreateContentKey,
  loadOrCreateDeviceKey,
  loadRelayPins,
  loadState,
  pluginFiles,
  readTextFile,
  saveRelayPins,
  saveState,
  writeTextFile,
  type PersistedState,
  type PluginFiles,
} from "../src/core/storage.js";

const directories: string[] = [];

/** 建一个临时插件目录。 */
async function temporaryFiles(): Promise<PluginFiles> {
  const base = await mkdtemp(join(tmpdir(), "vault-wip-"));
  directories.push(base);
  return pluginFiles(base);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe("pluginFiles", () => {
  it("把各个文件放在同一个目录下", () => {
    const files = pluginFiles("/插件目录");

    expect(files.config).toBe("/插件目录/config.toml");
    expect(files.deviceKey).toBe("/插件目录/device.key");
    expect(files.contentKey).toBe("/插件目录/content.key");
    expect(files.pins).toBe("/插件目录/pins.json");
    expect(files.state).toBe("/插件目录/state.json");
    expect(files.ignore).toBe("/插件目录/.gitignore");
  });
});

describe("文本文件的读写", () => {
  it("写出后再读回，内容一字不差", async () => {
    const files = await temporaryFiles();

    await writeTextFile(files.config, "alias = \"仓库甲\"\n");

    expect(await readTextFile(files.config)).toBe("alias = \"仓库甲\"\n");
  });

  it("目录不存在时一并建出，且不留临时文件", async () => {
    const files = await temporaryFiles();
    const nested = pluginFiles(join(files.config, "..", "下层"));

    await writeTextFile(nested.state, "{}\n");

    expect(await fileExists(nested.state)).toBe(true);
    expect(await fileExists(`${nested.state}.tmp`)).toBe(false);
  });

  it("文件不存在时返回空，而不是抛错", async () => {
    const files = await temporaryFiles();

    expect(await readTextFile(files.state)).toBeNull();
    expect(await fileExists(files.state)).toBe(false);
  });

  it("拒绝非 UTF-8 的内容", async () => {
    const files = await temporaryFiles();
    await writeFile(files.config, Buffer.from([0xff, 0xfe]));

    await expect(readTextFile(files.config)).rejects.toThrow(StorageError);
  });

  it("目录被占用时写入失败并给出路径", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.config, "text");

    // 把文件当作目录来写，操作系统会拒绝。
    await expect(writeTextFile(join(files.config, "下层"), "text")).rejects.toThrow(/写入/);
  });

  it("密钥文件只有属主可读写", async () => {
    const files = await temporaryFiles();

    await writeTextFile(files.deviceKey, "text", 0o600);

    if (process.platform !== "win32") {
      const info = await stat(files.deviceKey);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it("上一次留下的临时文件不会把宽权限带给密钥", async () => {
    const files = await temporaryFiles();
    // 上一次写到一半留下的临时文件：直接覆盖写会沿用它的权限，密钥就成宽权限了。
    await writeFile(`${files.deviceKey}.tmp`, "旧的");

    await writeTextFile(files.deviceKey, "text", 0o600);

    expect(await readTextFile(files.deviceKey)).toBe("text");
    if (process.platform !== "win32") {
      const info = await stat(files.deviceKey);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it("临时文件位置的符号链接不会被顺着写出去", async () => {
    const files = await temporaryFiles();
    const other = join(dirname(files.deviceKey), "别处.txt");
    await writeFile(other, "原样");
    await symlink(other, `${files.deviceKey}.tmp`);

    await writeTextFile(files.deviceKey, "text", 0o600);

    expect(await readTextFile(other)).toBe("原样");
    expect(await readTextFile(files.deviceKey)).toBe("text");
  });
});

describe("ensureSecretIgnore", () => {
  it("首次运行时写下说明与密钥文件名", async () => {
    const files = await temporaryFiles();

    await ensureSecretIgnore(files.ignore, SECRET_FILE_NAMES);

    const text = await readTextFile(files.ignore);
    expect(text).toContain("device.key");
    expect(text).toContain("content.key");
  });

  it("已有的条目不再重复写入", async () => {
    const files = await temporaryFiles();

    await ensureSecretIgnore(files.ignore, SECRET_FILE_NAMES);
    const before = await readTextFile(files.ignore);
    await ensureSecretIgnore(files.ignore, SECRET_FILE_NAMES);

    expect(await readTextFile(files.ignore)).toBe(before);
  });

  it("保留使用者自己写的规则，只补上缺的条目", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.ignore, "# 自己的规则\n*.log");

    await ensureSecretIgnore(files.ignore, ["device.key"]);

    const text = await readTextFile(files.ignore);
    expect(text).toContain("*.log");
    expect(text).toContain("device.key");
    expect(text?.endsWith("device.key\n")).toBe(true);
  });
});

describe("密钥的读写", () => {
  it("首次运行生成设备私钥并写下文件", async () => {
    const files = await temporaryFiles();

    const { key, created } = await loadOrCreateDeviceKey(files);

    expect(created).toBe(true);
    const text = await readTextFile(files.deviceKey);
    expect(text?.trim()).toBe(key.seedHexForStorage());
  });

  it("再次运行时读回同一把设备私钥", async () => {
    const files = await temporaryFiles();

    const first = await loadOrCreateDeviceKey(files);
    const second = await loadOrCreateDeviceKey(files);

    expect(second.created).toBe(false);
    expect(second.key.fingerprint).toBe(first.key.fingerprint);
  });

  it("设备私钥文件不合规时给出提示", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.deviceKey, "不是私钥\n");

    await expect(loadOrCreateDeviceKey(files)).rejects.toThrow(/设备私钥不可用/);
  });

  it("首次运行生成内容密钥，再次运行时读回同一把", async () => {
    const files = await temporaryFiles();

    const first = await loadOrCreateContentKey(files);
    const second = await loadOrCreateContentKey(files);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.key.id).toBe(first.key.id);
  });

  it("内容密钥文件不合规时给出提示", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.contentKey, "不是密钥\n");

    await expect(loadOrCreateContentKey(files)).rejects.toThrow(/内容密钥不可用/);
  });
});

describe("钉住的中继信息", () => {
  it("文件不存在时给出空表", async () => {
    const files = await temporaryFiles();

    expect(await loadRelayPins(files.pins)).toEqual(new Map());
  });

  it("写出后再读回", async () => {
    const files = await temporaryFiles();
    const pins = new Map([
      ["relay-b", { serverFingerprint: "bb", serverPublicKey: "BB", spki: "s-b" }],
      ["relay-a", { serverFingerprint: "aa", serverPublicKey: "AA", spki: "s-a" }],
    ]);

    await saveRelayPins(files.pins, pins);

    expect(await loadRelayPins(files.pins)).toEqual(pins);
    // 写出时按名称排序，使文件在版本控制下也稳定。
    expect(await readTextFile(files.pins)).toMatch(/"relay-a"[\s\S]*"relay-b"/);
  });

  it("内容不合规时要求重新配对", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.pins, "{ 不是 JSON");

    await expect(loadRelayPins(files.pins)).rejects.toThrow(/重新配对/);
  });

  it("不是表的条目一并拒绝", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.pins, `{"relay-a": 1}`);

    await expect(loadRelayPins(files.pins)).rejects.toThrow(/重新配对/);
  });

  it("缺少字段的条目一并拒绝", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.pins, `{"relay-a": {"serverFingerprint": "aa"}}`);

    await expect(loadRelayPins(files.pins)).rejects.toThrow(/重新配对/);
  });

  it("顶层不是表时一并拒绝", async () => {
    const files = await temporaryFiles();
    await writeTextFile(files.pins, `[]`);

    await expect(loadRelayPins(files.pins)).rejects.toThrow(/重新配对/);
  });
});

describe("状态缓存", () => {
  const state: PersistedState = {
    version: STATE_VERSION,
    channels: { "relay-a": { channelId: "aa".repeat(16), alias: "vault-example" } },
    sequence: 7,
    retired: false,
    peers: [
      {
        fingerprint: "aa",
        label: "示例设备乙",
        sequence: 3,
        collectedAt: "2023-11-14T22:15:23Z",
        payload: {
          label: "示例设备乙",
          count: 1,
          truncated: false,
          paths: ["notes/a.md"],
          suspectFiles: [],
          conflictFiles: [],
        },
      },
    ],
    revoked: ["bb"],
  };

  it("文件不存在时给出空", async () => {
    const files = await temporaryFiles();

    expect(await loadState(files.state)).toBeNull();
  });

  it("写出后再读回", async () => {
    const files = await temporaryFiles();

    await saveState(files.state, state);

    expect(await loadState(files.state)).toEqual(state);
  });

  it("缓存损坏时按首次运行处理", async () => {
    const files = await temporaryFiles();

    for (const text of [
      "不是 JSON",
      "[]",
      `{"version": 99}`,
      `{"version": 1}`,
      `{"version": 1, "channels": 1}`,
      `{"version": 1, "channels": {}, "sequence": 0, "peers": [], "revoked": []}`,
    ]) {
      await writeTextFile(files.state, text);
      expect(await loadState(files.state)).toBeNull();
    }

    // 频道一节里缺字段，同样按首次运行处理。
    await writeTextFile(
      files.state,
      JSON.stringify({ ...state, channels: { "relay-a": { channelId: "aa" } } }),
    );
    expect(await loadState(files.state)).toBeNull();
  });

  it("对端内容不合规时整体丢弃", async () => {
    const files = await temporaryFiles();
    const broken = { ...state, peers: [{ fingerprint: "aa", label: "", sequence: 1, collectedAt: "", payload: {} }] };
    await writeTextFile(files.state, JSON.stringify(broken));
    expect(await loadState(files.state)).toBeNull();

    const badPaths = {
      ...state,
      peers: [{ ...state.peers[0], payload: { label: "", count: 1, truncated: false, paths: [1], suspectFiles: [], conflictFiles: [] } }],
    };
    await writeTextFile(files.state, JSON.stringify(badPaths));
    expect(await loadState(files.state)).toBeNull();

    const badRevoked = { ...state, revoked: [1] };
    await writeTextFile(files.state, JSON.stringify(badRevoked));
    expect(await loadState(files.state)).toBeNull();
  });

  it("内容密钥可以随状态一起落下而无需额外文件", async () => {
    const files = await temporaryFiles();
    const key = generateContentKey();

    await writeTextFile(files.contentKey, `${Buffer.from(key.bytes).toString("hex")}\n`);
    const text = await readFile(files.contentKey, "utf8");

    expect(text.trim()).toHaveLength(64);
  });
});
