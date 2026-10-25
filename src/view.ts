// 状态视图：把引擎给出的现状画成五个分栏。
//
// 这里只显示与触发动作，不做判断：判断都在 src/core 里，免得同一套规则在界面上
// 再写一遍。界面本身不进覆盖率统计，因此它保持直白：取一份现状，逐块填上文字。
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";

import { displayName, type Conflict, type DeviceStatus, type RevokedDevice } from "./core/state.js";
import type { EngineSnapshot, RelayStatus } from "./core/engine.js";
import { PLUGIN_NAME, t } from "./core/i18n.js";
import { refName, remoteSummary } from "./core/remote.js";
import type { StatusPayload } from "./core/payload.js";
import type VaultWipPlugin from "./main.js";

export const VIEW_TYPE = "vault-wip-view";

type TabName = "overview" | "peers" | "relays" | "security" | "diagnostics";

const TABS: readonly TabName[] = ["overview", "peers", "relays", "security", "diagnostics"];

/**
 * 分组是否展开，按「所属设备 + 改动类型」记录。
 *
 * 视图刷新会重建整块内容，若不记住这一状态，使用者每展开一次就会被折叠回去。
 */
const expandedGroups = new Map<string, boolean>();

/**
 * 分栏标题。
 *
 * 文案随语言变化，因此不写死在分栏表里，每次重画时现取；这样切换语言之后
 * 标题也会跟着变，不必重开视图。
 */
function tabLabel(name: TabName): string {
  switch (name) {
    case "overview":
      return t("概览");
    case "peers":
      return t("各端状态");
    case "relays":
      return t("中继");
    case "security":
      return t("安全");
    case "diagnostics":
      return t("诊断");
  }
}

/** 清单里最多显示几个文件名，免得一屏都是路径。 */
const MAX_LISTED_PATHS = 20;

