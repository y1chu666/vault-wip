// 本模块是插件与一台中继之间的对话：把请求签好发出去，把回应验过再交给上层。
//
// 中继的公钥在首次接触时钉住，此后指纹或公钥一变就停止通信：对面换了一把钥匙，
// 说明它不再是我们认识的那台中继，此时继续对话毫无意义。中继给出的文案不可信，
// 因此判断一律依据错误代码，文案只在诊断里原样呈现。
import { isDegraded, type TransportLevel } from "./config.js";
import { newNonce, nowSeconds, signRequest, verifyResponse } from "./envelope.js";
import { t, type MessageKey } from "./i18n.js";
import { fingerprintOf, parseFingerprint, type DeviceKey } from "./identity.js";
import { decodeText, encodeText } from "./text.js";
import { send, TransportError } from "./transport.js";
import type { RelayPin } from "./storage.js";

/** 各端点的路径。签名覆盖路径，因此这里的取值必须与服务端一模一样。 */
export const REQUEST_PATHS = {
  register: "/v1/register",
  report: "/v1/report",
  revoke: "/v1/revoke",
  retire: "/v1/retire",
} as const;

/** 失败原因的分类。 */
export type RelayErrorKind =
  /** 连不上、超时、回应不合规。 */
  | "transport"
  /** 回应的签名核不过。 */
  | "signature"
  /** 钉住的公钥与对面给的不符。 */
  | "pin"
  /** 中继按错误代码拒绝了请求。 */
  | "server";

