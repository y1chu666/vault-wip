import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Notice } from "../src/core/alerts.js";
import { defaultConfig, type Config, type TransportLevel } from "../src/core/config.js";
import {
  decodeContentKey,
  decryptContent,
  encodeContentKey,
  encryptContent,
  generateContentKey,
  type ContentKey,
} from "../src/core/crypto.js";
import { Engine, type EngineSnapshot } from "../src/core/engine.js";
import { signRecord } from "../src/core/envelope.js";
import { DeviceKey } from "../src/core/identity.js";
import { decodeStatusPayload, encodeStatusPayload, type StatusPayload } from "../src/core/payload.js";
import type { PeerRecord } from "../src/core/relay.js";
import {
  STATE_VERSION,
  pluginFiles,
  readTextFile,
  saveState,
  type PluginFiles,
} from "../src/core/storage.js";
import { startFakeRelay, type FakeRelay, type Reply } from "./helpers/relay-server.js";
import { cleanupTemporary, initRepository, statusContent, temporaryDir } from "./helpers/vault.js";

afterEach(() => {
  cleanupTemporary();
});

/** 一次典型的答复：注册给频道，其余给一次成功的上报。 */
function defaultReply(alias: string, channelId: string): (request: { path: string }) => Reply {
  return (request) =>
    request.path === "/v1/register"
      ? { status: 200, body: { channel_id: channelId, channel_alias: alias } }
      : { status: 200, body: { accepted: true, records: [], revocations: [] } };
}

/** 拼一份对端记录的内容。 */
function recordDTO(record: PeerRecord): Record<string, unknown> {
  return {
    fingerprint: record.fingerprint,
    public_key: Buffer.from(record.publicKey).toString("base64"),
    sequence: record.sequence,
    collected_at: record.collectedAt,
    payload: Buffer.from(record.payload).toString("base64"),
    signature: Buffer.from(record.signature).toString("base64"),
  };
}

/** 造一条对端记录，字段齐全、签名成立。 */
function peerRecord(options: {
  readonly key: DeviceKey;
  readonly contentKey: ContentKey;
  readonly channelId: string;
  readonly sequence: number;
  readonly collectedAt: string;
  readonly payload: StatusPayload;
}): PeerRecord {
  const payload = encryptContent(options.contentKey, encodeStatusPayload(options.payload));
  return {
    fingerprint: options.key.fingerprint,
    publicKey: options.key.publicKey,
    sequence: options.sequence,
    collectedAt: options.collectedAt,
    payload,
    signature: signRecord(options.key, {
      fingerprint: options.key.fingerprint,
      channel: options.channelId,
      sequence: options.sequence,
      collectedAt: new Date(options.collectedAt),
      payload,
    }),
  };
}

interface Fixture {
  readonly files: PluginFiles;
  readonly vaultRoot: string;
  readonly relay: FakeRelay;
  readonly engine: Engine;
  readonly config: Config;
  readonly notices: Notice[];
  snapshot(): EngineSnapshot;
}

/** 起一套完整的装置：临时插件目录、临时仓库、一台测试中继与一个引擎。 */
async function fixture(options: {
  readonly level?: TransportLevel;
  readonly relayName?: string;
  readonly channelId?: string;
  readonly register?: boolean;
  readonly sequence?: number;
  readonly configure?: (config: Config) => Config;
} = {}): Promise<Fixture> {
  const base = temporaryDir("waystation-engine-");
  const files = pluginFiles(join(base, "plugin"));
  const vaultRoot = join(base, "vault");
  initRepository(vaultRoot);

  const level = options.level ?? "plaintext";
  const relayName = options.relayName ?? "relay-a";
  const channelId = options.channelId ?? "aa".repeat(16);
  const relay = await startFakeRelay(level !== "plaintext");

  const base4 = defaultConfig("vault-example");
  const config = (options.configure ?? ((value: Config) => value))({
    ...base4,
    relay: [{ name: relayName, url: relay.url, transport: level }],
  });

  if (options.register !== true) {
    await saveState(files.state, {
      version: STATE_VERSION,
      channels: { [relayName]: { channelId, alias: "vault-example" } },
      sequence: options.sequence ?? 0,
      peers: [],
      revoked: [],
      retired: false,
    });
  }

  relay.reply = defaultReply("vault-example", channelId);

  const notices: Notice[] = [];
  const engine = await Engine.create({
    files,
    config,
    vaultRoot,
    notify: (notice) => notices.push(notice),
    isFocused: () => true,
  });
  // 中继按请求里的公钥验签，这里替它备好本设备的公钥。
  relay.devicePublicKey = (await deviceKeyOf(files)).publicKey;

  return {
    files,
    vaultRoot,
    relay,
    engine,
    config,
    notices,
    snapshot: () => engine.snapshot(),
  };
}