export class WipView extends ItemView {
  private tab: TabName = "overview";
  private readonly panes = new Map<TabName, HTMLElement>();
  private readonly tabButtons = new Map<TabName, HTMLButtonElement>();
  /** 上一次画出的内容指纹；相同就不再重建，免得折叠状态与滚动位置被打断。 */
  private lastSignature: string | null = null;
  private securityDynamic: HTMLElement | null = null;
  private securityBuilt = false;
  private confirmRetire = false;
  private confirmResetSequence = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultWipPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Vault WIP";
  }

  override getIcon(): string {
    return "radio-tower";
  }

  override onOpen(): Promise<void> {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "vault-wip-view" });

    const tabs = root.createDiv({ cls: "vault-wip-tabs" });
    const body = root.createDiv({ cls: "vault-wip-body" });
    for (const name of TABS) {
      const button = tabs.createEl("button", { text: tabLabel(name) });
      button.onclick = () => {
        this.tab = name;
        this.updateTabs();
        this.render();
      };
      this.tabButtons.set(name, button);
      this.panes.set(name, body.createDiv({ cls: `vault-wip-pane vault-wip-${name}` }));
    }

    this.updateTabs();
    this.render();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.plugin.forgetView(this);
    this.panes.clear();
    this.tabButtons.clear();
    return Promise.resolve();
  }

  /** 内容指纹：只取会改变界面的部分，诊断事件的时间戳不参与。 */
  private signature(snapshot: EngineSnapshot | null, error: string | null): string {
    if (snapshot === null) {
      return JSON.stringify({ tab: this.tab, error });
    }
    return JSON.stringify({
      tab: this.tab,
      error,
      local: snapshot.local,
      peers: snapshot.peers,
      conflicts: snapshot.conflicts,
      relays: snapshot.relays,
      revoked: snapshot.revoked,
      sequence: snapshot.sequence,
      retired: snapshot.retired,
    });
  }

  /** 按当前现状重画一遍。 */
  render(): void {
    this.updateTabs();
    const snapshot = this.plugin.snapshot();
    const error = this.plugin.configErrorText();

    for (const [name, pane] of this.panes) {
      pane.style.display = name === this.tab ? "block" : "none";
    }

    const signature = this.signature(snapshot, error);
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;

    if (this.tab === "security") {
      // 安全一栏里有输入框，重画会把使用者刚输入的口令抹掉，因此固定部分只建一次。
      this.buildSecurityOnce();
      this.renderSecurityDynamic(snapshot);
      return;
    }

    const pane = this.panes.get(this.tab);
    if (pane === undefined) {
      return;
    }
    pane.empty();
    this.fill(pane, snapshot, error);
  }

  /** 把某一栏的内容填上。 */
  private fill(pane: HTMLElement, snapshot: EngineSnapshot | null, error: string | null): void {
    if (error !== null) {
      const warn = pane.createDiv({ cls: "vault-wip-error" });
      warn.setText(t("配置有误：{error}", { error }));
      const path = this.plugin.configPath();
      if (path !== null) {
        hint(pane, t("配置文件：{path}", { path }));
      }
      return;
    }
    if (snapshot === null) {
      hint(pane, t("尚未就绪：请先在设置中填写中继信息。"));
      return;
    }

    switch (this.tab) {
      case "overview":
        this.fillOverview(pane, snapshot);
        break;
      case "peers":
        this.fillPeers(pane, snapshot);
        break;
      case "relays":
        this.fillRelays(pane, snapshot);
        break;
      case "diagnostics":
        this.fillDiagnostics(pane, snapshot);
        break;
      default:
        break;
    }
  }

  private fillOverview(pane: HTMLElement, snapshot: EngineSnapshot): void {
    overviewStats(pane, snapshot);

    const registered = snapshot.relays.filter((relay) => relay.channelId !== "").length;
    if (snapshot.relays.length === 0) {
      hintWithLink(pane);
    } else if (registered === 0) {
      notice(pane, t("尚未连接任何中继：请在设置中填写地址并完成注册。"));
    }
    if (snapshot.retired) {
      notice(pane, t("本设备已退役：需要重新注册才能继续使用。"), true);
    }

    if (snapshot.local === null) {
      heading(pane, t("本机改动"));
      hint(pane, t("尚未取得本机状态。"));
      const actions = pane.createDiv({ cls: "vault-wip-actions" });
      const button = actions.createEl("button", { text: t("立即采集并上报") });
      button.onclick = () => {
        void this.plugin.reportNow();
      };
    } else {
      const local = snapshot.local;
      const card = pane.createDiv({ cls: "vault-wip-card" });
      const head = card.createDiv({ cls: "vault-wip-card-head" });
      head.createDiv({ cls: "vault-wip-card-title", text: t("本机改动") });
      const collectedAt = snapshot.diagnostics.collectedAt;
      head.createDiv({
        cls: "vault-wip-card-meta",
        text:
          collectedAt === null
            ? t("{count} 个文件", { count: local.count })
            : t("{count} 个文件 · {time}", { count: local.count, time: relativeTime(collectedAt) }),
      });
      if (local.truncated) {
        hint(card, t("清单过长，采集时已截断。"));
      }
      kindChips(card, local);
      groupedFiles(card, local.paths, local.kinds, "local");
      suspectNotes(card, local);
      const actions = card.createDiv({ cls: "vault-wip-actions" });
      const button = actions.createEl("button", { text: t("立即采集并上报") });
      button.onclick = () => {
        void this.plugin.reportNow();
      };
    }

    // 冲突是这一页里最需要立刻知道的事，有才出现，并且独占一个警示块。
    if (snapshot.conflicts.length > 0) {
      const block = notice(pane, t("与对端的冲突"));
      for (const conflict of snapshot.conflicts) {
        conflictLine(block, conflict);
      }
    }

    heading(pane, t("各端改动"));
    const active = snapshot.peers.filter(
      (peer) => !snapshot.revoked.some((entry) => entry.fingerprint === peer.fingerprint),
    );
    if (active.length === 0) {
      hint(pane, t("尚无可用的对端记录。"));
    } else {
      for (const peer of active) {
        overviewPeer(pane, peer);
      }
    }

    heading(pane, t("远端查询"));
    const remoteCard = pane.createDiv({ cls: "vault-wip-card" });
    const remote = snapshot.remote;
    table(remoteCard, [
      [t("远端"), remote !== null && "remote" in remote ? refName(remote) : t("无")],
      [t("上次查询"), clockText(snapshot.remoteQueriedAt)],
    ]);
    hint(remoteCard, remoteSummary(remote));
    const remoteActions = remoteCard.createDiv({ cls: "vault-wip-actions" });
    const queryButton = remoteActions.createEl("button", { text: t("查询远端") });
    queryButton.onclick = () => {
      void this.plugin.queryRemoteNow();
    };
  }

  private fillPeers(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("本设备"));
    const self = pane.createDiv({ cls: "vault-wip-card" });
    const selfHead = self.createDiv({ cls: "vault-wip-peer-head" });
    const collectedAt = snapshot.diagnostics.collectedAt;
    selfHead.createDiv({ cls: `vault-wip-dot ${collectedAt === null ? "is-old" : freshnessClass(collectedAt)}` });
    const selfTitle = selfHead.createDiv({ cls: "vault-wip-peer-title" });
    selfTitle.createDiv({
      cls: "vault-wip-peer-name",
      text: snapshot.selfLabel === "" ? t("（未命名）") : snapshot.selfLabel,
    });
    if (collectedAt !== null) {
      selfTitle.createDiv({ cls: "vault-wip-peer-meta", text: relativeTime(collectedAt) });
    }
    table(self, [
      [t("指纹"), snapshot.selfFingerprint],
      [t("仓库别名"), snapshot.alias],
    ]);
    if (snapshot.retired) {
      notice(pane, t("本设备已退役：需要重新注册才能继续使用。"), true);
    }

    heading(pane, t("对端"));
    const revoked = new Set(snapshot.revoked.map((entry) => entry.fingerprint));
    const active = snapshot.peers.filter((peer) => !revoked.has(peer.fingerprint));
    if (active.length === 0) {
      hint(pane, t("尚无可用的对端设备记录。"));
    }
    for (const peer of active) {
      peerBlock(pane, peer, (fingerprint) => {
        void this.plugin.revoke(fingerprint);
      });
    }

    if (snapshot.revoked.length > 0) {
      heading(pane, t("已被吊销"));
      const list = pane.createDiv({ cls: "vault-wip-card" });
      hint(list, t("下列设备不再参与判断。删除只从本机名单移除，该设备的记录会重新参与判断。"), true);
      for (const entry of snapshot.revoked) {
        const row = list.createDiv({ cls: "vault-wip-revoked-row" });
        const main = row.createDiv({ cls: "vault-wip-revoked-main" });
        const head = main.createDiv({ cls: "vault-wip-revoked-head" });
        head.createDiv({
          cls: "vault-wip-revoked-name",
          text: entry.name === "" ? t("设备 {fingerprint}", { fingerprint: entry.fingerprint.slice(0, 8) }) : entry.name,
        });
        const remove = head.createEl("button", { cls: "mod-warning", text: t("删除") });
        remove.style.color = "var(--text-error)";
        let confirming = false;
        remove.onclick = () => {
          if (!confirming) {
            confirming = true;
            remove.setText(t("确认移出本机名单"));
            return;
          }
          confirming = false;
          remove.setText(t("删除"));
          void this.plugin.unrevoke(entry.fingerprint);
        };
        const meta = main.createDiv({ cls: "vault-wip-revoked-meta" });
        meta.createSpan({
          cls: "vault-wip-revoked-fingerprint",
          text: entry.fingerprint,
          attr: { title: entry.fingerprint },
        });
        const when = revokedTimeText(entry);
        meta.createSpan({ cls: "vault-wip-revoked-time", text: when.text, attr: { title: when.title } });
      }
    }
  }

  private fillRelays(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("中继"));
    if (snapshot.relays.length === 0) {
      hintWithLink(pane);
      return;
    }
    if (snapshot.relays.every((relay) => relay.channelId === "")) {
      notice(pane, t("以下中继尚未完成注册。"));
    }
    if (snapshot.degraded) {
      notice(pane, t("有中继处于降级传输：通信不加密或可被冒充，此时不允许注册、吊销与退役。"), true);
    }

    for (const relay of snapshot.relays) {
      relayBlock(pane, relay);
    }
  }

  private fillDiagnostics(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("最近一次采集"));
    const collectedCard = pane.createDiv({ cls: "vault-wip-card" });
    table(collectedCard, [
      [t("采集时间"), clockText(snapshot.diagnostics.collectedAt)],
      [t("耗时"), collectMillisText(snapshot.diagnostics.collectMillis)],
      [t("git 版本"), snapshot.diagnostics.gitVersion ?? t("未知")],
    ]);

    heading(pane, t("本机计数"));
    const countCard = pane.createDiv({ cls: "vault-wip-card" });
    table(countCard, [[t("已上报序号"), String(snapshot.sequence)]]);
    hint(
      countCard,
      t(
        "序号由本设备自己推进，平时不必过问。只有在它已经无法继续推进时（例如上一条记录越过了可表示范围），才需要在这里重置；重置只改本机计数，不会改动中继上的任何数据。",
      ),
    );
    const countRow = countCard.createDiv({ cls: "vault-wip-actions" });
    const resetButton = countRow.createEl("button", { cls: "mod-warning", text: t("重置本机计数") });
    resetButton.onclick = () => {
      if (!this.confirmResetSequence) {
        this.confirmResetSequence = true;
        resetButton.setText(t("确认重置：下一次上报将从 1 重新对齐"));
        return;
      }
      this.confirmResetSequence = false;
      resetButton.setText(t("重置本机计数"));
      void this.plugin.resetSequence();
    };

    heading(pane, t("事件"));
    if (snapshot.diagnostics.events.length === 0) {
      hint(pane, t("尚无事件。"));
    } else {
      const log = pane.createDiv({ cls: "vault-wip-log" });
      for (const event of [...snapshot.diagnostics.events].reverse()) {
        log.createDiv({ cls: "vault-wip-log-line", text: event });
      }
    }

    if (snapshot.diagnostics.dropped.length > 0) {
      heading(pane, t("被舍弃的记录"));
      const droppedLog = pane.createDiv({ cls: "vault-wip-log" });
      for (const dropped of [...snapshot.diagnostics.dropped].reverse()) {
        droppedLog.createDiv({
          cls: "vault-wip-log-line",
          text: t("{at} 设备 {fingerprint}：{reason}", {
            at: dropped.at,
            fingerprint: dropped.fingerprint.slice(0, 8),
            reason: dropped.reason,
          }),
        });
      }
    }

    if (snapshot.diagnostics.anomalies.length > 0) {
      heading(pane, t("序号异常"));
      const anomalyLog = pane.createDiv({ cls: "vault-wip-log" });
      for (const anomaly of snapshot.diagnostics.anomalies) {
        anomalyLog.createDiv({
          cls: "vault-wip-log-line",
          text: t("设备 {fingerprint} 在序号 {incoming} 上出现了与序号 {known} 不同的内容", {
            fingerprint: anomaly.fingerprint.slice(0, 8),
            incoming: anomaly.incomingSequence,
            known: anomaly.knownSequence,
          }),
        });
      }
    }
  }

  /** 安全一栏里固定不变的部分：说明与输入框，只在首次进入时建一次。 */
  private buildSecurityOnce(): void {
    if (this.securityBuilt) {
      return;
    }
    const pane = this.panes.get("security");
    if (pane === undefined) {
      return;
    }

    hint(
      pane,
      t(
        "记录内容以仓库为范围端到端加密，中继只见到密文。内容密钥由本机生成，可以按下面三种方式交给同仓库的其他设备。",
      ),
      true,
    );

    const stringCard = section(pane, t("本机密钥串"));
    const stringActions = stringCard.createDiv({ cls: "vault-wip-actions" });
    const copyString = stringActions.createEl("button", { text: t("复制密钥串") });
    copyString.onclick = () => {
      const text = this.plugin.contentKeyText();
      if (text !== null) {
        void copyToClipboard(text, t("密钥串已复制到剪贴板"));
      }
    };
    const saveString = stringActions.createEl("button", { text: t("保存到文件") });
    saveString.onclick = () => {
      const text = this.plugin.contentKeyText();
      if (text !== null) {
        void this.plugin.writeExport("content-key.export", text).then((path) => {
          if (path !== null) {
            flash(pane, t("已写入 {path}；该文件应按机密文件保管。", { path }));
          }
        });
      }
    };

    const passphraseCard = section(pane, t("口令封装"));
    hint(
      passphraseCard,
      t(
        "口令封装的文件需要口令才能解开，可通过可信度较低的渠道传递；口令强度通常低于随机密钥串，因此列在密钥串之后。",
      ),
      true,
    );
    const passphraseRow = passphraseCard.createDiv({ cls: "vault-wip-actions" });
    const passphrase = passphraseRow.createEl("input", { type: "password" });
    passphrase.placeholder = t("口令");
    const copyProtected = passphraseRow.createEl("button", { text: t("复制封装的密钥") });
    copyProtected.onclick = () => {
      const text = this.plugin.protectedKey(passphrase.value);
      if (text !== null) {
        void copyToClipboard(text, t("封装的密钥已复制到剪贴板"));
      }
    };
    const saveProtected = passphraseRow.createEl("button", { text: t("保存到文件") });
    saveProtected.onclick = () => {
      const text = this.plugin.protectedKey(passphrase.value);
      if (text !== null) {
        void this.plugin.writeExport("content-key.protected", text).then((path) => {
          if (path !== null) {
            flash(pane, t("已写入 {path}；请连同口令一并交给目标设备。", { path }));
          }
        });
      }
    };

    const importCard = section(pane, t("导入密钥"));
    hint(importCard, t("粘贴另一台设备给出的密钥串或口令封装文本；口令留空表示文本本身即密钥串。"), true);
    const importRow = importCard.createDiv({ cls: "vault-wip-actions" });
    const importText = importRow.createEl("textarea", { cls: "vault-wip-textarea" });
    importText.placeholder = t("密钥串或口令封装文本");
    const importPassphrase = importRow.createEl("input", { type: "password" });
    importPassphrase.placeholder = t("口令（可留空）");
    const importButton = importRow.createEl("button", { text: t("导入并换用") });
    importButton.onclick = () => {
      void this.plugin.adoptKey(importText.value.trim(), importPassphrase.value).then(() => {
        importText.value = "";
      });
    };

    this.securityDynamic = pane.createDiv({ cls: "vault-wip-security-status" });

    heading(pane, t("危险操作"));
    const retireCard = section(pane, t("本设备"));
    const retireRow = retireCard.createDiv({ cls: "vault-wip-actions" });
    const retireButton = retireRow.createEl("button", { cls: "mod-warning", text: t("退役本设备") });
    retireButton.style.color = "var(--text-error)";
    retireButton.onclick = () => {
      if (!this.confirmRetire) {
        this.confirmRetire = true;
        retireButton.setText(t("确认退役：删除各中继上的本设备数据并记入吊销名单"));
        return;
      }
      this.confirmRetire = false;
      retireButton.setText(t("退役本设备"));
      void this.plugin.retire();
    };
    hint(
      retireCard,
      t("退役会删除各中继上本设备的数据，并将本设备记入吊销名单；此后须重新注册方可继续使用。"),
      true,
    );

    this.securityBuilt = true;
  }

  /** 安全一栏里随状态变化的部分。 */
  private renderSecurityDynamic(snapshot: EngineSnapshot | null): void {
    const container = this.securityDynamic;
    if (container === null) {
      return;
    }
    container.empty();
    if (snapshot === null) {
      return;
    }

    heading(container, t("身份与状态"));

    const infoCard = container.createDiv({ cls: "vault-wip-card" });
    table(infoCard, [
      [t("内容密钥标识"), snapshot.contentKeyId],
      [t("本设备是否已退役"), snapshot.retired ? t("是") : t("否")],
    ]);

    const identityCard = section(container, t("中继身份"));
    hint(
      identityCard,
      t("首次配对时中继的公钥无从核验，只能先予接受；请将下列指纹与中继一侧核对一次。此后公钥一旦变化，本机将停止采用其回应。"),
      true,
    );
    for (const relay of snapshot.relays) {
      table(identityCard, [
        [t("{name} 的公钥指纹", { name: relay.name }), relay.fingerprint ?? t("尚未配对")],
        [t("{name} 的证书指纹", { name: relay.name }), relay.spki ?? t("不使用或尚未钉住")],
      ]);
    }

    if (snapshot.revoked.some((entry) => entry.fingerprint === snapshot.selfFingerprint)) {
      notice(container, t("本设备指纹已在吊销名单中；须由中继侧恢复后方可继续使用。"), true);
    }
  }

  private updateTabs(): void {
    for (const [name, button] of this.tabButtons) {
      button.setText(tabLabel(name));
      button.classList.toggle("is-active", name === this.tab);
    }
  }
}

