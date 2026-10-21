import { describe, expect, it } from "vitest";

import { DeviceKey } from "../src/core/identity.js";
import { RelayClient, RelayError, joinUrl } from "../src/core/relay.js";
import type { TransportLevel } from "../src/core/config.js";
import type { RelayPin } from "../src/core/storage.js";
import { startFakeRelay } from "./helpers/relay-server.js";

/** 建一个指向测试中继的客户端。 */
function clientFor(
  relay: { url: string },
  options: {
    readonly level?: TransportLevel;
    readonly key?: DeviceKey;
    readonly pin?: RelayPin | null;
    readonly name?: string;
  } = {},
): RelayClient {
  return new RelayClient({
    name: options.name ?? "relay-a",
    url: relay.url,
    level: options.level ?? "insecure",
    key: options.key ?? DeviceKey.generate(),
    pin: options.pin ?? null,
  });
}

/** 一段记录内容，测试里只关心它被原样搬运。 */
const payload = new Uint8Array([1, 2, 3]);

describe("joinUrl", () => {
  it("拼出一个端点地址，不重复斜杠", () => {
    expect(joinUrl("https://relay.example.com:8787", "/v1/report")).toBe(
      "https://relay.example.com:8787/v1/report",
    );
    expect(joinUrl("https://relay.example.com:8787/", "/v1/report")).toBe(
      "https://relay.example.com:8787/v1/report",
    );
  });
});