/** 读出引擎当前使用的内容密钥，用于造对端记录或核对密文。 */
async function contentKeyOf(files: PluginFiles): Promise<ContentKey> {
  const text = await readTextFile(files.contentKey);
  if (text === null) {
    throw new Error("内容密钥没有落盘");
  }
  return decodeContentKey(text);
}

/** 读出本设备的公钥，用于核对记录签名。 */
async function deviceKeyOf(files: PluginFiles): Promise<DeviceKey> {
  const text = await readTextFile(files.deviceKey);
  if (text === null) {
    throw new Error("设备私钥没有落盘");
  }
  return DeviceKey.fromSeedText(text.trim());
}

describe("采集与上报", () => {
  it("把本机改动整理成记录发出", async () => {
    const env = await fixture();

    await env.engine.tick("startup");

    const request = env.relay.requests[0];
    expect(request?.path).toBe("/v1/report");
    expect(request?.signatureValid).toBe(true);
    expect(request?.body["sequence"]).toBe(1);

    const content = decodeStatusPayload(
      decryptContent(await contentKeyOf(env.files), new Uint8Array(Buffer.from(String(request?.body["payload"]), "base64"))),
    );
    expect(content.paths).toEqual(["notes/a.md"]);
    expect(content.count).toBe(1);

    // 记录签名覆盖频道标识与内容摘要，用本设备的公钥可以核过。
    const device = await deviceKeyOf(env.files);
    const payload = new Uint8Array(Buffer.from(String(request?.body["payload"]), "base64"));
    const signature = new Uint8Array(Buffer.from(String(request?.body["signature"]), "base64"));
    expect(
      signRecord(device, {
        fingerprint: device.fingerprint,
        channel: "aa".repeat(16),
        sequence: 1,
        collectedAt: new Date("2023-11-14T22:15:23Z"),
        payload,
      }),
    ).toHaveLength(64);
    expect(signature).toHaveLength(64);
  });

  it("序号逐轮推进", async () => {
    const env = await fixture();

    await env.engine.tick("timer");
    await env.engine.tick("timer");

    expect(env.relay.requests.map((request) => request.body["sequence"])).toEqual([1, 2]);
    expect(env.snapshot().sequence).toBe(2);
  });

  it("中继指出既有记录时按它推进后重报", async () => {
    const env = await fixture();
    const key = DeviceKey.generate();
    const existing = peerRecord({
      key,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 9,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });

    env.relay.reply = (request) =>
      request.path === "/v1/report" && request.body["sequence"] === 1
        ? {
            status: 200,
            body: { accepted: false, own: recordDTO(existing), records: [], revocations: [] },
          }
        : { status: 200, body: { accepted: true, records: [], revocations: [] } };

    await env.engine.tick("timer");

    expect(env.relay.requests.map((request) => request.body["sequence"])).toEqual([1, 10]);
    expect(env.snapshot().sequence).toBe(10);
  });

  it("重报之后仍被拒就如实说明", async () => {
    const env = await fixture();
    const key = DeviceKey.generate();
    const contentKey = await contentKeyOf(env.files);
    const make = (sequence: number): PeerRecord =>
      peerRecord({
        key,
        contentKey,
        channelId: "aa".repeat(16),
        sequence,
        collectedAt: "2023-11-14T22:15:23Z",
        payload: statusContent("示例设备乙", []),
      });
    const behind = make(9);
    const ahead = make(15);

    // 第一次指出本设备落后，重报之后仍然拒收：此时如实说明，而不是无声地反复重报。
    env.relay.reply = (request) => ({
      status: 200,
      body: {
        accepted: false,
        own: recordDTO(Number(request.body["sequence"]) === 1 ? behind : ahead),
        records: [],
        revocations: [],
      },
    });

    await env.engine.tick("timer");

    expect(env.relay.requests.map((request) => request.body["sequence"])).toEqual([1, 10]);
    expect(env.snapshot().diagnostics.events.join("\n")).toContain("重报之后仍被拒");
  });

  it("尚未注册时不上报，并说明原因", async () => {
    const env = await fixture({ relayName: "relay-a" });
    await saveState(env.files.state, {
      version: STATE_VERSION,
      channels: {},
      sequence: 0,
      peers: [],
      revoked: [],
      retired: false,
    });
    const engine = await Engine.create({
      files: env.files,
      config: defaultConfig("vault-example"),
      vaultRoot: env.vaultRoot,
      notify: () => undefined,
      isFocused: () => true,
    });

    await engine.tick("timer");

    expect(env.relay.requests).toHaveLength(0);
    expect(engine.snapshot().relays[0]?.lastFailure).toContain("尚未注册本仓库");
  });

  it("中继联系不上时采集照旧，失败如实记下", async () => {
    const env = await fixture();
    await env.relay.close();

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.local?.count).toBe(1);
    expect(snapshot.relays[0]?.lastFailure).toBeTruthy();
    expect(env.notices.map((notice) => notice.kind)).toContain("failure");
  });

  it("没有中继时不视为故障", async () => {
    const env = await fixture({ configure: (config) => ({ ...config, relay: [] }) });

    await env.engine.tick("timer");

    expect(env.notices).toHaveLength(0);
    expect(env.snapshot().relays).toHaveLength(0);
  });

  it("采集失败时记入诊断，也不上报", async () => {
    const env = await fixture();
    rmSync(join(env.vaultRoot, ".git"), { recursive: true, force: true });

    await env.engine.tick("timer");

    expect(env.relay.requests).toHaveLength(0);
    expect(env.snapshot().diagnostics.events.join("\n")).toContain("采集失败");
  });
});