/** 概览顶部的四个数字：一眼看清当前处境的规模。 */
function overviewStats(parent: HTMLElement, snapshot: EngineSnapshot): void {
  const grid = parent.createDiv({ cls: "vault-wip-stats" });
  stat(grid, String(snapshot.local?.count ?? 0), t("本机改动"));
  const active = snapshot.peers.filter(
    (peer) => !snapshot.revoked.some((entry) => entry.fingerprint === peer.fingerprint),
  );
  const online = active.filter((peer) => isOnline(peer.collectedAt)).length;
  stat(grid, `${String(online)}/${String(active.length)}`, t("在线对端"));
  stat(grid, String(snapshot.conflicts.length), t("冲突"));
  stat(grid, String(snapshot.relays.filter((relay) => relay.lastFailure === null).length), t("可用中继"));
}

/** 一个数字配一行说明。 */
function stat(parent: HTMLElement, value: string, label: string): void {
  const box = parent.createDiv({ cls: "vault-wip-stat" });
  box.createDiv({ cls: "vault-wip-stat-value", text: value });
  box.createDiv({ cls: "vault-wip-stat-label", text: label });
}

/** 中继服务端的项目地址；尚未配置中继时指给使用者。 */
const RELAY_PROJECT_URL = "https://github.com/y1chu666/wip-relay";

