import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { responseSigningText, requestSigningText } from "../../src/core/envelope.js";
import { DeviceKey, verifySignature } from "../../src/core/identity.js";
import { encodeText } from "../../src/core/text.js";
import { selfSignedCertificate } from "./tls.js";

/** 记下来的一次请求。 */
export interface RecordedRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
  /** 请求签名是否成立。中继侧的真实校验就这一步。 */
  readonly signatureValid: boolean;
  /** 请求声明的设备指纹。 */
  readonly fingerprint: string;
}

/** 中继如何回应一次请求。 */
export interface Reply {
  readonly status: number;
  /** 回应的对象，写成 JSON 送出。 */
  readonly body?: unknown;
  /** 用另一把钥匙签名，模拟中继换了身份。 */
  readonly signedBy?: "secondary";
  /** 不给签名相关的头。 */
  readonly unsigned?: boolean;
  /** 正文改动之后仍用原正文的签名，模拟中间人替换正文。 */
  readonly tampered?: boolean;
  /** 直接给出正文原文，用于发送不是 JSON 的正文；签名照这份原文进行。 */
  readonly raw?: string;
}

/** 一台假的测试中继。 */
export interface FakeRelay {
  url: string;
  spki: string;
  readonly requests: RecordedRequest[];
  /** 中继的身份，用例可据此核对客户端钉住的值。 */
  readonly serverKey: DeviceKey;
  /** 另一把钥匙，用于模拟中继换身份。 */
  readonly otherKey: DeviceKey;
  /** 客户端所用设备的公钥，使中继能替它验签。 */
  devicePublicKey: Uint8Array | null;
  reply: Reply | ((request: RecordedRequest) => Reply);
  close: () => Promise<void>;
}

/**
 * 起一台假的测试中继。
 *
 * 它按协议核验请求签名、按协议签名回应，因此客户端是在真规则下被检验的，
 * 而不是对着一堆桩子自说自话。
 */
export async function startFakeRelay(secured: boolean): Promise<FakeRelay> {
  const serverKey = DeviceKey.generate();
  const otherKey = DeviceKey.generate();
  const requests: RecordedRequest[] = [];

  const relay: FakeRelay = {
    url: "",
    spki: "",
    requests,
    serverKey,
    otherKey,
    devicePublicKey: null,
    reply: { status: 200, body: { ok: true } },
    close: () => Promise.resolve(),
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = request.url ?? "";
      const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const headers = request.headers;

      const publicKeyValue = body["public_key"];
      const publicKey =
        typeof publicKeyValue === "string"
          ? new Uint8Array(Buffer.from(publicKeyValue, "base64"))
          : relay.devicePublicKey;
      const signatureText = requestSigningText({
        method: "POST",
        path,
        fingerprint: String(headers["x-wip-relay-fingerprint"] ?? ""),
        timestampSeconds: Number(headers["x-wip-relay-timestamp"] ?? 0),
        nonce: String(headers["x-wip-relay-nonce"] ?? ""),
        body: new Uint8Array(raw),
      });

      const record: RecordedRequest = {
        path,
        body,
        headers,
        fingerprint: String(headers["x-wip-relay-fingerprint"] ?? ""),
        signatureValid:
          publicKey !== null &&
          verifySignature(
            publicKey,
            encodeText(signatureText),
            new Uint8Array(Buffer.from(String(headers["x-wip-relay-signature"] ?? ""), "hex")),
          ),
      };
      requests.push(record);

      const decided = typeof relay.reply === "function" ? relay.reply(record) : relay.reply;
      const signed = decided.signedBy === "secondary" ? otherKey : serverKey;
      const signedBody = Buffer.from(decided.raw ?? JSON.stringify(decided.body ?? null), "utf8");
      const sentBody = decided.tampered === true ? Buffer.from("{}", "utf8") : signedBody;
      const signature = signed.sign(
        Buffer.from(
          responseSigningText({ fingerprint: signed.fingerprint, status: decided.status, body: signedBody }),
          "utf8",
        ),
      );

      const responseHeaders: Record<string, string> = { "content-type": "application/json" };
      if (decided.unsigned !== true) {
        responseHeaders["x-wip-relay-fingerprint"] = signed.fingerprint;
        responseHeaders["x-wip-relay-public-key"] = Buffer.from(signed.publicKey).toString("base64");
        responseHeaders["x-wip-relay-signature"] = Buffer.from(signature).toString("hex");
      }
      response.writeHead(decided.status, responseHeaders);
      response.end(sentBody);
    });
  };

  const certificate = secured ? selfSignedCertificate() : null;
  const server: Server =
    certificate === null
      ? createHttpServer(handler)
      : createHttpsServer({ cert: certificate.pem, key: certificate.key }, handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试中继没有拿到端口");
  }

  relay.url = `${secured ? "https" : "http"}://127.0.0.1:${String(address.port)}`;
  relay.spki = certificate?.spki ?? "";
  relay.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return relay;
}