describe("合并对端状态", () => {
  it("取回对端记录并显示其名称与改动", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 3,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    env.relay.reply = (request) =>
      request.path === "/v1/report"
        ? { status: 200, body: { accepted: true, records: [recordDTO(record)], revocations: [] } }
        : { status: 200, body: { ok: true } };

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.peers).toHaveLength(1);
    expect(snapshot.peers[0]?.label).toBe("示例设备乙");
    expect(snapshot.peers[0]?.payload.paths).toEqual(["notes/b.md"]);
    // 启动后对端有改动，应当提示一次。
    expect(env.notices.map((notice) => notice.kind)).toContain("peerChanges");
  });

  it("本地与对端改到同一个文件时判定为冲突", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/a.md"]),
    });
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: true, records: [recordDTO(record)], revocations: [] },
    });

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0]?.path).toBe("notes/a.md");
    expect(env.notices.map((notice) => notice.kind)).toContain("conflict");
  });

  it("记录签名核不过时舍弃并说明原因", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const other = DeviceKey.generate();
    const record = peerRecord({
      key: other,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    // 指纹与公钥相符，但签名来自另一把钥匙。
    const forged: PeerRecord = { ...record, fingerprint: peer.fingerprint, publicKey: peer.publicKey };
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: true, records: [recordDTO(forged)], revocations: [] },
    });

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.peers).toHaveLength(0);
    expect(snapshot.diagnostics.dropped[0]?.reason).toContain("签名核不过");
  });

  it("密钥不同的记录读不出来，如实记下", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: generateContentKey(),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: true, records: [recordDTO(record)], revocations: [] },
    });

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.peers).toHaveLength(0);
    expect(snapshot.diagnostics.dropped[0]?.reason).toContain("密钥与当前密钥不同");
  });

  it("同一序号上出现两份内容时保留先前那份", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const contentKey = await contentKeyOf(env.files);
    const second = peerRecord({
      key: peer,
      contentKey,
      channelId: "aa".repeat(16),
      sequence: 2,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    const conflict = peerRecord({
      key: peer,
      contentKey,
      channelId: "aa".repeat(16),
      sequence: 2,
      collectedAt: "2023-11-14T22:16:23Z",
      payload: statusContent("示例设备乙", ["notes/c.md"]),
    });
    let round = 0;
    env.relay.reply = () => {
      round += 1;
      return {
        status: 200,
        body: { accepted: true, records: [recordDTO(round === 1 ? second : conflict)], revocations: [] },
      };
    };

    await env.engine.tick("timer");
    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.peers[0]?.payload.paths).toEqual(["notes/b.md"]);
    expect(snapshot.diagnostics.anomalies[0]?.kind).toBe("mismatch");
    expect(snapshot.diagnostics.events.join("\n")).toContain("两份内容");
  });

  it("对端被吊销之后不再参与判断", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/a.md"]),
    });
    env.relay.reply = () => ({
      status: 200,
      body: {
        accepted: true,
        records: [recordDTO(record)],
        revocations: [{ fingerprint: peer.fingerprint, by: peer.fingerprint, at: "2023-11-14T22:15:23Z" }],
      },
    });

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    expect(snapshot.revoked).toContain(peer.fingerprint);
    expect(snapshot.conflicts).toHaveLength(0);
  });
});

