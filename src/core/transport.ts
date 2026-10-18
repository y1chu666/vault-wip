// 本模块把协议里的四级传输落到实处。
//
// 一级与二级都要求证书，二级另外比对钉住的证书公钥指纹；三级忽略证书错误，
// 四级干脆不加密，后两级属于降级，只有配置里显式写出才会走到。这里不做降级
// 尝试：配置写的是哪一级就走哪一级，走不通就报错，免得看着像加密通信而实际不是。
//
// 钉住一级在握手完成后、发出请求之前核对证书指纹：核对不通过就连请求都不发出去，
// 否则签过名的请求已经交到了对手手上，再断开也没有意义。
import { createHash, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";

import type { TransportLevel } from "./config.js";

/** 回应的长度上限，超出即断开：中继失控时不该把插件一起拖垮。 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 默认的超时时间（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 一次请求。 */
export interface TransportRequest {
  /** 完整地址。 */
  readonly url: string;
  readonly level: TransportLevel;
  /**
   * 该中继证书的 SPKI 指纹（小写十六进制）。
   *
   * 为空表示尚未钉住：属于首次配对，此时接受对方的证书并把观察到的指纹报回去。
   */
  readonly spki: string | null;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs?: number;
}

/** 一次回应。 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** 本次连接观察到的证书 SPKI 指纹；明文一级为空。 */
  readonly spki: string | null;
}

/** 请求没有完成。 */
export class TransportError extends Error {
  constructor(
    readonly kind: "network" | "timeout" | "certificate" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** 发出一次请求。任何未到达「拿到完整回应」的情形都以 {@link TransportError} 抛出。 */
export async function send(request: TransportRequest): Promise<TransportResponse> {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TransportError("protocol", `地址的协议只能是 http 或 https：${request.url}`);
  }

  const secured = url.protocol === "https:";
  if (request.level === "plaintext" && secured) {
    throw new TransportError("protocol", "配置为明文传输，地址却是 https");
  }
  if (request.level !== "plaintext" && !secured) {
    throw new TransportError("protocol", "配置要求加密传输，地址却是 http");
  }
  if (request.spki !== null && !secured) {
    throw new TransportError("protocol", "明文传输没有证书可钉");
  }

  const body = Buffer.from(request.body);
  const options: RequestOptions = {
    method: request.method,
    headers: { ...request.headers, "content-length": String(body.length) },
    // 不复用连接：每台中继的证书校验方式各不相同，复用容易把甲中继的连接用到乙上。
    agent: false,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (request.level === "pinned" || request.level === "insecure") {
    // 不交给 Node 校验链，改为在下面自己比对指纹，或干脆接受（降级一级）。
    options.rejectUnauthorized = false;
  }

  return await new Promise<TransportResponse>((resolve, reject) => {
    let observed: string | null = null;
    const start = secured ? httpsRequest : httpRequest;
    const outgoing = start(url, options, (response) => {
      collect(response, observed, resolve, reject);
    });

    outgoing.on("error", (error: unknown) => {
      reject(classify(error));
    });
    outgoing.on("timeout", () => {
      outgoing.destroy(new TransportError("timeout", "等待中继回应超时"));
    });

    if (secured) {
      outgoing.on("socket", (socket) => {
        const tls = socket as TLSSocket;
        tls.on("secureConnect", () => {
          const certificate = tls.getPeerCertificate(true);
          if (certificate.raw === undefined) {
            if (request.level === "pinned") {
              outgoing.destroy(new TransportError("certificate", "对方没有给出证书"));
            }
            return;
          }
          observed = spkiFingerprint(certificate.raw);
          if (request.level === "pinned" && request.spki !== null && observed !== request.spki) {
            outgoing.destroy(
              new TransportError("certificate", `中继证书的公钥指纹与钉住的值不同：${observed}`),
            );
          }
        });
      });
    }

    outgoing.end(body);
  });
}

/** 读出回应正文，并按上限截住失控的回应。 */
function collect(
  response: IncomingMessage,
  observed: string | null,
  resolve: (value: TransportResponse) => void,
  reject: (reason: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let length = 0;

  response.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length > MAX_RESPONSE_BYTES) {
      response.destroy(new TransportError("protocol", "中继的回应超过上限"));
      return;
    }
    chunks.push(chunk);
  });
  response.on("error", (error: unknown) => {
    reject(classify(error));
  });
  response.on("end", () => {
    resolve({
      status: response.statusCode ?? 0,
      headers: normalizeHeaders(response.headers),
      body: Buffer.concat(chunks),
      spki: observed,
    });
  });
}

/** 计算证书的 SPKI 指纹：取证书里公钥部分的摘要，与签发者无关。 */
export function spkiFingerprint(der: Uint8Array): string {
  const certificate = new X509Certificate(Buffer.from(der));
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

/**
 * 把底层错误归为网络或证书问题。
 *
 * 分辨两者不是为了措辞：证书问题说明对面可能被人冒充，值得单独提示，
 * 而网络不通只说明当下联系不上。
 */
function classify(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (CERTIFICATE_CODES.has(code) || code.startsWith("ERR_TLS_CERT"))) {
    return new TransportError("certificate", `证书校验未通过（${code}）`);
  }
  return new TransportError("network", messageOf(error));
}

/** Node 在证书链校验失败时给出的错误码。 */
const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
