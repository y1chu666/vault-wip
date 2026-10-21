// 状态视图：把引擎给出的现状画成五个分栏。
//
// 这里只显示与触发动作，不做判断：判断都在 src/core 里，免得同一套规则在界面上
// 再写一遍。界面本身不进覆盖率统计，因此它保持直白：取一份现状，逐块填上文字。
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";

import { displayName, type Conflict, type DeviceStatus } from "./core/state.js";
import type { EngineSnapshot, RelayStatus } from "./core/engine.js";
import { PLUGIN_NAME, t } from "./core/i18n.js";
import { refName, remoteSummary } from "./core/remote.js";
import type { StatusPayload } from "./core/payload.js";
import type VaultWipPlugin from "./main.js";

export const VIEW_TYPE = "vault-wip-view";

type TabName = "overview" | "peers" | "relays" | "security" | "diagnostics";

const TABS: readonly TabName[] = ["overview", "peers", "relays", "security", "diagnostics"];

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

  /** 按当前现状重画一遍。 */
  render(): void {
    this.updateTabs();
    const snapshot = this.plugin.snapshot();
    const error = this.plugin.configErrorText();

    for (const [name, pane] of this.panes) {
      pane.style.display = name === this.tab ? "block" : "none";
    }

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
        pane.createDiv({ text: t("配置文件：{path}", { path }) });
      }
      return;
    }
    if (snapshot === null) {
      pane.createDiv({ text: t("尚未就绪：请先在设置中填写中继信息。") });
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
    heading(pane, t("本设备"));
    table(pane, [
      [t("名称"), snapshot.selfLabel === "" ? t("（未命名）") : snapshot.selfLabel],
      [t("指纹"), snapshot.selfFingerprint],
      [t("已上报序号"), String(snapshot.sequence)],
      [t("仓库别名"), snapshot.alias],
    ]);
    if (snapshot.retired) {
      pane.createDiv({ text: t("本设备已退役：需要重新注册才能继续使用。") });
    }

    if (snapshot.local === null) {
      heading(pane, t("本机改动"));
      pane.createDiv({ text: t("尚未取得本机状态。") });
    } else {
      const local = snapshot.local;
      const card = pane.createDiv({ cls: "vault-wip-card" });
      const head = card.createDiv({ cls: "vault-wip-card-head" });
      head.createDiv({ cls: "vault-wip-card-title", text: t("本机改动") });
      head.createDiv({ cls: "vault-wip-card-meta", text: snapshot.diagnostics.collectedAt === null ? "" : relativeTime(snapshot.diagnostics.collectedAt) });
      table(card, [
        [t("改动文件"), String(local.count)],
        [t("清单是否截断"), local.truncated ? t("是") : t("否")],
      ]);
      kindChips(card, local);
      groupedFiles(card, local.paths, local.kinds);
      suspectNotes(card, local);
    }

    heading(pane, t("各端改动"));
    if (snapshot.peers.length === 0) {
      pane.createDiv({ text: t("尚无可用的对端记录。") });
    } else {
      for (const peer of snapshot.peers) {
        overviewPeer(pane, peer);
      }
    }

    heading(pane, t("与对端的冲突"));
    if (snapshot.conflicts.length === 0) {
      pane.createDiv({ text: t("未发现两端改动同一文件。") });
    } else {
      for (const conflict of snapshot.conflicts) {
        conflictLine(pane, conflict);
      }
    }

    heading(pane, t("远端查询"));
    const remote = snapshot.remote;
    table(pane, [
      [t("远端"), remote !== null && "remote" in remote ? refName(remote) : t("无")],
      [t("上次查询"), clockText(snapshot.remoteQueriedAt)],
    ]);
    pane.createDiv({ text: remoteSummary(remote) });

    const actions = pane.createDiv({ cls: "vault-wip-actions" });
    const button = actions.createEl("button", { text: t("立即采集并上报") });
    button.onclick = () => {
      void this.plugin.reportNow();
    };
    const queryButton = actions.createEl("button", { text: t("查询远端") });
    queryButton.onclick = () => {
      void this.plugin.queryRemoteNow();
    };
  }

  private fillPeers(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("各端状态"));
    const active = snapshot.peers.filter((peer) => !snapshot.revoked.includes(peer.fingerprint));
    if (active.length === 0) {
      pane.createDiv({ text: t("尚无可用的对端设备记录。") });
    }
    for (const peer of active) {
      peerBlock(pane, peer, (fingerprint) => {
        void this.plugin.revoke(fingerprint);
      });
    }

    if (snapshot.revoked.length > 0) {
      heading(pane, t("已被吊销"));
      pane.createDiv({
        text: t("下列设备的记录此后不再参与判断；吊销名单长期保留，不会自行消失。"),
      });
      for (const fingerprint of snapshot.revoked) {
        pane.createDiv({ text: fingerprint });
      }
    }
  }

  private fillRelays(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("中继"));
    if (snapshot.relays.length === 0) {
      pane.createDiv({ text: t("尚未配置中继：请先在设置中添加。") });
      return;
    }
    if (snapshot.degraded) {
      const warn = pane.createDiv({ cls: "vault-wip-warning" });
      warn.setText(t("有中继处于降级传输：通信不加密或可被冒充，此时不允许注册、吊销与退役。"));
    }

    for (const relay of snapshot.relays) {
      relayBlock(pane, relay);
    }
  }

  private fillDiagnostics(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("最近一次采集"));
    table(pane, [
      [t("采集时间"), clockText(snapshot.diagnostics.collectedAt)],
      [t("耗时"), collectMillisText(snapshot.diagnostics.collectMillis)],
      [t("git 版本"), snapshot.diagnostics.gitVersion ?? t("未知")],
    ]);

    heading(pane, t("本机计数"));
    table(pane, [[t("已上报序号"), String(snapshot.sequence)]]);
    pane.createDiv({
      text: t(
        "序号由本设备自己推进，平时不必过问。只有在它已经无法继续推进时（例如上一条记录越过了可表示范围），才需要在这里重置；重置只改本机计数，不会改动中继上的任何数据。",
      ),
    });
    const countRow = pane.createDiv({ cls: "vault-wip-actions" });
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
      pane.createDiv({ text: t("尚无事件。") });
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

    pane.createDiv({
      text: t(
        "记录内容以仓库为范围端到端加密，中继只见到密文。内容密钥由本机生成，可以按下面三种方式交给同仓库的其他设备。",
      ),
    });

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
    passphraseCard.createDiv({
      text: t(
        "口令封装的文件需要口令才能解开，可通过可信度较低的渠道传递；口令强度通常低于随机密钥串，因此列在密钥串之后。",
      ),
    });
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
    importCard.createDiv({ text: t("粘贴另一台设备给出的密钥串或口令封装文本；口令留空表示文本本身即密钥串。") });
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
    retireCard.createDiv({
      text: t("退役会删除各中继上本设备的数据，并将本设备记入吊销名单；此后须重新注册方可继续使用。"),
    });

    this.securityDynamic = pane.createDiv({ cls: "vault-wip-security-status" });
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

    const infoCard = container.createDiv({ cls: "vault-wip-card" });
    table(infoCard, [
      [t("内容密钥标识"), snapshot.contentKeyId],
      [t("本设备是否已退役"), snapshot.retired ? t("是") : t("否")],
    ]);

    const identityCard = section(container, t("中继身份"));
    identityCard.createDiv({
      text: t("首次配对时中继的公钥无从核验，只能先予接受；请将下列指纹与中继一侧核对一次。此后公钥一旦变化，本机将停止采用其回应。"),
    });
    for (const relay of snapshot.relays) {
      table(identityCard, [
        [t("{name} 的公钥指纹", { name: relay.name }), relay.fingerprint ?? t("尚未配对")],
        [t("{name} 的证书指纹", { name: relay.name }), relay.spki ?? t("不使用或尚未钉住")],
      ]);
    }

    if (snapshot.revoked.includes(snapshot.selfFingerprint)) {
      container.createDiv({ text: t("本设备指纹已在吊销名单中；须由中继侧恢复后方可继续使用。") });
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
  stat(grid, String(snapshot.peers.length), t("对端设备"));
  stat(grid, String(snapshot.conflicts.length), t("冲突"));
  stat(grid, String(snapshot.relays.filter((relay) => relay.lastFailure === null).length), t("可用中继"));
}