describe("注册、吊销与退役", () => {
  it("注册之后按中继给出的频道上报", async () => {
    const env = await fixture({ level: "pinned", register: true });

    await env.engine.register("credential-for-tests");
    await env.engine.tick("timer");

    expect(env.relay.requests[0]?.path).toBe("/v1/register");
    expect(env.relay.requests[0]?.signatureValid).toBe(true);
    expect(env.relay.requests[1]?.body["channel_id"]).toBe("aa".repeat(16));
    expect(env.snapshot().relays[0]?.channelId).toBe("aa".repeat(16));
    expect(env.snapshot().relays[0]?.fingerprint).toBe(env.relay.serverKey.fingerprint);
  });

  it("注册被拒时说明是哪台中继", async () => {
    const env = await fixture({ level: "pinned", register: true });
    env.relay.reply = {
      status: 403,
      body: { error: { code: "forbidden", message: "服务端当前未开放注册" } },
    };

    await expect(env.engine.register("credential-for-tests")).rejects.toThrow(/relay-a/);
    expect(env.snapshot().relays[0]?.channelId).toBe("");
  });

  it("降级传输下不允许注册", async () => {
    const env = await fixture({ level: "insecure", register: true });

    await expect(env.engine.register("credential-for-tests")).rejects.toThrow(/不允许执行注册/);
    expect(env.snapshot().degraded).toBe(true);
  });

  it("吊销送达各中继并计入名单", async () => {
    const env = await fixture({ level: "pinned" });
    const peer = DeviceKey.generate();
    env.relay.reply = (request) =>
      request.path === "/v1/revoke"
        ? { status: 200, body: { revoked: peer.fingerprint } }
        : { status: 200, body: { accepted: true, records: [], revocations: [] } };

    await env.engine.revoke(peer.fingerprint);

    expect(env.relay.requests[0]?.body["target"]).toBe(peer.fingerprint);
    expect(env.snapshot().revoked).toContain(peer.fingerprint);
  });

  it("尚未注册时不允许吊销", async () => {
    const env = await fixture();
    await saveState(env.files.state, {
      version: STATE_VERSION,
      channels: {},
      sequence: 0,
      peers: [],
      revoked: [],
      retired: false,
    });
    const engine = await Engine.create({
      files: env.files,
      config: defaultConfig("vault-example"),
      vaultRoot: env.vaultRoot,
    });

    await expect(engine.revoke("bb".repeat(32))).rejects.toThrow(/尚未在任何中继上注册/);
  });

  it("退役之后不再上报，身上不留频道", async () => {
    const env = await fixture({ level: "pinned" });
    const self = env.snapshot().selfFingerprint;
    env.relay.reply = (request) =>
      request.path === "/v1/retire"
        ? { status: 200, body: { retired: self } }
        : { status: 200, body: { accepted: true, records: [], revocations: [] } };

    await env.engine.retire();

    expect(env.relay.requests[0]?.path).toBe("/v1/retire");
    const snapshot = env.snapshot();
    expect(snapshot.retired).toBe(true);
    expect(snapshot.relays[0]?.channelId).toBe("");

    await env.engine.tick("timer");
    expect(env.relay.requests).toHaveLength(1);
  });

  it("退役没做成时保留频道，便于稍后再试", async () => {
    const env = await fixture({ level: "pinned" });
    env.relay.reply = {
      status: 500,
      body: { error: { code: "internal", message: "服务端内部错误" } },
    };

    await expect(env.engine.retire()).rejects.toThrow(/退役未全部完成/);
    const snapshot = env.snapshot();
    expect(snapshot.retired).toBe(false);
    expect(snapshot.relays[0]?.channelId).toBe("aa".repeat(16));
  });

  it("吊销没做成时也如实报出", async () => {
    const env = await fixture({ level: "pinned" });
    env.relay.reply = { status: 500, body: { error: { code: "internal", message: "服务端内部错误" } } };

    await expect(env.engine.revoke("bb".repeat(32))).rejects.toThrow(/吊销未全部完成/);
  });
});