/** 与一台中继通信失败。 */
export class RelayError extends Error {
  constructor(
    readonly kind: RelayErrorKind,
    message: string,
    readonly detail: {
      /** 中继给出的错误代码，没有则为空。 */
      readonly code?: string;
      readonly status?: number;
      /** 中继自己写的说明，只作诊断留痕，不据此判断。 */
      readonly serverMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/** 频道信息。 */
export interface RelayChannel {
  readonly channelId: string;
  readonly channelAlias: string;
}

/** 一条对端记录。 */
export interface PeerRecord {
  readonly fingerprint: string;
  /** 该设备的公钥，用于核对记录签名。 */
  readonly publicKey: Uint8Array;
  readonly sequence: number;
  readonly collectedAt: string;
  /** 端到端加密后的内容。 */
  readonly payload: Uint8Array;
  readonly signature: Uint8Array;
}

/** 一条吊销记录。 */
export interface RevocationRecord {
  readonly fingerprint: string;
  readonly by: string;
  readonly at: string;
}

/** 一次上报的回应。 */
export interface ReportReply {
  readonly accepted: boolean;
  /** 本设备既有记录；仅在上报被拒时给出。 */
  readonly own: PeerRecord | null;
  readonly records: readonly PeerRecord[];
  readonly revocations: readonly RevocationRecord[];
  /** 中继是否因大小或条数上限截断了记录清单：截断时本次视图不完整。 */
  readonly truncated: boolean;
  /** 读不出来而放弃的记录，逐条附原因，只作诊断留痕。 */
  readonly skipped: readonly string[];
  /** 本次通信后应当记下的钉住信息。 */
  readonly pin: RelayPin;
}

/** 一台中继的客户端。 */
export class RelayClient {
  private pin: RelayPin | null;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      readonly name: string;
      readonly url: string;
      readonly level: TransportLevel;
      readonly pin: RelayPin | null;
      readonly key: DeviceKey;
      readonly timeoutMs?: number;
      readonly now?: () => Date;
    },
  ) {
    this.pin = options.pin;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.now = options.now ?? (() => new Date());
  }

  /** 中继名称。 */
  get name(): string {
    return this.options.name;
  }

  /** 中继地址。 */
  get url(): string {
    return this.options.url;
  }

  /** 传输级别。 */
  get level(): TransportLevel {
    return this.options.level;
  }

  /** 是否处于降级传输：降级时禁止注册、吊销与退役。 */
  get degraded(): boolean {
    return isDegraded(this.options.level);
  }

  /** 当前钉住的公钥信息；首次配对之后才有值。 */
  get pinned(): RelayPin | null {
    return this.pin;
  }

  /** 注册本设备，取得频道。注册属于破坏性操作，降级传输下不做。 */
  async register(channel: string, credential: string): Promise<RelayChannel> {
    this.refuseWhenDegraded("{relay}：当前传输级别属于降级，不允许执行注册");
    const reply = await this.call<{ channel_id?: unknown; channel_alias?: unknown }>(REQUEST_PATHS.register, {
      channel,
      credential,
      public_key: Buffer.from(this.options.key.publicKey).toString("base64"),
    });
    return {
      channelId: readString(reply.channel_id, t("频道标识")),
      channelAlias: readString(reply.channel_alias, t("频道别名")),
    };
  }

  /** 上报本设备状态，并取回频道内其他设备的记录。 */
  async report(input: {
    readonly channelId: string;
    readonly sequence: number;
    readonly collectedAt: string;
    readonly payload: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<ReportReply> {
    const reply = await this.call<{
      accepted?: unknown;
      own?: unknown;
      records?: unknown;
      revocations?: unknown;
      truncated?: unknown;
    }>(REQUEST_PATHS.report, {
      channel_id: input.channelId,
      sequence: input.sequence,
      collected_at: input.collectedAt,
      payload: Buffer.from(input.payload).toString("base64"),
      signature: Buffer.from(input.signature).toString("base64"),
    });

    if (typeof reply.accepted !== "boolean") {
      throw new RelayError("transport", t("中继的回应里没有说明上报是否被接受"));
    }

    const skipped: string[] = [];
    const own =
      reply.own === undefined || reply.own === null
        ? null
        : readRecordOrNull(reply.own, skipped, t("本设备的记录"));

    return {
      accepted: reply.accepted,
      own,
      records: readRecords(reply.records, skipped),
      revocations: readRevocations(reply.revocations, skipped),
      truncated: reply.truncated === true,
      skipped,
      pin: this.requirePin(),
    };
  }

  /** 吊销同一频道内的另一台设备。属于破坏性操作，降级传输下不做。 */
  async revoke(channelId: string, target: string): Promise<string> {
    this.refuseWhenDegraded("{relay}：当前传输级别属于降级，不允许执行吊销");
    const reply = await this.call<{ revoked?: unknown }>(REQUEST_PATHS.revoke, {
      channel_id: channelId,
      target,
    });
    return readString(reply.revoked, t("被吊销的设备指纹"));
  }

  /** 本设备退役：删除本设备在中继上的数据，并记入吊销名单。属于破坏性操作。 */
  async retire(channelId: string): Promise<string> {
    this.refuseWhenDegraded("{relay}：当前传输级别属于降级，不允许执行退役");
    const reply = await this.call<{ retired?: unknown }>(REQUEST_PATHS.retire, {
      channel_id: channelId,
    });
    return readString(reply.retired, t("退役的设备指纹"));
  }

  /** 发出一次带签名的请求，并核对回应。 */
  private async call<T extends Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    const url = joinUrl(this.options.url, path);
    const bytes = encodeText(JSON.stringify(body));
    const timestampSeconds = nowSeconds(this.now());
    const nonce = newNonce();
    const fingerprint = this.options.key.fingerprint;
    const signature = signRequest(this.options.key, {
      method: "POST",
      path: new URL(url).pathname,
      fingerprint,
      timestampSeconds,
      nonce,
      body: bytes,
    });

    let response;
    try {
      response = await send({
        url,
        level: this.options.level,
        spki: this.pin?.spki === "" ? null : (this.pin?.spki ?? null),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-waystation-fingerprint": fingerprint,
          "x-waystation-timestamp": String(timestampSeconds),
          "x-waystation-nonce": nonce,
          "x-waystation-signature": Buffer.from(signature).toString("hex"),
        },
        body: bytes,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new RelayError("transport", `${this.describe()}：${error.message}`);
      }
      throw error;
    }

    this.verify(response, response.body);

    if (response.status !== 200) {
      throw this.serverError(response.status, response.body);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(response.body));
    } catch {
      throw new RelayError("transport", t("{relay}：回应的正文不是合法的 JSON", { relay: this.describe() }));
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RelayError("transport", t("{relay}：回应的正文不是一个对象", { relay: this.describe() }));
    }
    return parsed as T;
  }

  /**
   * 核对回应签名，并记下或比对中继公钥。
   *
   * 首次接触时手里没有公钥，只能先收下并钉住，这是首次配对绕不开的一步；
   * 界面会把指纹显示出来，供使用者与服务端那边核对。
   */
  private verify(
    response: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly spki: string | null },
    body: Uint8Array,
  ): void {
    const fingerprint = response.headers["x-waystation-fingerprint"];
    const publicKeyBase64 = response.headers["x-waystation-public-key"];
    const signatureHex = response.headers["x-waystation-signature"];
    if (fingerprint === undefined || publicKeyBase64 === undefined || signatureHex === undefined) {
      throw new RelayError("transport", t("{relay}：回应没有签名", { relay: this.describe() }));
    }

    if (!/^[0-9a-f]{128}$/.test(signatureHex)) {
      throw new RelayError("transport", t("{relay}：回应签名的编码不合规", { relay: this.describe() }));
    }
    const signature = Buffer.from(signatureHex, "hex");

    let publicKey: Uint8Array;
    let parsedFingerprint: string;
    try {
      publicKey = new Uint8Array(Buffer.from(publicKeyBase64, "base64"));
      parsedFingerprint = parseFingerprint(fingerprint);
    } catch (error) {
      throw new RelayError(
        "transport",
        t("{relay}：回应里的公钥或指纹不合规", { relay: this.describe() }),
        {
        serverMessage: messageOf(error),
      });
    }
    if (publicKey.length !== 32 || fingerprintOf(publicKey) !== parsedFingerprint) {
      throw new RelayError("transport", t("{relay}：回应里的公钥与指纹不符", { relay: this.describe() }));
    }

    if (this.pin === null) {
      // 首次配对：收下公钥并钉住。
      this.pin = {
        serverFingerprint: parsedFingerprint,
        serverPublicKey: publicKeyBase64,
        spki: this.options.level === "pinned" ? (response.spki ?? "") : "",
      };
    } else {
      if (this.pin.serverFingerprint !== parsedFingerprint) {
        throw new RelayError(
          "pin",
          t("{relay}：中继的公钥指纹与钉住的值不同，已停止通信，请重新核对后再配对", {
            relay: this.describe(),
          }),
          { serverMessage: parsedFingerprint },
        );
      }
      const accepted = verifyResponse(
        this.pin.serverFingerprint,
        new Uint8Array(Buffer.from(this.pin.serverPublicKey, "base64")),
        { fingerprint: parsedFingerprint, status: response.status, body },
        signature,
      );
      if (!accepted) {
        throw new RelayError(
          "signature",
          t("{relay}：回应的签名核不过，可能有人在中间改动", { relay: this.describe() }),
        );
      }
    }

    if (this.options.level === "pinned" && this.pin.spki === "" && response.spki !== null) {
      // 首次接触时把证书指纹一并记下，此后每次连接都要求它一致。
      this.pin = { ...this.pin, spki: response.spki };
    }
  }

