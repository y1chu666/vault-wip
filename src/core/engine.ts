// 本模块把各个环节串起来：采集、加密签名、上报、解密合并、判定冲突与提醒。
//
// 它不认 Obsidian，也不自己起定时器：节奏由调用方按 {@link Engine.nextTimerSeconds}
// 驱动，界面刷新通过回调告知，因此编排逻辑可以在没有 Obsidian 的环境里被完整检验。
//
// 中继联系不上时不会让判断「看起来一切正常」：此时继续沿用上一次取回的状态，
// 并在诊断里如实写明失败，界面上也照此显示。
import { Alerts, type FailureState, type Notice } from "./alerts.js";
import { Cadence, type Trigger } from "./cadence.js";
import type { Config } from "./config.js";
import {
  decodeContentKey,
  decryptContent,
  encodeContentKey,
  encryptContent,
  protectContentKey,
  unprotectContentKey,
  type ContentKey,
} from "./crypto.js";
import { formatRfc3339, parseRfc3339, signRecord, verifyRecord } from "./envelope.js";
import { t } from "./i18n.js";
import { queryRemote as runRemoteQuery, remoteQueryDue, type RemoteQueryResult } from "./remote.js";
import {
  CollectError,
  collectStatus,
  createCommandRunner,
  gitVersion,
  type CommandRunner,
} from "./git.js";
import type { DeviceKey } from "./identity.js";
import {
  buildStatusPayload,
  decodeStatusPayload,
  encodeStatusPayload,
  type StatusPayload,
} from "./payload.js";
import { RelayClient, RelayError, type PeerRecord } from "./relay.js";
import {
  findConflicts,
  mergePeers,
  nextSequence,
  type Conflict,
  type DeviceStatus,
  type SequenceAnomaly,
} from "./state.js";
import {
  SECRET_FILE_NAMES,
  STATE_VERSION,
  StorageError,
  ensureSecretIgnore,
  loadOrCreateContentKey,
  loadOrCreateDeviceKey,
  loadRelayPins,
  loadState,
  saveRelayPins,
  saveState,
  writeTextFile,
  type ChannelRegistration,
  type PluginFiles,
  type RelayPin,
} from "./storage.js";

/** 诊断信息里保留的条数上限。 */
const MAX_DIAGNOSTICS = 50;

/**
 * 序号的上界，与中继一致。
 *
 * 序号以普通数值表示，越过这个上界就无法再精确加一；与其发出一条中继必然拒绝的
 * 记录，不如停在本地并说清该怎么办。
 */
const MAX_SEQUENCE = 2 ** 53 - 1;

/** 引擎手里可改动的状态；落盘时按 {@link PersistedState} 的形状写出。 */
interface EngineState {
  version: number;
  channels: Record<string, ChannelRegistration>;
  sequence: number;
  peers: DeviceStatus[];
  revoked: string[];
  retired: boolean;
}

/** 一台中继的现状。 */
export interface RelayStatus {
  readonly name: string;
  readonly url: string;
  readonly level: string;
  /** 处于降级传输：此时禁止注册、吊销与退役。 */
  readonly degraded: boolean;
  /** 已注册的频道标识；尚未注册时为空。 */
  readonly channelId: string;
  readonly lastSuccessAt: string | null;
  readonly lastFailure: string | null;
  /** 钉住的中继公钥指纹；尚未配对时为空。 */
  readonly fingerprint: string | null;
  /** 钉住的中继证书公钥指纹；非钉住一级时为空。 */
  readonly spki: string | null;
}

/** 一条被舍弃的对端记录。 */
export interface DroppedRecord {
  readonly fingerprint: string;
  readonly reason: string;
  readonly at: string;
}

/** 诊断信息。 */
export interface Diagnostics {
  readonly collectedAt: string | null;
  readonly collectMillis: number | null;
  readonly gitVersion: string | null;
  /** 序号推进中的异常，只含同一序号给出两份内容的情形。 */
  readonly anomalies: readonly SequenceAnomaly[];
  /** 舍弃的对端记录，最新的在后。 */
  readonly dropped: readonly DroppedRecord[];
  /** 最近的事件，最新的在后。 */
  readonly events: readonly string[];
}