describe("注册", () => {
  it("带上公钥，并取回频道", async () => {
    const relay = await startFakeRelay(true);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { channel_id: "aa".repeat(16), channel_alias: "vault-example" } };

      const client = clientFor(relay, { level: "pinned", key });
      const channel = await client.register({ alias: "vault-example", channelId: "", channelToken: "", credential: "credential-for-tests" });

      expect(channel).toEqual({ channelId: "aa".repeat(16), channelAlias: "vault-example", channelToken: "" });
      expect(relay.requests[0]?.path).toBe("/v1/register");
      expect(relay.requests[0]?.signatureValid).toBe(true);
      expect(relay.requests[0]?.body["public_key"]).toBe(Buffer.from(key.publicKey).toString("base64"));
      expect(relay.requests[0]?.fingerprint).toBe(key.fingerprint);
    } finally {
      await relay.close();
    }
  });

  it("首次接触就把中继公钥与证书指纹一并钉住", async () => {
    const relay = await startFakeRelay(true);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { channel_id: "aa".repeat(16), channel_alias: "vault-example" } };

      const client = clientFor(relay, { level: "pinned", key });
      await client.register({ alias: "vault-example", channelId: "", channelToken: "", credential: "credential-for-tests" });

      expect(client.pinned?.serverFingerprint).toBe(relay.serverKey.fingerprint);
      expect(client.pinned?.serverPublicKey).toBe(Buffer.from(relay.serverKey.publicKey).toString("base64"));
      expect(client.pinned?.spki).toBe(relay.spki);
    } finally {
      await relay.close();
    }
  });

  it("降级一级不记证书指纹，只钉公钥", async () => {
    const relay = await startFakeRelay(true);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [] } };

      const client = clientFor(relay, { level: "insecure", key });
      await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(client.pinned?.serverFingerprint).toBe(relay.serverKey.fingerprint);
      expect(client.pinned?.spki).toBe("");
    } finally {
      await relay.close();
    }
  });

  it("降级传输下拒绝注册", async () => {
    const relay = await startFakeRelay(false);
    try {
      const client = clientFor(relay, { level: "plaintext" });

      await expect(client.register({ alias: "vault-example", channelId: "", channelToken: "", credential: "credential-for-tests" })).rejects.toThrow(
        /不允许执行注册/,
      );
      expect(relay.requests).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("回应里缺少频道信息时给出提示", async () => {
    const relay = await startFakeRelay(false);
    try {
      relay.reply = { status: 200, body: { channel_alias: "vault-example" } };
      const client = clientFor(relay, { level: "plaintext" });

      await expect(client.register({ alias: "vault-example", channelId: "", channelToken: "", credential: "credential-for-tests" })).rejects.toThrow(/注册/);
    } finally {
      await relay.close();
    }
  });
});

describe("上报", () => {
  it("把内容与签名送出去，取回对端记录与吊销名单", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      const peer = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          records: [
            {
              fingerprint: peer.fingerprint,
              public_key: Buffer.from(peer.publicKey).toString("base64"),
              sequence: 4,
              collected_at: "2023-11-14T22:15:23Z",
              payload: Buffer.from(payload).toString("base64"),
              signature: Buffer.alloc(64, 7).toString("base64"),
            },
          ],
          revocations: [{ fingerprint: peer.fingerprint, by: key.fingerprint, at: "2023-11-14T22:15:23Z" }],
        },
      };

      const client = clientFor(relay, { level: "plaintext", key });
      const reply = await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(relay.requests[0]?.signatureValid).toBe(true);
      expect(relay.requests[0]?.body["channel_id"]).toBe("aa".repeat(16));
      expect(relay.requests[0]?.body["sequence"]).toBe(1);
      expect(relay.requests[0]?.body["payload"]).toBe(Buffer.from(payload).toString("base64"));
      expect(reply.accepted).toBe(true);
      expect(reply.own).toBeNull();
      expect(reply.records[0]?.fingerprint).toBe(peer.fingerprint);
      expect(reply.records[0]?.sequence).toBe(4);
      expect(reply.records[0]?.payload).toEqual(payload);
      expect(reply.revocations[0]?.by).toBe(key.fingerprint);
      expect(reply.pin.serverFingerprint).toBe(relay.serverKey.fingerprint);
    } finally {
      await relay.close();
    }
  });

  it("被拒时带回本设备既有记录", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = {
        status: 200,
        body: {
          accepted: false,
          own: {
            fingerprint: key.fingerprint,
            public_key: Buffer.from(key.publicKey).toString("base64"),
            sequence: 9,
            collected_at: "2023-11-14T22:15:23Z",
            payload: Buffer.from("既有").toString("base64"),
            signature: Buffer.alloc(64, 3).toString("base64"),
          },
          records: [],
          revocations: [],
        },
      };

      const client = clientFor(relay, { level: "plaintext", key });
      const reply = await client.report({
        channelId: "aa".repeat(16),
        sequence: 2,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(reply.accepted).toBe(false);
      expect(reply.own?.sequence).toBe(9);
      expect(Buffer.from(reply.own?.payload ?? []).toString("utf8")).toBe("既有");
    } finally {
      await relay.close();
    }
  });

  it("回应的记录公钥与指纹不符时不予采用", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      const peer = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          records: [
            {
              fingerprint: key.fingerprint,
              public_key: Buffer.from(peer.publicKey).toString("base64"),
              sequence: 4,
              collected_at: "2023-11-14T22:15:23Z",
              payload: Buffer.from(payload).toString("base64"),
              signature: Buffer.alloc(64, 7).toString("base64"),
            },
          ],
          revocations: [],
        },
      };

      const client = clientFor(relay, { level: "plaintext", key });
      const reply = await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(reply.records).toEqual([]);
      expect(reply.skipped[0]).toMatch(/公钥与设备指纹不符/);
    } finally {
      await relay.close();
    }
  });

  it("回应的形状不合规时给出提示", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      const client = clientFor(relay, { level: "plaintext", key });
      const input = {
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      };

      relay.reply = { status: 200, body: { records: [], revocations: [] } };
      await expect(client.report(input)).rejects.toThrow(/没有说明上报是否被接受/);

      relay.reply = { status: 200, body: { accepted: true, records: "×", revocations: [] } };
      await expect(client.report(input)).rejects.toThrow(/记录清单不是数组/);

      relay.reply = { status: 200, body: { accepted: true, records: [1], revocations: [] } };
      expect((await client.report(input)).skipped[0]).toMatch(/不是一个对象/);

      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          records: [
            {
              fingerprint: "aa",
              public_key: Buffer.from(key.publicKey).toString("base64"),
              sequence: 1,
              collected_at: "2023-11-14T22:15:23Z",
              payload: Buffer.from(payload).toString("base64"),
              signature: Buffer.alloc(64).toString("base64"),
            },
          ],
          revocations: [],
        },
      };
      expect((await client.report(input)).skipped[0]).toMatch(/公钥与设备指纹不符/);

      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: "×" } };
      await expect(client.report(input)).rejects.toThrow(/吊销名单不是数组/);

      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [1] } };
      expect((await client.report(input)).skipped[0]).toMatch(/吊销记录不是一个对象/);

      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          records: [
            {
              fingerprint: key.fingerprint,
              public_key: Buffer.from(key.publicKey).toString("base64"),
              sequence: -1,
              collected_at: "2023-11-14T22:15:23Z",
              payload: Buffer.from(payload).toString("base64"),
              signature: Buffer.alloc(64).toString("base64"),
            },
          ],
          revocations: [],
        },
      };
      expect((await client.report(input)).skipped[0]).toMatch(/记录序号不合规/);

      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          records: [
            {
              fingerprint: key.fingerprint,
              public_key: Buffer.from(key.publicKey).toString("base64"),
              sequence: 1,
              collected_at: "2023-11-14T22:15:23Z",
              payload: "",
              signature: Buffer.alloc(64).toString("base64"),
            },
          ],
          revocations: [],
        },
      };
      expect((await client.report(input)).skipped[0]).toMatch(/记录内容是空的/);
    } finally {
      await relay.close();
    }
  });

  it("一条读不出来的记录不牵连其余记录", async () => {
    // 中继上只要有一台设备写进越界或不成形的记录，整批作废就会让同频道其他设备
    // 永远同步不到任何状态；舍弃的范围必须只限这一条，且逐条说明原因。
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      const peer = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      const client = clientFor(relay, { level: "plaintext", key });
      const record = {
        fingerprint: peer.fingerprint,
        public_key: Buffer.from(peer.publicKey).toString("base64"),
        sequence: 7,
        collected_at: "2023-11-14T22:15:23Z",
        payload: Buffer.from(payload).toString("base64"),
        signature: Buffer.alloc(64).toString("base64"),
      };
      relay.reply = {
        status: 200,
        body: {
          accepted: true,
          truncated: true,
          own: { sequence: 9007199254740993 },
          records: [
            record,
            { ...record, fingerprint: "aa", sequence: 1 },
            { ...record, sequence: 9007199254740993 },
          ],
          revocations: [],
        },
      };

      const reply = await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(reply.records.map((item) => item.fingerprint)).toEqual([peer.fingerprint]);
      expect(reply.truncated).toBe(true);
      expect(reply.own).toBeNull();
      expect(reply.skipped).toHaveLength(3);
    } finally {
      await relay.close();
    }
  });

  it("一条读不出来的吊销纪录不牵连其余条目", async () => {
    // 吊销名单同样只舍弃读不出来的那一条：整份作废会让同频道的对端一直看不到
    // 其余吊销纪录，而被丢掉的往往只是一条本就可疑的条目。
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      const peer = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      const client = clientFor(relay, { level: "plaintext", key });
      const good = { fingerprint: peer.fingerprint, by: key.fingerprint, at: "2023-11-14T22:15:23Z" };
      relay.reply = {
        status: 200,
        body: { accepted: true, records: [], revocations: [1, good, { fingerprint: peer.fingerprint }] },
      };

      const reply = await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      expect(reply.revocations.map((item) => item.fingerprint)).toEqual([peer.fingerprint]);
      expect(reply.skipped).toHaveLength(2);
      expect(reply.skipped[0]).toMatch(/吊销记录不是一个对象/);
      expect(reply.skipped[1]).toMatch(/缺少吊销记录中的发起设备/);
    } finally {
      await relay.close();
    }
  });
});

