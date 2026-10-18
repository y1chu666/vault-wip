// 端到端：本插件与真实的中继服务端对话。
//
// 假中继是按我们对协议的理解写的，只有真中继才能证明两边的理解一致：请求签名、
// 记录签名、频道标识与加密载荷都要跨语言对得上。测试现场编译并启动服务端，
// 因此需要本机有 Go；没有 Go 时整组跳过，不让它成为日常单测的前置条件。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultConfig, type Config } from "../src/core/config.js";
import { Engine } from "../src/core/engine.js";
import { pluginFiles, type PluginFiles } from "../src/core/storage.js";
import { selfSignedCertificate } from "./helpers/tls.js";
import { cleanupTemporary, initRepository, temporaryDir } from "./helpers/vault.js";

/** 注册凭证与设备名称只用示例值。 */
const CREDENTIAL = "credential-for-tests";
const FIRST_LABEL = "示例设备甲";
const SECOND_LABEL = "示例设备乙";
const ALIAS = "vault-example";
const CHANGED_PATH = "notes/a.md";

const serverDirectory = join(import.meta.dirname, "..", "..", "server");

/** 本机有没有 Go 工具链。 */
function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 取一个空闲端口：先让系统分配，再立刻让出来。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("没有取到端口"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** 等端口可以连上，说明服务端已经起来。 */
async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const client = connect({ port, host: "127.0.0.1" });
      client.once("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.once("error", () => {
        client.destroy();
        resolve(false);
      });
    });
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("中继服务端没有在预期时间内就绪");
}

interface Device {
  readonly engine: Engine;
  readonly files: PluginFiles;
}

/** 起一台设备：独立的插件目录与仓库，指向同一台中继。 */
async function device(port: number, label: string, name: string): Promise<Device> {
  const base = temporaryDir(`waystation-e2e-${name}-`);
  const files = pluginFiles(join(base, "plugin"));
  const vaultRoot = join(base, "vault");
  initRepository(vaultRoot);

  const config: Config = {
    ...defaultConfig(ALIAS),
    device: { name: label },
    relay: [
      { name: "relay-a", url: `https://127.0.0.1:${String(port)}`, transport: "pinned" },
    ],
  };
  const engine = await Engine.create({
    files,
    config,
    vaultRoot,
    isFocused: () => true,
  });
  return { engine, files };
}

describe.skipIf(!hasGo())("与真实中继的端到端", () => {
  let server: ChildProcess | null = null;
  let binary = "";
  let port = 0;
  let dataDirectory = "";
  let configPath = "";
  let first: Device;
  let second: Device;

  /** 停掉服务端，好让存储文件落盘并释放文件锁。 */
  async function stopServer(): Promise<void> {
    if (server === null || server.exitCode !== null) {
      return;
    }
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server?.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }

  beforeAll(async () => {
    const base = temporaryDir("waystation-e2e-server-");
    dataDirectory = join(base, "data");
    binary = join(temporaryDir("waystation-e2e-bin-"), "waystation");
    execFileSync("go", ["build", "-o", binary, "./cmd/waystation"], {
      cwd: serverDirectory,
      stdio: "inherit",
    });

    const certificate = selfSignedCertificate();
    writeFileSync(join(base, "relay.crt"), certificate.pem);
    writeFileSync(join(base, "relay.key"), certificate.key);

    port = await freePort();
    configPath = join(base, "waystation.toml");
    writeFileSync(
      configPath,
      [
        "version = 1",
        "",
        "[server]",
        `listen = "127.0.0.1:${String(port)}"`,
        'data_dir = "data"',
        "",
        "[registration]",
        "enabled = true",
        `credential_digest = "${createHash("sha256").update(CREDENTIAL).digest("hex")}"`,
        "",
        "[transport]",
        'mode = "pinned"',
        'cert_file = "relay.crt"',
        'key_file = "relay.key"',
        "",
        "[log]",
        'level = "error"',
        "",
      ].join("\n"),
    );

    server = spawn(binary, ["serve", "--config", configPath], { stdio: "inherit" });
    await waitForPort(port);

    first = await device(port, FIRST_LABEL, "first");
    second = await device(port, SECOND_LABEL, "second");
  }, 180_000);

  afterAll(async () => {
    await stopServer();
    cleanupTemporary();
  });

  it("注册到真实中继，频道标识与证书指纹都落到实处", async () => {
    await first.engine.register(CREDENTIAL);

    const relay = first.engine.snapshot().relays[0];
    expect(relay?.channelId).not.toBe("");
    expect(relay?.lastFailure).toBeNull();
    // 钉住的是服务端证书的公钥指纹，取值由测试自己生成的证书算出。
    expect(relay?.spki).toBe(selfSignedCertificate().spki);
    expect(relay?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("两台设备注册同一别名后进入同一频道", async () => {
    await second.engine.register(CREDENTIAL);

    expect(second.engine.snapshot().relays[0]?.channelId).toBe(
      first.engine.snapshot().relays[0]?.channelId,
    );
  });

  it("记录跨语言对得上：对端取回本机的名称与改动", async () => {
    // 第二台设备先换用同一把内容密钥，否则读不出对方的密文。
    await second.engine.adoptContentKey(first.engine.contentKeyText());

    await first.engine.tick("timer");
    await second.engine.tick("timer");

    const snapshot = second.engine.snapshot();
    const peer = snapshot.peers.find((entry) => entry.label === FIRST_LABEL);
    expect(peer?.payload.paths).toEqual([CHANGED_PATH]);
    // 记录签名与请求签名都核过了，否则记录会被舍弃并记在诊断里。
    expect(snapshot.diagnostics.dropped).toHaveLength(0);
  });

  it("两端改到同一文件时判为冲突", async () => {
    await first.engine.tick("timer");
    await second.engine.tick("timer");

    const snapshot = second.engine.snapshot();
    expect(snapshot.peers.map((peer) => peer.label)).toContain(FIRST_LABEL);
    expect(snapshot.conflicts.map((conflict) => conflict.path)).toContain(CHANGED_PATH);
  });

  it("中继既看不到设备名称，也拿不到文件内容与注册凭证原文", async () => {
    await stopServer();

    const listing = execFileSync(binary, ["list", "--config", configPath], { encoding: "utf8" });
    // 中继只知道指纹，不知道名字；注册凭证也只以摘要形式保存。
    expect(listing).not.toContain(FIRST_LABEL);
    expect(listing).not.toContain(SECOND_LABEL);
    expect(listing).not.toContain(CREDENTIAL);

    const storePath = join(dataDirectory, "store.db");
    if (existsSync(storePath)) {
      const stored = readFileSync(storePath);
      expect(stored.includes(Buffer.from(FIRST_LABEL))).toBe(false);
      expect(stored.includes(Buffer.from(SECOND_LABEL))).toBe(false);
      expect(stored.includes(Buffer.from(CREDENTIAL))).toBe(false);
      expect(stored.includes(Buffer.from(CHANGED_PATH))).toBe(false);
    }
  });
});
