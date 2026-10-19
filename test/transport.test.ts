import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_BYTES, TransportError, send, spkiFingerprint } from "../src/core/transport.js";
import type { TransportLevel } from "../src/core/config.js";

/**
 * 证书解析这一步在 TLS 事件回调里执行，抛出的异常没有调用方接住，会逃逸成进程级
 * 未捕获异常。为了能固定这一处的处置方式，这里把 X509Certificate 换成可开关的替身：
 * 关着时与原生一致，打开时模拟解析失败。
 */
let breakCertificate = false;

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  class GuardedCertificate extends actual.X509Certificate {
    constructor(raw: Buffer) {
      if (breakCertificate) {
        throw new Error("证书解析失败");
      }
      super(raw);
    }
  }
  return { ...actual, X509Certificate: GuardedCertificate };
});

/** 测试用的自签证书。仓库里不放证书，用到时现场生成。 */
const certificateDir = mkdtempSync(join(tmpdir(), "vault-wip-tls-"));
const certificate = (() => {
  const keyPath = join(certificateDir, "relay.key");
  const certPath = join(certificateDir, "relay.crt");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=relay.example.com"],
    { stdio: "ignore" },
  );
  const pem = readFileSync(certPath, "utf8");
  return { pem, key: readFileSync(keyPath, "utf8"), spki: spkiFingerprint(new X509Certificate(pem).raw) };
})();

afterAll(() => {
  rmSync(certificateDir, { recursive: true, force: true });
});

/** 一台测试用的中继，记下收到的请求，并按脚本回应。 */
interface Relay {
  readonly url: string;
  readonly requests: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[];
  readonly close: () => Promise<void>;
}