/** 尚未配置中继时的提示，末尾给出项目地址。 */
function hintWithLink(parent: HTMLElement): void {
  const line = parent.createDiv({ cls: "vault-wip-warning" });
  line.createSpan({ text: t("尚未配置中继：请先在设置中添加地址；中继服务端见 ") });
  line.createEl("a", { href: RELAY_PROJECT_URL, text: t("WIP Relay 项目") });
}

/** 一张带标题的卡片，安全一栏的各个小节都用它分开。 */
function section(parent: HTMLElement, title: string): HTMLElement {
  const card = parent.createDiv({ cls: "vault-wip-card" });
  card.createDiv({ cls: "vault-wip-card-title", text: title });
  return card;
}

/** 小节标题。 */
function heading(parent: HTMLElement, text: string): HTMLElement {
  return parent.createEl("h4", { text });
}

/** 说明性文字：小字灰色，与正文分开；紧跟在标题后时不再留上边距。 */
function hint(parent: HTMLElement, text: string, flush = false): HTMLElement {
  return parent.createDiv({ cls: flush ? "vault-wip-hint is-flush" : "vault-wip-hint", text });
}

/** 一条带标题的警示块：冲突、退役与连接问题都用它，形状固定。 */
function notice(parent: HTMLElement, title: string, isError = false): HTMLElement {
  const block = parent.createDiv({ cls: isError ? "vault-wip-notice is-error" : "vault-wip-notice" });
  block.createDiv({ cls: "vault-wip-notice-title", text: title });
  return block;
}