describe("吊销与退役", () => {
  it("吊销带上目标指纹", async () => {
    const relay = await startFakeRelay(true);
    try {
      const key = DeviceKey.generate();
      const target = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { revoked: target.fingerprint } };

      const client = clientFor(relay, { level: "pinned", key });
      const revoked = await client.revoke("aa".repeat(16), target.fingerprint);

      expect(revoked).toBe(target.fingerprint);
      expect(relay.requests[0]?.path).toBe("/v1/revoke");
      expect(relay.requests[0]?.body["target"]).toBe(target.fingerprint);
      expect(relay.requests[0]?.signatureValid).toBe(true);
    } finally {
      await relay.close();
    }
  });

  it("退役只带频道标识", async () => {
    const relay = await startFakeRelay(true);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { retired: key.fingerprint } };

      const client = clientFor(relay, { level: "pinned", key });
      const retired = await client.retire("aa".repeat(16));

      expect(retired).toBe(key.fingerprint);
      expect(relay.requests[0]?.path).toBe("/v1/retire");
    } finally {
      await relay.close();
    }
  });

  it("降级传输下吊销与退役都被拒", async () => {
    const relay = await startFakeRelay(false);
    try {
      const client = clientFor(relay, { level: "plaintext" });

      await expect(client.revoke("aa".repeat(16), "bb".repeat(32))).rejects.toThrow(/不允许执行吊销/);
      await expect(client.retire("aa".repeat(16))).rejects.toThrow(/不允许执行退役/);
      expect(relay.requests).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("中继给出的退役对象缺失时给出提示", async () => {
    const relay = await startFakeRelay(true);
    try {
      relay.reply = { status: 200, body: {} };
      const client = clientFor(relay, { level: "pinned" });

      await expect(client.retire("aa".repeat(16))).rejects.toThrow(/缺少退役的设备指纹/);
    } finally {
      await relay.close();
    }
  });
});

describe("回应的核对", () => {
  it("中继换了公钥就停止通信", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [] } };
      const client = clientFor(relay, { level: "plaintext", key });
      await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      relay.reply = { status: 200, body: { ok: true }, signedBy: "secondary" };
      await expect(
        client.report({
          channelId: "aa".repeat(16),
          sequence: 2,
          collectedAt: "2023-11-14T22:15:23Z",
          payload,
          signature: new Uint8Array(64),
        }),
      ).rejects.toThrow(/公钥指纹与钉住的值不同/);
    } finally {
      await relay.close();
    }
  });

  it("正文被替换时签名核不过", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [] } };
      const client = clientFor(relay, { level: "plaintext", key });
      await client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      });

      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [] }, tampered: true };
      await expect(
        client.report({
          channelId: "aa".repeat(16),
          sequence: 2,
          collectedAt: "2023-11-14T22:15:23Z",
          payload,
          signature: new Uint8Array(64),
        }),
      ).rejects.toThrow(/签名核不过/);
    } finally {
      await relay.close();
    }
  });

  it("没有签名的回应一律不收", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, body: { accepted: true, records: [], revocations: [] }, unsigned: true };

      const client = clientFor(relay, { level: "plaintext", key });
      await expect(
        client.report({
          channelId: "aa".repeat(16),
          sequence: 1,
          collectedAt: "2023-11-14T22:15:23Z",
          payload,
          signature: new Uint8Array(64),
        }),
      ).rejects.toThrow(/回应没有签名/);
    } finally {
      await relay.close();
    }
  });

  it("回应正文不是 JSON 时如实报错", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 200, raw: "<html>坏了</html>" };

      const client = clientFor(relay, { level: "plaintext", key });
      await expect(
        client.report({
          channelId: "aa".repeat(16),
          sequence: 1,
          collectedAt: "2023-11-14T22:15:23Z",
          payload,
          signature: new Uint8Array(64),
        }),
      ).rejects.toThrow(/正文不是合法的 JSON/);
    } finally {
      await relay.close();
    }
  });
});