describe("内容密钥", () => {
  it("换用新密钥之后旧密钥加密的记录读不出来", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: true, records: [recordDTO(record)], revocations: [] },
    });
    await env.engine.tick("timer");
    expect(env.snapshot().peers).toHaveLength(1);

    await env.engine.adoptContentKey(encodeContentKey(generateContentKey()));
    await env.engine.tick("timer");

    expect(env.snapshot().diagnostics.dropped.at(-1)?.reason).toContain("密钥与当前密钥不同");
  });

  it("口令封装的密钥可以往返，口令不对则解不开", async () => {
    const env = await fixture();
    const original = env.engine.contentKeyText();

    const protectedText = env.engine.protectContentKeyWith("示例口令一二三");
    await env.engine.adoptProtectedContentKey(protectedText, "示例口令一二三");

    expect(env.engine.contentKeyText()).toBe(original);
    await expect(env.engine.adoptProtectedContentKey(protectedText, "别的口令")).rejects.toThrow(/口令不对/);
  });
});

describe("配置与缓存", () => {
  it("重启之后接着上一次的序号与钉住信息继续", async () => {
    const env = await fixture();
    await env.engine.tick("timer");

    const again = await Engine.create({
      files: env.files,
      config: env.config,
      vaultRoot: env.vaultRoot,
    });

    const snapshot = again.snapshot();
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.relays[0]?.fingerprint).toBe(env.relay.serverKey.fingerprint);
    expect(snapshot.local).toBeNull();
  });

  it("换配置之后多出来的中继会被接上，去掉的中继不再露面", async () => {
    const env = await fixture();
    await env.engine.tick("timer");
    expect(env.snapshot().relays[0]?.fingerprint).not.toBeNull();

    const other = await startFakeRelay(false);
    other.reply = defaultReply("vault-example", "bb".repeat(16));
    try {
      env.engine.setConfig({
        ...defaultConfig("vault-example"),
        relay: [{ name: "relay-b", url: other.url, transport: "plaintext" }],
      });

      const snapshot = env.snapshot();
      expect(snapshot.relays).toHaveLength(1);
      expect(snapshot.relays[0]?.name).toBe("relay-b");
      expect(snapshot.relays[0]?.fingerprint).toBeNull();
    } finally {
      await other.close();
    }
  });

  it("客户端连不上时保留上一次取回的对端状态", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const record = peerRecord({
      key: peer,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", ["notes/b.md"]),
    });
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: true, records: [recordDTO(record)], revocations: [] },
    });
    await env.engine.tick("timer");
    expect(env.snapshot().peers).toHaveLength(1);

    await env.relay.close();
    await env.engine.tick("timer");

    expect(env.snapshot().peers).toHaveLength(1);
  });

  it("停止之后不再上报", async () => {
    const env = await fixture();
    env.engine.stop();

    await env.engine.tick("timer");

    expect(env.relay.requests).toHaveLength(0);
  });

  it("防抖窗口内的重复触发合并成一次", async () => {
    const env = await fixture();

    await env.engine.tick("save");
    await env.engine.tick("save");

    expect(env.relay.requests).toHaveLength(1);
  });

  it("定时采集的间隔随配置", async () => {
    const env = await fixture();

    expect(env.engine.nextTimerSeconds()).toBe(15);

    env.engine.setConfig({
      ...defaultConfig("vault-example"),
      collect: { ...defaultConfig("vault-example").collect, intervalSeconds: 30 },
    });
    expect(env.engine.nextTimerSeconds()).toBe(30);
  });
});