/** 一个数字配一行说明。 */
function stat(parent: HTMLElement, value: string, label: string): void {
  const box = parent.createDiv({ cls: "vault-wip-stat" });
  box.createDiv({ cls: "vault-wip-stat-value", text: value });
  box.createDiv({ cls: "vault-wip-stat-label", text: label });
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
function groupedFiles(parent: HTMLElement, paths: readonly string[], kinds: readonly string[]): void {
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

/** 一行文件：类型徽章、目录与文件名分开着色，悬停给出完整路径。 */
function fileRow(
  parent: HTMLElement,
  path: string,
  kind: (typeof KIND_DISPLAY)[number],
): void {
  const row = parent.createDiv({ cls: "vault-wip-file", attr: { title: path } });
  setIcon(row.createEl("span", { cls: `vault-wip-badge ${kind.cls}` }), kind.icon);
  const slash = path.lastIndexOf("/");
  if (slash >= 0) {
    row.createEl("span", { cls: "vault-wip-file-dir", text: path.slice(0, slash + 1) });
  }
  row.createEl("span", { cls: "vault-wip-file-name", text: path.slice(slash + 1) });
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
  parent.createDiv({ text: parts.join(t("；")) });
}

/** 一行冲突。 */
function conflictLine(parent: HTMLElement, conflict: Conflict): void {
  const names = conflict.peers.map((peer) => peer.name).join(t("、"));
  const caution =
    conflict.localSuspect || conflict.peerSuspect ? t("（其中一边的差异仅在行尾或权限位）") : "";
  parent.createDiv({ text: t("{path}：与 {names} 的改动重叠{caution}", { path: conflict.path, names, caution }) });
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
    text: `${String(peer.payload.count)} · ${relativeTime(peer.collectedAt)}`,
  });
  table(block, [
    [t("清单是否截断"), peer.payload.truncated ? t("是") : t("否")],
  ]);
  kindChips(block, peer.payload);
  groupedFiles(block, peer.payload.paths, peer.payload.kinds);
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