describe("中继的拒绝", () => {
  /** 用一次上报来触发拒绝：上报在降级传输下也允许，便于直接观察错误映射。 */
  async function reportOnce(client: RelayClient): Promise<void> {
    await client.report({
      channelId: "aa".repeat(16),
      sequence: 1,
      collectedAt: "2023-11-14T22:15:23Z",
      payload,
      signature: new Uint8Array(64),
    });
  }

  it("按错误代码给出说法，并留下原文供诊断", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = {
        status: 403,
        body: { error: { code: "forbidden", message: "服务端当前未开放注册" } },
      };

      const client = clientFor(relay, { level: "plaintext", key });
      let caught: unknown;
      try {
        await reportOnce(client);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RelayError);
      const failure = caught as RelayError;
      expect(failure.kind).toBe("server");
      expect(failure.message).toContain("中继不允许这次操作");
      expect(failure.detail.code).toBe("forbidden");
      expect(failure.detail.serverMessage).toBe("服务端当前未开放注册");
      expect(failure.detail.status).toBe(403);
    } finally {
      await relay.close();
    }
  });

  it("不认识的错误代码也如实报出", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 400, body: { error: { code: "怪事", message: "说明" } } };

      const client = clientFor(relay, { level: "plaintext", key });
      await expect(reportOnce(client)).rejects.toThrow(/怪事/);
    } finally {
      await relay.close();
    }
  });

  it("拒绝的正文不是 JSON 时只留状态码", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 500, raw: "<html>坏了</html>" };

      const client = clientFor(relay, { level: "plaintext", key });
      await expect(reportOnce(client)).rejects.toThrow(/未给出代码/);
    } finally {
      await relay.close();
    }
  });

  it("拒绝的正文是 JSON 但不是错误外形时也只留状态码", async () => {
    const relay = await startFakeRelay(false);
    try {
      const key = DeviceKey.generate();
      relay.devicePublicKey = key.publicKey;
      relay.reply = { status: 500, body: { report: "缺少 error 一节" } };

      const client = clientFor(relay, { level: "plaintext", key });
      await expect(reportOnce(client)).rejects.toThrow(/未给出代码/);
    } finally {
      await relay.close();
    }
  });

  it("连不上时归为通信失败", async () => {
    const key = DeviceKey.generate();
    const client = new RelayClient({
      name: "relay-a",
      url: "http://127.0.0.1:1",
      level: "plaintext",
      key,
      pin: null,
    });

    await expect(
      client.report({
        channelId: "aa".repeat(16),
        sequence: 1,
        collectedAt: "2023-11-14T22:15:23Z",
        payload,
        signature: new Uint8Array(64),
      }),
    ).rejects.toThrow(RelayError);
  });
});
