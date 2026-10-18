// 本模块定义请求、响应与状态记录的签名信封。
//
// 规范文本与服务端逐字节一致，因此这里的字段顺序、分隔符与时间格式都不可随意改动；
// 格式若要变更，只能另起新的版本前缀，让新旧两端各自读得懂。
import { createHash, randomBytes } from "node:crypto";

import { verifySignature, type DeviceKey } from "./identity.js";

/** 允许的时钟偏差（秒），超出即拒绝，以免陈旧请求被重放。 */
export const CLOCK_SKEW_SECONDS = 60;

/** 一次性随机值的字节数。 */
export const NONCE_BYTES = 32;

const REQUEST_CONTEXT = "waystation-request-v1";
const RESPONSE_CONTEXT = "waystation-response-v1";
const RECORD_CONTEXT = "waystation-record-v1";

/** 请求中参与签名的要素。 */
export interface RequestElements {
  readonly method: string;
  readonly path: string;
  readonly fingerprint: string;
  /** 自纪元起的秒数。 */
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly body: Uint8Array;
}

/** 响应中参与签名的要素。 */
export interface ResponseElements {
  readonly fingerprint: string;
  readonly status: number;
  readonly body: Uint8Array;
}

/** 状态记录中参与签名的要素。 */
export interface RecordElements {
  readonly fingerprint: string;
  readonly channel: string;
  readonly sequence: number;
  /** 采集时间，落盘与签名一律折算为协调世界时。 */
  readonly collectedAt: Date;
  readonly payload: Uint8Array;
}

/** 生成一次性随机值，返回其十六进制文本。 */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/** 请求的规范文本。 */
export function requestSigningText(elements: RequestElements): string {
  return [
    REQUEST_CONTEXT,
    elements.method,
    elements.path,
    elements.fingerprint,
    String(elements.timestampSeconds),
    elements.nonce,
    digestHex(elements.body),
  ].join("\n");
}

/** 请求签名。 */
export function signRequest(key: DeviceKey, elements: RequestElements): Uint8Array {
  return key.sign(Buffer.from(requestSigningText(elements), "utf8"));
}

/** 响应的规范文本。 */
export function responseSigningText(elements: ResponseElements): string {
  return [
    RESPONSE_CONTEXT,
    elements.fingerprint,
    String(elements.status),
    digestHex(elements.body),
  ].join("\n");
}

/**
 * 校验响应签名。
 *
 * 指纹与钉住值不符即视为换了服务端：此时无论签名是否成立都必须停止通信，
 * 否则「换一把钥匙再签」也会被当作有效响应。
 */
export function verifyResponse(
  pinnedFingerprint: string,
  serverPublicKey: Uint8Array,
  elements: ResponseElements,
  signature: Uint8Array,
): boolean {
  if (elements.fingerprint !== pinnedFingerprint) {
    return false;
  }
  return verifySignature(serverPublicKey, Buffer.from(responseSigningText(elements), "utf8"), signature);
}

/** 状态记录的规范文本。 */
export function recordSigningText(elements: RecordElements): string {
  return [
    RECORD_CONTEXT,
    elements.channel,
    elements.fingerprint,
    String(elements.sequence),
    formatRfc3339(elements.collectedAt),
    digestHex(elements.payload),
  ].join("\n");
}

/** 状态记录签名。 */
export function signRecord(key: DeviceKey, elements: RecordElements): Uint8Array {
  return key.sign(Buffer.from(recordSigningText(elements), "utf8"));
}

/** 校验状态记录签名，公钥取自该记录所属的设备。 */
export function verifyRecord(
  devicePublicKey: Uint8Array,
  elements: RecordElements,
  signature: Uint8Array,
): boolean {
  return verifySignature(devicePublicKey, Buffer.from(recordSigningText(elements), "utf8"), signature);
}

/**
 * 按协调世界时格式化为 RFC 3339。
 *
 * 与服务端的时间格式一字不差：不带小数秒，末尾以 Z 表示协调世界时。
 * JavaScript 的默认序列化会带上毫秒，因此这里必须自己裁掉。
 */
export function formatRfc3339(moment: Date): string {
  if (Number.isNaN(moment.getTime())) {
    throw new Error("时间无效");
  }
  return `${moment.toISOString().slice(0, 19)}Z`;
}

/** 解析 RFC 3339 时间文本。 */
export function parseRfc3339(text: string): Date {
  const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (!pattern.test(text)) {
    throw new Error(`时间文本不符合 RFC 3339：${text}`);
  }
  const moment = new Date(text);
  if (Number.isNaN(moment.getTime())) {
    throw new Error(`时间文本不符合 RFC 3339：${text}`);
  }
  return moment;
}

/** 取当前时刻，截到整秒：小数秒参与签名只会带来对不齐的风险。 */
export function nowSeconds(moment: Date = new Date()): number {
  return Math.floor(moment.getTime() / 1000);
}

/** 计算内容的 SHA-256 十六进制摘要。 */
export function digestHex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