/**
 * 吊销时间的写法：当年省去年份，跨年只留日期。
 *
 * 相对时间只在三十天内附上：再久「多少天前」就没有信息量，反而挤掉日期。
 * 完整时刻放在悬停里，行内不必写全。
 */
function revokedTimeText(entry: RevokedDevice): { text: string; title: string } {
  if (entry.revokedAt === null) {
    return { text: t("时间未知"), title: "" };
  }
  const moment = new Date(entry.revokedAt);
  if (Number.isNaN(moment.getTime())) {
    return { text: entry.revokedAt, title: entry.revokedAt };
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  const sameYear = moment.getFullYear() === new Date().getFullYear();
  const date = sameYear
    ? `${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`
    : `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
  const age = Date.now() - moment.getTime();
  const withinMonth = age >= 0 && age <= 30 * 24 * 60 * 60 * 1000;
  return {
    text: withinMonth ? `${date}${t(" · ")}${relativeTime(entry.revokedAt)}` : date,
    title: moment.toLocaleString(),
  };
}

/** 一张两列的小表。 */
function table(parent: HTMLElement, rows: readonly (readonly [string, string])[]): void {
  const list = parent.createEl("table", { cls: "vault-wip-table" });
  for (const [name, value] of rows) {
    const row = list.createEl("tr");
    row.createEl("td", { text: name }).style.paddingRight = "0.75em";
    row.createEl("td", { text: value }).style.wordBreak = "break-all";
  }
}

/** 改动类型的展示信息：图标、配色类与名称。 */
const KIND_DISPLAY: readonly {
  readonly code: string;
  readonly icon: string;
  readonly cls: string;
  readonly text: (count: number) => string;
}[] = [
  { code: "A", icon: "file-plus", cls: "is-added", text: (count) => t("新增 {count} 个", { count }) },
  { code: "M", icon: "pencil", cls: "is-modified", text: (count) => t("修改 {count} 个", { count }) },
  { code: "D", icon: "file-minus", cls: "is-deleted", text: (count) => t("删除 {count} 个", { count }) },
  { code: "R", icon: "arrow-right-left", cls: "is-renamed", text: (count) => t("重命名 {count} 个", { count }) },
  { code: "U", icon: "triangle-alert", cls: "is-unmerged", text: (count) => t("冲突 {count} 个", { count }) },
  { code: "?", icon: "file-question", cls: "is-untracked", text: (count) => t("未跟踪 {count} 个", { count }) },
  { code: "", icon: "file", cls: "is-unknown", text: (count) => t("类型未知 {count} 个", { count }) },
];

/** 按类型计数，供统计块与分组共用。 */
function countKinds(kinds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/** 顶部统计块：一眼看出各类改动各有多少，颜色只作辅助，文字与图标才是依据。 */
function kindChips(parent: HTMLElement, payload: StatusPayload): void {
  const counts = countKinds(payload.kinds);
  const chips = parent.createDiv({ cls: "vault-wip-kinds" });
  for (const kind of KIND_DISPLAY) {
    const count = counts.get(kind.code) ?? 0;
    if (count === 0) {
      continue;
    }
    const chip = chips.createEl("span", { cls: `vault-wip-kind ${kind.cls}` });
    setIcon(chip.createEl("span", { cls: "vault-wip-kind-icon" }), kind.icon);
    chip.createEl("span", { text: kind.text(count) });
  }
}

/** 按类型分组的文件清单，每组默认折叠，文件多时不必先滚过一屏。 */
function groupedFiles(
  parent: HTMLElement,
  paths: readonly string[],
  kinds: readonly string[],
  scope: string,
): void {
  if (paths.length === 0) {
    parent.createDiv({ text: t("没有改动文件。") });
    return;
  }

  const grouped = new Map<string, string[]>();
  for (const [index, path] of paths.entries()) {
    const code = kinds[index] ?? "";
    const list = grouped.get(code) ?? [];
    list.push(path);
    grouped.set(code, list);
  }

  for (const kind of KIND_DISPLAY) {
    const entries = grouped.get(kind.code);
    if (entries === undefined || entries.length === 0) {
      continue;
    }
    const details = parent.createEl("details", { cls: `vault-wip-group ${kind.cls}` });
    const key = `${scope}:${kind.code}`;
    details.open = expandedGroups.get(key) ?? false;
    details.addEventListener("toggle", () => {
      expandedGroups.set(key, details.open);
    });
    const summary = details.createEl("summary", { cls: "vault-wip-group-title" });
    setIcon(summary.createEl("span", { cls: "vault-wip-chevron" }), "chevron-right");
    setIcon(summary.createEl("span", { cls: "vault-wip-kind-icon" }), kind.icon);
    summary.createEl("span", { text: kind.text(entries.length) });

    for (const path of entries.slice(0, MAX_LISTED_PATHS)) {
      fileRow(details, path, kind);
    }
    if (entries.length > MAX_LISTED_PATHS) {
      details.createDiv({
        cls: "vault-wip-file-more",
        text: t("另有 {count} 个文件未列出。", { count: entries.length - MAX_LISTED_PATHS }),
      });
    }
  }
}

/**
 * 一行文件：类型徽章、目录与文件名分开着色，悬停给出完整路径。
 * 路径与文件名都可能很长，因此不截断，改为按可用宽度换行：目录在斜杠后断开，
 * 文件名优先整体换到下一行，宽度仍不足时才在名字内部折行。
 */
function fileRow(
  parent: HTMLElement,
  path: string,
  kind: (typeof KIND_DISPLAY)[number],
): void {
  const row = parent.createDiv({ cls: "vault-wip-file", attr: { title: path } });
  setIcon(row.createEl("span", { cls: `vault-wip-badge ${kind.cls}` }), kind.icon);
  const text = row.createDiv({ cls: "vault-wip-file-path" });
  const slash = path.lastIndexOf("/");
  if (slash >= 0) {
    const dir = text.createEl("span", { cls: "vault-wip-file-dir" });
    for (const segment of path.slice(0, slash + 1).split("/").slice(0, -1)) {
      dir.appendText(`${segment}/`);
      dir.createEl("wbr");
    }
  }
  text.createEl("span", { cls: "vault-wip-file-name", text: path.slice(slash + 1) });
}

/** 假冲突的提示：只影响措辞，不影响是否算冲突。 */
function suspectNotes(parent: HTMLElement, payload: StatusPayload): void {
  if (payload.suspectFiles.length === 0 && payload.conflictFiles.length === 0) {
    return;
  }
  const parts: string[] = [];
  if (payload.suspectFiles.length > 0) {
    parts.push(t("{count} 个文件的差异仅在行尾或权限位", { count: payload.suspectFiles.length }));
  }
  if (payload.conflictFiles.length > 0) {
    parts.push(t("{count} 个文件留有合并冲突的痕迹", { count: payload.conflictFiles.length }));
  }
  hint(parent, parts.join(t("；")));
}

/** 一行冲突。 */
function conflictLine(parent: HTMLElement, conflict: Conflict): void {
  const names = conflict.peers.map((peer) => peer.name).join(t("、"));
  const caution =
    conflict.localSuspect || conflict.peerSuspect ? t("（其中一边的差异仅在行尾或权限位）") : "";
  hint(parent, t("{path}：与 {names} 的改动重叠{caution}", { path: conflict.path, names, caution }));
}

/** 概览里的一台对端：只看规模与时间，明细展开才出现。 */
function overviewPeer(parent: HTMLElement, peer: DeviceStatus): void {
  const block = parent.createDiv({ cls: "vault-wip-peer" });
  const head = block.createDiv({ cls: "vault-wip-peer-head" });
  head.createDiv({ cls: `vault-wip-dot ${freshnessClass(peer.collectedAt)}` });
  const title = head.createDiv({ cls: "vault-wip-peer-title" });
  title.createDiv({ cls: "vault-wip-peer-name", text: displayName(peer) });
  title.createDiv({
    cls: "vault-wip-peer-meta",
    text: t("{count} 个文件 · {time}", { count: peer.payload.count, time: relativeTime(peer.collectedAt) }),
  });
  if (peer.payload.truncated) {
    hint(block, t("清单过长，采集时已截断。"));
  }
  kindChips(block, peer.payload);
  groupedFiles(block, peer.payload.paths, peer.payload.kinds, `peer:${peer.fingerprint}`);
  suspectNotes(block, peer.payload);
}

/** 一台对端的状态。 */
function peerBlock(parent: HTMLElement, peer: DeviceStatus, onRevoke: (fingerprint: string) => void): void {
  const block = parent.createDiv({ cls: "vault-wip-peer" });
  const head = block.createDiv({ cls: "vault-wip-peer-head" });
  head.createDiv({
    cls: `vault-wip-dot ${freshnessClass(peer.collectedAt)}`,
    attr: { title: peer.fingerprint },
  });
  const title = head.createDiv({ cls: "vault-wip-peer-title" });
  title.createDiv({ cls: "vault-wip-peer-name", text: displayName(peer) });
  title.createDiv({ cls: "vault-wip-peer-meta", text: relativeTime(peer.collectedAt) });
  const revoke = head.createEl("button", { cls: "vault-wip-revoke", text: t("吊销这台设备") });
  revoke.onclick = () => {
    onRevoke(peer.fingerprint);
  };

  table(block, [
    [t("指纹"), peer.fingerprint],
    [t("序号"), String(peer.sequence)],
    [t("采集时间"), clockText(peer.collectedAt)],
  ]);
}

/** 十分钟内上报过即视为在线；中继不保存在线状态，只能按记录时间推断。 */
function isOnline(collectedAt: string): boolean {
  const then = Date.parse(collectedAt);
  if (Number.isNaN(then)) {
    return false;
  }
  return Date.now() - then <= 600_000;
}

/** 记录的新鲜度：一分钟内为新鲜，十分钟内为偏旧，更久为陈旧。 */
function freshnessClass(collectedAt: string): string {
  const then = Date.parse(collectedAt);
  if (Number.isNaN(then)) {
    return "is-old";
  }
  const seconds = (Date.now() - then) / 1000;
  if (seconds <= 60) {
    return "is-fresh";
  }
  if (seconds <= 600) {
    return "is-stale";
  }
  return "is-old";
}

/** 相对时间：比绝对时刻更容易判断一条记录有多旧。 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return t("{count} 秒前", { count: seconds });
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return t("{count} 分钟前", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t("{count} 小时前", { count: hours });
  }
  return t("{count} 天前", { count: Math.round(hours / 24) });
}

/** 一台中继的现状。 */
function relayBlock(parent: HTMLElement, relay: RelayStatus): void {
  const block = parent.createDiv({ cls: "vault-wip-relay" });
  const head = block.createDiv({ cls: "vault-wip-peer-head" });
  const state = relay.lastFailure !== null ? "is-bad" : relay.channelId === "" ? "is-old" : "is-fresh";
  head.createDiv({ cls: `vault-wip-dot ${state}` });
  const title = head.createDiv({ cls: "vault-wip-peer-title" });
  title.createDiv({ cls: "vault-wip-peer-name", text: relay.name });
  title.createDiv({ cls: "vault-wip-peer-meta", text: relay.url });

  table(block, [
    [t("传输级别"), levelText(relay)],
    [t("频道标识"), relay.channelId === "" ? t("尚未注册") : relay.channelId],
    [t("最近一次成功"), clockText(relay.lastSuccessAt)],
  ]);
  if (relay.lastFailure !== null) {
    block.createDiv({ cls: "vault-wip-error", text: t("最近一次失败：{reason}", { reason: relay.lastFailure }) });
  }
  if (relay.degraded) {
    const warn = block.createDiv({ cls: "vault-wip-warning" });
    warn.setText(t("这一级属于降级传输：注册、吊销与退役在此不可用。"));
  }
}

function levelText(relay: RelayStatus): string {
  const names: Record<string, string> = {
    https: t("公开证书"),
    pinned: t("钉住自签证书"),
    insecure: t("忽略证书错误（降级）"),
    plaintext: t("明文（降级）"),
  };
  return names[relay.level] ?? relay.level;
}

/** 采集耗时的写法：还没采集过时如实说不知道。 */
function collectMillisText(millis: number | null): string {
  return millis === null ? t("未知") : t("{millis} 毫秒", { millis });
}

/** 把协调世界时的时间文本折算成本地时间显示。 */
function clockText(text: string | null): string {
  if (text === null) {
    return t("无");
  }
  const moment = new Date(text);
  return Number.isNaN(moment.getTime()) ? text : moment.toLocaleString();
}

/** 把一段文本放到剪贴板上。 */
async function copyToClipboard(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(t("{name}：{text}", { name: PLUGIN_NAME, text: message }));
  } catch {
    new Notice(t("{name}：{text}", { name: PLUGIN_NAME, text: t("复制失败，请改用保存到文件") }), 0);
  }
}

/** 在界面上留一句短提示。 */
function flash(parent: HTMLElement, text: string): void {
  const element = parent.createDiv({ cls: "vault-wip-flash", text });
  window.setTimeout(() => {
    element.remove();
  }, 6000);
}