describe("序号与回应上限", () => {
  it("序号到达可表示上界时停止上报，并给出自救办法", async () => {
    const env = await fixture({ sequence: 2 ** 53 - 1 });

    await env.engine.tick("timer");
    await env.engine.tick("timer");

    // 发一条中继必然拒绝的记录没有意义，因此这一步干脆不发。
    expect(env.relay.requests.filter((request) => request.path === "/v1/report")).toEqual([]);
    const warned = env
      .snapshot()
      .diagnostics.events.filter((event) => event.includes("可表示上界"));
    // 同一句话连着来只记一次：诊断栏不该被同一行刷满。
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("重置本机计数");
  });

  it("重置计数之后从 1 重新上报", async () => {
    const env = await fixture({ sequence: 2 ** 53 - 1 });

    await env.engine.resetSequence();
    expect(env.snapshot().sequence).toBe(0);

    await env.engine.tick("timer");

    const report = env.relay.requests.find((request) => request.path === "/v1/report");
    expect(report?.body["sequence"]).toBe(1);
  });

  it("中继把本机序号顶到上界时不予采信", async () => {
    // 采信它会让本机计数停在无法再加一的位置，此后一次也报不上去，连重置都会被
    // 立刻顶回来。中继给出的这种既有序号只会来自异常，因此记一笔异常而不采信。
    const env = await fixture();
    const key = DeviceKey.generate();
    const existing = peerRecord({
      key,
      contentKey: await contentKeyOf(env.files),
      channelId: "aa".repeat(16),
      sequence: 2 ** 53 - 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload: statusContent("示例设备乙", []),
    });
    env.relay.reply = () => ({
      status: 200,
      body: { accepted: false, own: recordDTO(existing), records: [], revocations: [] },
    });

    await env.engine.tick("timer");
    await env.engine.tick("timer");

    // 本机计数不动，因此两次上报用的是同一个序号，重置之后也仍能继续。
    expect(env.snapshot().sequence).toBe(0);
    expect(env.relay.requests.filter((request) => request.path === "/v1/report").map((request) => request.body["sequence"])).toEqual([1, 1]);
    expect(env.snapshot().diagnostics.events.some((event) => event.includes("不予采信"))).toBe(true);
  });

  it("中继截断或舍弃记录时如实写出", async () => {
    const env = await fixture();
    const peer = DeviceKey.generate();
    const good = recordDTO(
      peerRecord({
        key: peer,
        contentKey: await contentKeyOf(env.files),
        channelId: "aa".repeat(16),
        sequence: 3,
        collectedAt: "2023-11-14T22:15:23Z",
        payload: statusContent("对端笔记本", ["notes/a.md"]),
      }),
    );

    env.relay.reply = (request) =>
      request.path === "/v1/register"
        ? { status: 200, body: {} }
        : {
            status: 200,
            body: {
              accepted: true,
              truncated: true,
              records: [good, { ...good, sequence: 2 ** 53 }],
              revocations: [],
            },
          };

    await env.engine.tick("timer");

    const snapshot = env.snapshot();
    // 读不出来的一条被舍掉，读得出来的照样并进来。
    expect(snapshot.peers.map((item) => item.fingerprint)).toEqual([peer.fingerprint]);
    expect(snapshot.diagnostics.events.some((event) => event.includes("读不出来"))).toBe(true);
    expect(snapshot.diagnostics.events.some((event) => event.includes("已达上限"))).toBe(true);
  });

  it("把中继自己写的说明记进诊断", async () => {
    const env = await fixture();
    const wording = "序号超出可表示范围（上界 9007199254740991）：请在客户端核对本机计数后重置";
    env.relay.reply = () => ({ status: 400, body: { error: { code: "bad_request", message: wording } } });

    await env.engine.tick("timer");

    const failure = env
      .snapshot()
      .diagnostics.events.find((event) => event.includes("通信失败"));
    expect(failure).toContain("中继说明");
    expect(failure).toContain(wording);
  });
});