  /** 按错误代码解释中继的拒绝。 */
  private serverError(status: number, body: Uint8Array): RelayError {
    let code = "";
    let serverMessage = "";
    try {
      const parsed: unknown = JSON.parse(decodeText(body));
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const error = (parsed as { error?: unknown }).error;
        if (typeof error === "object" && error !== null) {
          const fields = error as { code?: unknown; message?: unknown };
          code = typeof fields.code === "string" ? fields.code : "";
          serverMessage = typeof fields.message === "string" ? fields.message : "";
        }
      }
    } catch {
      // 正文不是 JSON 时只留状态码，够用来判断发生了什么。
    }

    const known = errorWording(code);
    const wording =
      known === ""
        ? t("中继拒绝了这次请求（{code}）", { code: code === "" ? t("未给出代码") : code })
        : known;
    return new RelayError("server", t("{relay}：{wording}", { relay: this.describe(), wording }), {
      code,
      status,
      serverMessage,
    });
  }

  /** 钉住信息尚未建立时说明这是程序错误，而不是通信问题。 */
  private requirePin(): RelayPin {
    if (this.pin === null) {
      throw new RelayError("transport", t("{relay}：通信结束却没有记下中继公钥", { relay: this.describe() }));
    }
    return this.pin;
  }

  /**
   * 降级传输下不允许注册、吊销与退役。
   *
   * 这三步都由中继代劳，而中间人在场的两级通信挡不住伪造，因此宁可拒绝执行：
   * 参数量是一整句话，免得译文里夹进一个中文动词。
   */
  private refuseWhenDegraded(wording: MessageKey): void {
    if (this.degraded) {
      throw new RelayError("transport", t(wording, { relay: this.describe() }));
    }
  }

  private describe(): string {
    return t("中继 {relay}", { relay: this.options.name });
  }
}