/** 起一台测试中继。`reply` 决定如何回应，默认回以一段 JSON。 */
async function startRelay(options: {
  readonly secured: boolean;
  readonly reply?: (response: { status: number; body: string }) => { status: number; body: string } | "hang";
}): Promise<Relay> {
  const requests: Relay["requests"] = [];
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body, headers: request.headers });
      const decided = options.reply?.({ status: 200, body: '{"ok":true}' }) ?? { status: 200, body: '{"ok":true}' };
      if (decided === "hang") {
        return;
      }
      response.writeHead(decided.status, { "content-type": "application/json" });
      response.end(decided.body);
    });
  };

  const server: Server = options.secured
    ? createHttpsServer({ cert: certificate.pem, key: certificate.key }, handler)
    : createHttpServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试中继没有拿到端口");
  }

  return {
    url: `${options.secured ? "https" : "http"}://127.0.0.1:${String(address.port)}/v1/report`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** 发出一次请求，用例只关心地址与级别。 */
async function call(
  relay: Relay,
  level: TransportLevel,
  spki: string | null = null,
  timeoutMs?: number,
): Promise<{ status: number; body: string; spki: string | null }> {
  const response = await send({
    url: relay.url,
    level,
    spki,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"channel":"vault-example"}'),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { status: response.status, body: Buffer.from(response.body).toString("utf8"), spki: response.spki };
}

describe("send", () => {
  it("明文一级把请求原样送到", async () => {
    const relay = await startRelay({ secured: false });
    try {
      const response = await call(relay, "plaintext");

      expect(response.status).toBe(200);
      expect(response.body).toBe('{"ok":true}');
      expect(response.spki).toBeNull();
      expect(relay.requests[0]?.path).toBe("/v1/report");
      expect(relay.requests[0]?.body).toBe('{"channel":"vault-example"}');
      expect(relay.requests[0]?.headers["content-length"]).toBe("27");
    } finally {
      await relay.close();
    }
  });

  it("公开证书一级拒绝自签证书", async () => {
    const relay = await startRelay({ secured: true });
    try {
      await expect(call(relay, "https")).rejects.toThrow(TransportError);
      // 证书没通过，请求也就没有发出去。
      expect(relay.requests).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("钉住一级在指纹相符时放行，并报回观察到的指纹", async () => {
    const relay = await startRelay({ secured: true });
    try {
      const response = await call(relay, "pinned", certificate.spki);

      expect(response.status).toBe(200);
      expect(response.spki).toBe(certificate.spki);
      expect(relay.requests).toHaveLength(1);
    } finally {
      await relay.close();
    }
  });

  it("钉住一级在指纹不符时断开，且不把请求发出去", async () => {
    const relay = await startRelay({ secured: true });
    try {
      const wrong = "0".repeat(64);
      await expect(call(relay, "pinned", wrong)).rejects.toThrow(/公钥指纹与钉住的值不同/);
      expect(relay.requests).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("证书解析出错时归为证书问题，不让异常逃逸", async () => {
    const relay = await startRelay({ secured: true });
    breakCertificate = true;
    try {
      await expect(call(relay, "pinned", certificate.spki)).rejects.toMatchObject({ kind: "certificate" });
    } finally {
      breakCertificate = false;
      await relay.close();
    }
  });

  it("首次配对时没有钉住值，仍然报回指纹供记录", async () => {
    const relay = await startRelay({ secured: true });
    try {
      const response = await call(relay, "pinned", null);

      expect(response.status).toBe(200);
      expect(response.spki).toBe(certificate.spki);
    } finally {
      await relay.close();
    }
  });

  it("忽略证书一级不问指纹", async () => {
    const relay = await startRelay({ secured: true });
    try {
      const response = await call(relay, "insecure");

      expect(response.status).toBe(200);
      expect(response.spki).toBe(certificate.spki);
    } finally {
      await relay.close();
    }
  });

  it("把中继给出的状态码与正文交给调用方", async () => {
    const relay = await startRelay({
      secured: false,
      reply: () => ({ status: 429, body: '{"error":"limit"}' }),
    });
    try {
      const response = await call(relay, "plaintext");

      expect(response.status).toBe(429);
      expect(response.body).toBe('{"error":"limit"}');
    } finally {
      await relay.close();
    }
  });

  it("中继不回应时报超时", async () => {
    const relay = await startRelay({ secured: false, reply: () => "hang" });
    try {
      await expect(call(relay, "plaintext", null, 200)).rejects.toThrow(/超时/);
    } finally {
      await relay.close();
    }
  });

  it("回应过长时断开", async () => {
    const relay = await startRelay({
      secured: false,
      reply: () => ({ status: 200, body: "x".repeat(MAX_RESPONSE_BYTES + 1) }),
    });
    try {
      await expect(call(relay, "plaintext")).rejects.toThrow(/超过上限/);
    } finally {
      await relay.close();
    }
  });

  it("级别与地址协议不符时当场拒绝", async () => {
    const relay = await startRelay({ secured: false });
    try {
      await expect(call(relay, "pinned", null)).rejects.toThrow(/地址却是 http/);
      await expect(call(relay, "https")).rejects.toThrow(/地址却是 http/);
    } finally {
      await relay.close();
    }
  });

  it("明文一级不接受 https 地址，也没有证书可钉", async () => {
    const relay = await startRelay({ secured: true });
    try {
      await expect(call(relay, "plaintext")).rejects.toThrow(/地址却是 https/);
      await expect(call(relay, "plaintext", certificate.spki)).rejects.toThrow(/地址却是 https/);
    } finally {
      await relay.close();
    }
  });

  it("拒绝 http 与 https 之外的地址", async () => {
    await expect(
      send({
        url: "ftp://relay.example.com/v1/report",
        level: "https",
        spki: null,
        method: "POST",
        headers: {},
        body: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/协议只能是 http 或 https/);
  });

  it("联系不上时归为网络问题", async () => {
    // 端口 1 上不会有中继。
    await expect(
      send({
        url: "http://127.0.0.1:1/v1/report",
        level: "plaintext",
        spki: null,
        method: "POST",
        headers: {},
        body: Buffer.alloc(0),
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(TransportError);
  });
});