/** 供界面展示的全部现状。 */
export interface EngineSnapshot {
  readonly alias: string;
  readonly selfFingerprint: string;
  readonly selfLabel: string;
  readonly sequence: number;
  readonly local: StatusPayload | null;
  readonly conflicts: readonly Conflict[];
  readonly peers: readonly DeviceStatus[];
  readonly revoked: readonly string[];
  readonly relays: readonly RelayStatus[];
  readonly contentKeyId: string;
  readonly retired: boolean;
  /** 有中继处于降级传输。 */
  readonly degraded: boolean;
  /** 最近一次远端查询的结果；尚未查过为 null。只在本机界面上显示。 */
  readonly remote: RemoteQueryResult | null;
  /** 最近一次远端查询的时刻。 */
  readonly remoteQueriedAt: string | null;
  readonly diagnostics: Diagnostics;
}

/** 引擎所需的运行参数。 */
export interface EngineOptions {
  readonly files: PluginFiles;
  readonly config: Config;
  /** 仓库根目录，用于采集。 */
  readonly vaultRoot: string;
  /** 取当前时刻，留成参数是为了让用例不必等待真实时间。 */
  readonly now?: () => Date;
  readonly clock?: () => number;
  readonly notify?: (notice: Notice) => void;
  readonly onChange?: () => void;
  readonly isFocused?: () => boolean;
  readonly log?: (message: string) => void;
}

/** 编排：采集本机状态，与其他设备交换记录，并在必要时提醒。 */
export class Engine {
  private readonly options: EngineOptions;
  private readonly deviceKey: DeviceKey;
  private contentKey: ContentKey;
  private config: Config;
  private pins: Map<string, RelayPin>;
  private state: EngineState;
  private cadence: Cadence;
  private alerts: Alerts;
  private runner: CommandRunner;
  private clients: RelayClient[];

  private local: StatusPayload | null = null;
  private collectedAt: Date | null = null;
  private collectMillis: number | null = null;
  private gitVersionText: string | null = null;
  private conflicts: Conflict[] = [];
  private anomalies: SequenceAnomaly[] = [];
  private dropped: DroppedRecord[] = [];
  private events: string[] = [];
  private lastNote: string | null = null;
  private relayStatus = new Map<string, { lastSuccessAt: Date | null; lastFailure: string | null }>();
  private remote: RemoteQueryResult | null = null;
  private remoteQueriedAt: Date | null = null;
  private failureSince: number | null = null;
  private stopped = false;

  private constructor(
    options: EngineOptions,
    loaded: {
      readonly deviceKey: DeviceKey;
      readonly contentKey: ContentKey;
      readonly pins: Map<string, RelayPin>;
      readonly state: EngineState;
    },
  ) {
    this.options = options;
    this.deviceKey = loaded.deviceKey;
    this.contentKey = loaded.contentKey;
    this.pins = loaded.pins;
    this.state = loaded.state;
    this.config = options.config;
    this.clients = [];
    this.cadence = new Cadence(this.config.collect, () => this.clock());
    this.alerts = new Alerts(this.config.notify);
    this.runner = createCommandRunner(this.config.collect.git);
    this.rebuildClients();
  }

  /** 从本机文件里装载引擎：密钥与状态缓存没有的就地生成。 */
  static async create(options: EngineOptions): Promise<Engine> {
    const files = options.files;
    const device = await loadOrCreateDeviceKey(files);
    const content = await loadOrCreateContentKey(files);
    if (device.created || content.created) {
      // 生成密钥之后才写忽略清单：插件目录若随仓库流转，这一步能挡住提交。
      await ensureSecretIgnore(files.ignore, SECRET_FILE_NAMES);
    }

    const stored = await loadState(files.state);
    return new Engine(options, {
      deviceKey: device.key,
      contentKey: content.key,
      pins: await loadRelayPins(files.pins),
      state: {
        version: STATE_VERSION,
        channels: { ...(stored?.channels ?? {}) },
        sequence: stored?.sequence ?? 0,
        peers: [...(stored?.peers ?? [])],
        revoked: [...(stored?.revoked ?? [])],
        retired: stored?.retired ?? false,
      },
    });
  }