/** 错误代码对应的说法；不认识的代码返回空。文案随语言变，因此每次现取。 */
function errorWording(code: string): string {
  switch (code) {
    case "bad_request":
      return t("中继认为请求不合规");
    case "bad_signature":
      return t("中继没有通过本设备的签名校验");
    case "unauthorized":
      return t("本设备未注册，或已被吊销");
    case "forbidden":
      return t("中继不允许这次操作");
    case "replay":
      return t("中继认为这是一次重放，可能是时钟偏差或重复发送");
    case "skew":
      return t("本机与中继的时间相差过大，请校正时间");
    case "not_found":
      return t("中继上找不到对应的频道或记录");
    case "conflict":
      return t("与中继上的既有状态冲突");
    case "limit":
      return t("请求过于频繁，或超出中继的上限");
    case "internal":
      return t("中继内部出错");
    default:
      return "";
  }
}

/** 把中继地址与端点路径接起来。 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function readString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new RelayError("transport", t("中继的回应里缺少{what}", { what }));
  }
  return value;
}

function readRecord(raw: unknown): PeerRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new RelayError("transport", t("中继给出的记录不是一个对象"));
  }
  const fields = raw as Record<string, unknown>;
  const sequence = fields["sequence"];
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RelayError("transport", t("中继给出的记录序号不合规"));
  }

  const publicKey = decodeBase64(fields["public_key"], t("记录中的公钥"));
  if (publicKey.length !== 32) {
    throw new RelayError("transport", t("中继给出的记录公钥长度不合规"));
  }
  const fingerprint = readString(fields["fingerprint"], t("记录中的设备指纹"));
  if (fingerprintOf(publicKey) !== fingerprint) {
    throw new RelayError("transport", t("中继给出的记录公钥与设备指纹不符"));
  }

  return {
    fingerprint,
    publicKey,
    sequence,
    collectedAt: readString(fields["collected_at"], t("记录中的采集时间")),
    payload: decodeBase64(fields["payload"], t("记录内容")),
    signature: decodeBase64(fields["signature"], t("记录签名")),
  };
}

/**
 * 读一条记录，读不出来就记下原因并放弃这一条。
 *
 * 一条读不出来的记录不该让整批记录作废：中继上只要有一台设备写进了越界或不
 * 成形的记录，同频道其他设备就会永远同步不到任何状态。舍弃的范围仅限这一条，
 * 原因写进诊断，由使用者判断要不要处理。
 */
function readRecordOrNull(raw: unknown, skipped: string[], what: string): PeerRecord | null {
  try {
    return readRecord(raw);
  } catch (error) {
    skipped.push(t("{what}：{reason}", { what, reason: messageOf(error) }));
    return null;
  }
}

function readRecords(raw: unknown, skipped: string[]): PeerRecord[] {
  if (!Array.isArray(raw)) {
    throw new RelayError("transport", t("中继给出的记录清单不是数组"));
  }
  const entries = raw as unknown[];
  const records: PeerRecord[] = [];
  for (const entry of entries) {
    const record = readRecordOrNull(entry, skipped, t("一条对端记录"));
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

/**
 * 读一条吊销纪录，读不出来就记下原因并放弃这一条。
 *
 * 与记录一样，一条坏条目不该让整份回应作废：那样同频道的对端会一直同步不到
 * 任何状态，而丢掉的往往只是一条本就可疑的条目，原因写进诊断由使用者判断。
 */
function readRevocationOrNull(raw: unknown, skipped: string[], what: string): RevocationRecord | null {
  try {
    return readRevocation(raw);
  } catch (error) {
    skipped.push(t("{what}：{reason}", { what, reason: messageOf(error) }));
    return null;
  }
}

function readRevocation(raw: unknown): RevocationRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new RelayError("transport", t("中继给出的吊销记录不是一个对象"));
  }
  const fields = raw as Record<string, unknown>;
  return {
    fingerprint: readString(fields["fingerprint"], t("吊销记录中的设备指纹")),
    by: readString(fields["by"], t("吊销记录中的发起设备")),
    at: readString(fields["at"], t("吊销记录中的时间")),
  };
}

function readRevocations(raw: unknown, skipped: string[]): RevocationRecord[] {
  if (!Array.isArray(raw)) {
    throw new RelayError("transport", t("中继给出的吊销名单不是数组"));
  }
  const entries = raw as unknown[];
  const revocations: RevocationRecord[] = [];
  for (const entry of entries) {
    const revocation = readRevocationOrNull(entry, skipped, t("一条吊销纪录"));
    if (revocation !== null) {
      revocations.push(revocation);
    }
  }
  return revocations;
}

function decodeBase64(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string") {
    throw new RelayError("transport", t("中继的回应里缺少{what}", { what }));
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.length === 0) {
    throw new RelayError("transport", t("中继给出的{what}是空的", { what }));
  }
  return bytes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