  /** 当前生效的配置；注册之后频道标识与令牌会写回这里。 */
  get currentConfig(): Config {
    return this.config;
  }

  /** 换用一份新配置：中继、节奏与提醒都随之重建。 */
  setConfig(config: Config): void {
    this.config = config;
    this.cadence = new Cadence(config.collect, () => this.clock());
    this.alerts = new Alerts(config.notify);
    this.runner = createCommandRunner(config.collect.git);
    this.rebuildClients();
    this.options.onChange?.();
  }

  /** 记录窗口是否聚焦，供提醒判断。 */
  setFocused(focused: boolean): void {
    this.cadence.setFocused(focused);
  }

  /** 下一次定时采集应当间隔多少秒。 */
  nextTimerSeconds(): number {
    return this.cadence.timerSeconds();
  }

  /** 当前的全部现状。 */
  snapshot(): EngineSnapshot {
    return {
      alias: this.config.channel.alias,
      selfFingerprint: this.deviceKey.fingerprint,
      selfLabel: this.config.device.name,
      sequence: this.state.sequence,
      local: this.local,
      conflicts: [...this.conflicts],
      peers: [...this.state.peers],
      revoked: [...this.state.revoked],
      relays: this.clients.map((client) => this.relayStatusOf(client)),
      contentKeyId: this.contentKey.id,
      retired: this.state.retired,
      degraded: this.clients.some((client) => client.degraded),
      remote: this.remote,
      remoteQueriedAt: this.remoteQueriedAt === null ? null : formatRfc3339(this.remoteQueriedAt),
      diagnostics: {
        collectedAt: this.collectedAt === null ? null : formatRfc3339(this.collectedAt),
        collectMillis: this.collectMillis,
        gitVersion: this.gitVersionText,
        anomalies: [...this.anomalies],
        dropped: [...this.dropped],
        events: [...this.events],
      },
    };
  }

  /**
   * 走一轮：采集、上报、合并与提醒。
   *
   * 定时触发不受防抖限制；其余触发在防抖窗口内合并，免得连续保存若干文件就发出一串请求。
   */
  async tick(trigger: Trigger | "timer"): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (trigger !== "timer" && !this.cadence.shouldReportNow(trigger)) {
      return;
    }
    await this.runOnce();
  }

  /**
   * 向远端查一次，结果只用于本机界面。
   *
   * 只读远端：既不拉取也不改动本机引用；失败也照实记下。这一项不进记录、不上报，
   * 因此中继与对端都不知道本机查过谁、查出了什么。
   */
  async queryRemote(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.remote = await runRemoteQuery(this.runner, this.options.vaultRoot, this.config.query.remote);
    this.remoteQueriedAt = this.now();
    this.options.onChange?.();
  }

  /** 以注册凭证向各中继注册本仓库，成功的中继记下频道。 */
  async register(credential: string): Promise<Config> {
    const failures: string[] = [];
    const relays = this.config.relay.map((relay) => ({ ...relay }));
    const byName = new Map(relays.map((relay) => [relay.name, relay]));

    for (const client of this.clients) {
      const settings = byName.get(client.name);
      if (settings === undefined) {
        failures.push(`${client.name}：${t("配置里没有这台中继")}`);
        continue;
      }
      try {
        const channel = await client.register({
          alias: this.config.channel.alias,
          channelId: settings.channelId,
          channelToken: settings.channelToken,
          credential,
        });
        settings.channelId = channel.channelId;
        if (channel.channelToken !== "") {
          settings.channelToken = channel.channelToken;
        }
        this.state.channels[client.name] = {
          channelId: channel.channelId,
          alias: channel.channelAlias,
        };
        this.keepPin(client);
        this.note(t("已在中继 {relay} 注册频道 {channel}", { relay: client.name, channel: channel.channelAlias }));
      } catch (error) {
        failures.push(`${client.name}：${describe(error)}`);
      }
    }

    const updated: Config = { ...this.config, relay: relays };
    this.setConfig(updated);
    if (failures.length < this.clients.length) {
      this.state.retired = false;
    }
    await this.persist();
    this.options.onChange?.();
    if (failures.length > 0) {
      throw new StorageError(t("注册未全部完成：{failures}", { failures: failures.join(t("；")) }));
    }
    return updated;
  }

  /** 吊销同一频道内的另一台设备，各中继都要报到。 */
  async revoke(fingerprint: string): Promise<void> {
    if (Object.keys(this.state.channels).length === 0) {
      throw new StorageError(t("尚未在任何中继上注册，无法吊销设备"));
    }

    const failures: string[] = [];
    for (const client of this.clients) {
      const channel = this.state.channels[client.name];
      if (channel === undefined) {
        continue;
      }
      try {
        await client.revoke(channel.channelId, fingerprint);
        this.keepPin(client);
        this.note(t("已在中继 {relay} 吊销设备 {fingerprint}", { relay: client.name, fingerprint: short(fingerprint) }));
      } catch (error) {
        failures.push(`${client.name}：${describe(error)}`);
      }
    }

    if (!this.state.revoked.includes(fingerprint)) {
      this.state.revoked = [...this.state.revoked, fingerprint];
    }
    await this.persist();
    this.refreshConflicts();
    this.options.onChange?.();
    if (failures.length > 0) {
      throw new StorageError(t("吊销未全部完成：{failures}", { failures: failures.join(t("；")) }));
    }
  }

  /**
   * 本设备退役：让各中继删掉本设备的数据并记入吊销名单。
   *
   * 只有全部中继都退役成功才把本设备标记为已退役；有一台没退成时保留它的频道，
   * 使用者可以稍后再试，免得数据留在那一台上却无从清理。
   */
  async retire(): Promise<void> {
    const failures: string[] = [];
    let succeeded = 0;
    for (const client of this.clients) {
      const channel = this.state.channels[client.name];
      if (channel === undefined) {
        continue;
      }
      try {
        await client.retire(channel.channelId);
        delete this.state.channels[client.name];
        this.note(t("已在中继 {relay} 退役本设备", { relay: client.name }));
        succeeded += 1;
      } catch (error) {
        failures.push(`${client.name}：${describe(error)}`);
      }
    }

    if (failures.length === 0 && succeeded > 0) {
      this.state.retired = true;
      this.state.peers = [];
      this.conflicts = [];
    }
    await this.persist();
    this.options.onChange?.();
    if (failures.length > 0) {
      throw new StorageError(t("退役未全部完成：{failures}", { failures: failures.join(t("；")) }));
    }
  }

  /**
   * 把本机序号重置到起点。
   *
   * 序号平时由本设备自己推进，用不着人管；只有它到了无法继续推进的地步（例如被
   * 一份越界的既有记录顶到了上界），才由使用者核对状态之后手动重置。重置只改本机
   * 记录，中继上的数据一条不动，因此事后仍能从诊断里看出先前发生过什么。
   */
  async resetSequence(): Promise<void> {
    this.state.sequence = 0;
    this.note(t("本机计数已重置为 0，下一次上报将按中继给出的序号重新对齐"));
    await this.persist();
    this.options.onChange?.();
  }

  /** 内容密钥的文本形式，供逐字传递或写入导出文件。 */
  contentKeyText(): string {
    return encodeContentKey(this.contentKey);
  }

  /** 换用另一把内容密钥。旧密钥加密的对端记录此后读不出来，这是换钥的应有之义。 */
  async adoptContentKey(text: string): Promise<void> {
    const key = decodeContentKey(text);
    await this.writeContentKey(key);
  }

  /** 用口令封起内容密钥，得到的文本可以交给同一仓库的其他设备。 */
  protectContentKeyWith(passphrase: string): string {
    return protectContentKey(this.contentKey, passphrase);
  }

  /** 解开口令封住的内容密钥并换用。 */
  async adoptProtectedContentKey(text: string, passphrase: string): Promise<void> {
    await this.writeContentKey(unprotectContentKey(text, passphrase));
  }

  /** 停止引擎，后续的触发一律忽略。 */
  stop(): void {
    this.stopped = true;
  }

  /** 内容密钥落盘并记一笔：换钥会影响能读出的记录，值得在诊断里留痕。 */
  private async writeContentKey(key: ContentKey): Promise<void> {
    this.contentKey = key;
    await writeTextFile(this.options.files.contentKey, `${encodeContentKey(key)}\n`, 0o600);
    this.note(t("已换用新的内容密钥，此前用旧密钥加密的对端记录读不出来"));
    this.options.onChange?.();
  }

  /** 按配置重建各中继的客户端，并清掉已经没有对应的钉住信息。 */
  private rebuildClients(): void {
    this.clients = this.config.relay.map(
      (relay) =>
        new RelayClient({
          name: relay.name,
          url: relay.url,
          level: relay.transport,
          pin: this.pins.get(relay.name) ?? null,
          key: this.deviceKey,
          now: () => this.now(),
        }),
    );

    const known = new Set(this.config.relay.map((relay) => relay.name));
    for (const name of [...this.pins.keys()]) {
      if (!known.has(name)) {
        this.pins.delete(name);
      }
    }
  }

  /** 走一轮：采集之后上报，再合并与提醒。 */
  private async runOnce(): Promise<void> {
    const started = this.clock();
    let content: StatusPayload | null = null;

    try {
      content = await this.collect();
      this.local = content;
      this.collectedAt = this.now();
    } catch (error) {
      this.note(t("采集失败：{reason}", { reason: describe(error) }));
    } finally {
      this.collectMillis = this.clock() - started;
    }

    if (content !== null) {
      try {
        await this.reportAll(content);
      } catch (error) {
        this.note(t("上报失败：{reason}", { reason: describe(error) }));
      }
    }

    this.refreshConflicts();
    this.emitNotices();
    // 远端查询排在最后：它只影响本机界面，不该拖慢上报，也不该参与冲突判断。
    if (
      remoteQueryDue(
        this.remoteQueriedAt?.getTime() ?? null,
        this.now().getTime(),
        this.config.query.intervalSeconds,
      )
    ) {
      await this.queryRemote();
    }
    this.options.onChange?.();
  }

  /** 采集一次仓库状态，整理成记录内容。 */
  private async collect(): Promise<StatusPayload> {
    if (this.gitVersionText === null) {
      this.gitVersionText = await gitVersion(this.runner, this.options.vaultRoot);
    }

    const collected = await collectStatus(this.runner, this.options.vaultRoot);
    return buildStatusPayload({
      label: this.config.device.name,
      changes: collected.changes,
      suspectFiles: collected.suspectFiles,
      conflictFiles: this.config.collect.detectConflictFiles ? collected.conflicted : [],
    });
  }

  /**
   * 向各中继上报一轮。
   *
   * 中继指出本设备序号落后时，按它给出的序号推进后重报一次。各中继的进度可能不同，
   * 因此取其中最大的序号：谁记得更远，就以谁为准。
   */
  private async reportAll(content: StatusPayload): Promise<void> {
    const rejected = await this.reportRound(content);
    if (rejected === null) {
      return;
    }

    this.note(t("中继上已有本设备的记录（序号 {sequence}），按它推进后重报", { sequence: rejected }));
    this.state.sequence = rejected;
    const again = await this.reportRound(content);
    if (again !== null) {
      this.note(
        t("按中继给出的序号重报之后仍被拒：同一份身份可能被复制到了另一台设备上，或本机计数已不可用；请在诊断栏核对状态"),
      );
    }
  }

  /** 上报一轮，返回中继给出的本设备既有序号（没有则返回空）。 */
  private async reportRound(content: StatusPayload): Promise<number | null> {
    if (this.state.retired || this.clients.length === 0) {
      return null;
    }

    const sequence = nextSequence(this.state.sequence);
    // 序号已经加到无法精确表示时，上报只会被中继拒绝；停在这里并说清自救办法。
    if (sequence > MAX_SEQUENCE) {
      this.note(
        t("本机计数已达可表示上界（{limit}），本次不上报：请在诊断栏核对状态后重置本机计数", {
          limit: MAX_SEQUENCE,
        }),
      );
      return null;
    }
    const collectedAt = this.now();
    const collectedAtText = formatRfc3339(collectedAt);
    const encrypted = encryptContent(this.contentKey, encodeStatusPayload(content));

    const outcomes = await Promise.allSettled(
      this.clients.map(async (client) => {
        const channel = this.state.channels[client.name];
        if (channel === undefined) {
          throw new RelayError(
            "transport",
            t("中继 {relay}：尚未注册本仓库，请先填写注册凭证并注册", { relay: client.name }),
          );
        }

        // 记录签名覆盖频道标识，而频道标识由各中继分别生成，因此签名按中继分别做。
        const signature = signRecord(this.deviceKey, {
          fingerprint: this.deviceKey.fingerprint,
          channel: channel.channelId,
          sequence,
          collectedAt,
          payload: encrypted,
        });
        const reply = await client.report({
          channelId: channel.channelId,
          sequence,
          collectedAt: collectedAtText,
          payload: encrypted,
          signature,
        });
        return { channelId: channel.channelId, reply };
      }),
    );

    let highestOwn: number | null = null;
    let accepted = false;
    let failed = 0;

    outcomes.forEach((outcome, index) => {
      const client = this.clients[index];
      if (client === undefined) {
        return;
      }
      if (outcome.status === "rejected") {
        failed += 1;
        this.markFailure(client.name, describe(outcome.reason));
        return;
      }

      this.markSuccess(client.name);
      this.keepPin(client);

      const { channelId, reply } = outcome.value;
      if (reply.accepted) {
        accepted = true;
      } else if (reply.own !== null && reply.own.sequence >= sequence) {
        const own = reply.own;
        if (!this.ownsRecord(own, channelId)) {
          // 序号决定本机此后能否继续上报，因此只认本机自己签下的那一条。
          this.note(
            t("中继 {relay} 回送的本设备既有序号不是本机签的，不予采信：请在诊断栏核对状态", {
              relay: client.name,
            }),
          );
        } else if (nextSequence(own.sequence) > MAX_SEQUENCE) {
          // 采信它会把本机计数顶到无法再加一的位置，此后一次也报不上去，连重置都会
          // 被立刻顶回来。这样的既有序号只会来自异常的中继，记一笔异常而不采信。
          this.note(
            t("中继 {relay} 给出的本设备既有序号已达可表示上界，不予采信：请在诊断栏核对状态", {
              relay: client.name,
            }),
          );
        } else {
          highestOwn = Math.max(highestOwn ?? 0, own.sequence);
        }
      }

      this.mergeRecords(client.name, channelId, reply.records);
      this.applyRevocations(reply.revocations);

      // 舍弃与截断都要说出来：不言不语的「少了几条」会被当成对方没有改动。
      if (reply.skipped.length > 0) {
        this.note(
          t("中继 {relay} 回送的内容里有 {count} 条读不出来，已放弃：{detail}", {
            relay: client.name,
            count: reply.skipped.length,
            detail: reply.skipped[0] ?? "",
          }),
        );
      }
      if (reply.truncated) {
        this.note(t("中继 {relay} 回送的记录已达上限，本次只取回一部分，其余下一轮再取", { relay: client.name }));
      }
    });

    if (accepted) {
      this.state.sequence = sequence;
      this.failureSince = null;
    } else if (this.clients.length > 0 && failed === this.clients.length) {
      this.failureSince ??= this.clock();
    } else if (failed === 0) {
      this.failureSince = null;
    }

    await this.persist();
    return highestOwn;
  }

  /**
   * 核对中继回送的「本设备既有序号」是否出自本机。
   *
   * 序号决定本机此后能不能继续上报，采信之前必须确认这条记录真的是本机签的：
   * 中继只负责搬运，它给出的记录核不过签名、或者根本不属于本机，就不该影响本机
   * 的计数。
   */
  private ownsRecord(record: PeerRecord, channelId: string): boolean {
    if (record.fingerprint !== this.deviceKey.fingerprint) {
      return false;
    }
    try {
      return verifyRecord(
        record.publicKey,
        {
          fingerprint: record.fingerprint,
          channel: channelId,
          sequence: record.sequence,
          collectedAt: parseRfc3339(record.collectedAt),
          payload: record.payload,
        },
        record.signature,
      );
    } catch {
      // 时间读不出来就等同于核不过。
      return false;
    }
  }

  /** 解开并核对来自某台中继的对端记录，再交给合并逻辑。 */
  private mergeRecords(
    relayName: string,
    channelId: string,
    records: readonly PeerRecord[],
  ): void {
    const incoming: DeviceStatus[] = [];

    for (const record of records) {
      if (record.fingerprint === this.deviceKey.fingerprint) {
        continue;
      }

      let payload: StatusPayload;
      let collectedAt: Date;
      try {
        payload = decodeStatusPayload(decryptContent(this.contentKey, record.payload));
        collectedAt = parseRfc3339(record.collectedAt);
      } catch (error) {
        this.drop(record.fingerprint, describe(error));
        continue;
      }

      const signed = verifyRecord(
        record.publicKey,
        {
          fingerprint: record.fingerprint,
          channel: channelId,
          sequence: record.sequence,
          collectedAt,
          payload: record.payload,
        },
        record.signature,
      );
      if (!signed) {
        this.drop(record.fingerprint, t("记录签名核不过，内容可能已被改动"));
        continue;
      }

      incoming.push({
        fingerprint: record.fingerprint,
        label: payload.label,
        sequence: record.sequence,
        collectedAt: record.collectedAt,
        payload,
      });
    }

    if (incoming.length === 0) {
      return;
    }

    const merged = mergePeers(this.state.peers, incoming);
    this.state.peers = merged.peers;
    if (merged.accepted.length > 0) {
      this.note(t("从 {relay} 取回 {count} 台设备的状态", { relay: relayName, count: merged.accepted.length }));
    }

    // 序号回退在多中继并存时属于常态（另一台中继上的记录还没跟上），因此只报同序号两份内容这一种异常。
    const mismatches = merged.anomalies.filter((anomaly) => anomaly.kind === "mismatch");
    for (const anomaly of mismatches) {
      this.note(
        t("设备 {fingerprint} 在序号 {incoming} 上给出了两份内容，已保留先前那份", {
          fingerprint: short(anomaly.fingerprint),
          incoming: anomaly.incomingSequence,
        }),
      );
    }
    this.anomalies = [...this.anomalies.filter((anomaly) => anomaly.kind === "mismatch"), ...mismatches].slice(
      -MAX_DIAGNOSTICS,
    );
  }

  /** 把吊销名单并进来；被吊销的设备此后不再参与冲突判定。 */
  private applyRevocations(revocations: readonly { readonly fingerprint: string }[]): void {
    for (const revocation of revocations) {
      if (!this.state.revoked.includes(revocation.fingerprint)) {
        this.state.revoked = [...this.state.revoked, revocation.fingerprint];
        this.note(t("设备 {fingerprint} 已被吊销，此后不再参与判断", { fingerprint: short(revocation.fingerprint) }));
      }
    }
  }

  private refreshConflicts(): void {
    this.conflicts = findConflicts(this.local, this.activePeers());
  }

  /** 未被吊销的对端。 */
  private activePeers(): DeviceStatus[] {
    return this.state.peers.filter((peer) => !this.state.revoked.includes(peer.fingerprint));
  }

  /** 按提醒规则给出提示。全部中继都联系不上才算持续故障。 */
  private emitNotices(): void {
    // 只有全部中继都联系不上才算持续故障：部分失败照常工作，原因记在诊断里。
    const failing = this.clients.filter(
      (client) => (this.relayStatus.get(client.name)?.lastFailure ?? null) !== null,
    );
    const allFailing = this.clients.length > 0 && failing.length === this.clients.length;
    const failure: FailureState | null =
      allFailing && this.failureSince !== null
        ? {
            since: this.failureSince,
            message: this.relayStatus.get(failing[0]?.name ?? "")?.lastFailure ?? t("原因不明"),
          }
        : null;

    const notices = this.alerts.evaluate({
      now: this.clock(),
      focused: this.options.isFocused?.() ?? true,
      conflicts: this.conflicts,
      peersWithChanges: this.activePeers().filter((peer) => peer.payload.count > 0),
      relayName: failing.map((client) => client.name).join(t("、")),
      failure,
    });

    for (const notice of notices) {
      this.options.notify?.(notice);
    }
  }

  /** 记下一次成功的通信；从失败转好时在诊断里留一笔。 */
  private markSuccess(name: string): void {
    const previous = this.relayStatus.get(name);
    this.relayStatus.set(name, { lastSuccessAt: this.now(), lastFailure: null });
    if (previous !== undefined && previous.lastFailure !== null) {
      this.note(t("与中继 {relay} 的联系已恢复", { relay: name }));
    }
  }

  /** 记下一次失败的通信；原因与上次相同则不重复记事件。 */
  private markFailure(name: string, message: string): void {
    const previous = this.relayStatus.get(name);
    this.relayStatus.set(name, { lastSuccessAt: previous?.lastSuccessAt ?? null, lastFailure: message });
    if (previous?.lastFailure !== message) {
      this.note(t("与中继 {relay} 通信失败：{reason}", { relay: name, reason: message }));
    }
  }

  /** 记下中继当前的钉住信息，中继换过公钥的情形已在客户端拦下。 */
  private keepPin(client: RelayClient): void {
    if (client.pinned !== null) {
      this.pins.set(client.name, client.pinned);
    }
  }

  private relayStatusOf(client: RelayClient): RelayStatus {
    const status = this.relayStatus.get(client.name);
    const pin = this.pins.get(client.name);
    return {
      name: client.name,
      url: client.url,
      level: client.level,
      degraded: client.degraded,
      channelId: this.state.channels[client.name]?.channelId ?? "",
      lastSuccessAt: status?.lastSuccessAt == null ? null : formatRfc3339(status.lastSuccessAt),
      lastFailure: status?.lastFailure ?? null,
      fingerprint: pin?.serverFingerprint ?? null,
      spki: pin === undefined || pin.spki === "" ? null : pin.spki,
    };
  }

  /** 舍弃一条读不出或核不过的对端记录，并在诊断里说明原因。 */
  private drop(fingerprint: string, reason: string): void {
    this.dropped = [
      ...this.dropped.slice(-(MAX_DIAGNOSTICS - 1)),
      { fingerprint, reason, at: formatRfc3339(this.now()) },
    ];
    this.note(t("舍弃设备 {fingerprint} 的记录：{reason}", { fingerprint: short(fingerprint), reason }));
  }

  /** 记一笔事件。 */
  private note(message: string): void {
    // 同一句话连着来就没有新的信息：中继一直不回话时，诊断栏不该被同一行刷满。
    if (message === this.lastNote) {
      return;
    }
    this.lastNote = message;
    this.events = [...this.events.slice(-(MAX_DIAGNOSTICS - 1)), `${formatRfc3339(this.now())} ${message}`];
    this.options.log?.(message);
  }

  /** 把钉住信息与状态缓存落盘。 */
  private async persist(): Promise<void> {
    await saveRelayPins(this.options.files.pins, this.pins);
    await saveState(this.options.files.state, {
      version: this.state.version,
      channels: { ...this.state.channels },
      sequence: this.state.sequence,
      peers: [...this.state.peers],
      revoked: [...this.state.revoked],
      retired: this.state.retired,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }
}

/** 指纹的前几位，够在界面上与人说话时指代一台设备。 */
function short(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}

/** 把错误说成人能读的一句话；各模块自带的错误本就写清了原因。 */
function describe(error: unknown): string {
  if (error instanceof RelayError) {
    // 中继自己写的说明只作留痕：有些问题只有它说得清，例如序号越过了可表示的范围。
    const server = error.detail.serverMessage;
    return server === undefined || server === ""
      ? error.message
      : t("{message}（中继说明：{detail}）", { message: error.message, detail: server });
  }
  if (error instanceof CollectError || error instanceof StorageError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
