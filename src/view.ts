// 状态视图：把引擎给出的现状画成五个分栏。
//
// 这里只显示与触发动作，不做判断：判断都在 src/core 里，免得同一套规则在界面上
// 再写一遍。界面本身不进覆盖率统计，因此它保持直白：取一份现状，逐块填上文字。
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";

import { displayName, type Conflict, type DeviceStatus } from "./core/state.js";
import type { EngineSnapshot, RelayStatus } from "./core/engine.js";
import { PLUGIN_NAME, t } from "./core/i18n.js";
import type { StatusPayload } from "./core/payload.js";
import type VaultWaystationPlugin from "./main.js";

export const VIEW_TYPE = "vault-waystation-view";

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

export class WaystationView extends ItemView {
  private tab: TabName = "overview";
  private readonly panes = new Map<TabName, HTMLElement>();
  private readonly tabButtons = new Map<TabName, HTMLButtonElement>();
  private securityDynamic: HTMLElement | null = null;
  private securityBuilt = false;
  private confirmRetire = false;
  private confirmResetSequence = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultWaystationPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Vault Waystation";
  }

  override getIcon(): string {
    return "radio-tower";
  }

  override onOpen(): Promise<void> {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: "waystation-view" });

    const tabs = root.createDiv({ cls: "waystation-tabs" });
    tabs.style.display = "flex";
    tabs.style.gap = "0.5em";
    tabs.style.marginBottom = "0.75em";

    const body = root.createDiv({ cls: "waystation-body" });
    for (const name of TABS) {
      const button = tabs.createEl("button", { text: tabLabel(name) });
      button.onclick = () => {
        this.tab = name;
        this.updateTabs();
        this.render();
      };
      this.tabButtons.set(name, button);
      this.panes.set(name, body.createDiv({ cls: `waystation-pane waystation-${name}` }));
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
      const warn = pane.createDiv({ cls: "waystation-error" });
      warn.setText(t("配置有误：{error}", { error }));
      const path = this.plugin.configPath();
      if (path !== null) {
        pane.createDiv({ text: t("配置文件：{path}", { path }) });
      }
      return;
    }
    if (snapshot === null) {
      pane.createDiv({ text: t("尚未就绪：请在设置里填好中继信息。") });
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
    const self = heading(pane, t("本设备"));
    table(self, [
      [t("名称"), snapshot.selfLabel === "" ? t("（未命名）") : snapshot.selfLabel],
      [t("指纹"), snapshot.selfFingerprint],
      [t("已上报序号"), String(snapshot.sequence)],
      [t("仓库别名"), snapshot.alias],
    ]);
    if (snapshot.retired) {
      pane.createDiv({ text: t("本设备已退役：需要重新注册才能继续使用。") });
    }

    heading(pane, t("本机改动"));
    if (snapshot.local === null) {
      pane.createDiv({ text: t("尚未取得本机状态。") });
    } else {
      const local = snapshot.local;
      table(pane, [
        [t("改动文件"), String(local.count)],
        [t("清单是否截断"), local.truncated ? t("是") : t("否")],
      ]);
      pathList(pane, local.paths);
      suspectNotes(pane, local);
    }

    heading(pane, t("与对端的冲突"));
    if (snapshot.conflicts.length === 0) {
      pane.createDiv({ text: t("没有发现两端改到同一个文件。") });
    } else {
      for (const conflict of snapshot.conflicts) {
        conflictLine(pane, conflict);
      }
    }

    const actions = pane.createDiv({ cls: "waystation-actions" });
    const button = actions.createEl("button", { text: t("立即采集并上报") });
    button.onclick = () => {
      void this.plugin.reportNow();
    };
  }

  private fillPeers(pane: HTMLElement, snapshot: EngineSnapshot): void {
    heading(pane, t("各端状态"));
    const active = snapshot.peers.filter((peer) => !snapshot.revoked.includes(peer.fingerprint));
    if (active.length === 0) {
      pane.createDiv({ text: t("还没有收到其他设备的记录。") });
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
      pane.createDiv({ text: t("尚未配置中继：请在插件设置里添加一台。") });
      return;
    }
    if (snapshot.degraded) {
      const warn = pane.createDiv({ cls: "waystation-warning" });
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
        "序号由本设备自己推进，平时不必过问。只有在它已经无法继续推进时（例如上一条记录越过了可表示范围），才需要在这里重置；重置只改本机计数，中继上的数据一条不动。",
      ),
    });
    const countRow = pane.createDiv({ cls: "waystation-actions" });
    const resetButton = countRow.createEl("button", { text: t("重置本机计数") });
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
      for (const event of [...snapshot.diagnostics.events].reverse()) {
        pane.createDiv({ text: event });
      }
    }

    if (snapshot.diagnostics.dropped.length > 0) {
      heading(pane, t("被舍弃的记录"));
      for (const dropped of [...snapshot.diagnostics.dropped].reverse()) {
        pane.createDiv({
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
      for (const anomaly of snapshot.diagnostics.anomalies) {
        pane.createDiv({
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

    heading(pane, t("本机密钥串"));
    const stringActions = pane.createDiv({ cls: "waystation-actions" });
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
            flash(pane, t("已写入 {path}：请按秘密看待这个文件。", { path }));
          }
        });
      }
    };

    heading(pane, t("口令封装"));
    pane.createDiv({
      text: t(
        "口令封装的文件仍需要口令才能解开，可以走不那么可信的渠道；口令往往比随机密钥串弱，因此这种方式排在密钥串之后。",
      ),
    });
    const passphraseRow = pane.createDiv({ cls: "waystation-actions" });
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
            flash(pane, t("已写入 {path}：连同口令一起交给另一台设备。", { path }));
          }
        });
      }
    };

    heading(pane, t("导入密钥"));
    pane.createDiv({ text: t("把另一台设备给出的密钥串或口令封装文本粘贴进来；口令留空表示文本是密钥串本身。") });
    const importRow = pane.createDiv({ cls: "waystation-actions" });
    const importText = importRow.createEl("textarea", { cls: "waystation-textarea" });
    importText.placeholder = t("密钥串或口令封装文本");
    const importPassphrase = importRow.createEl("input", { type: "password" });
    importPassphrase.placeholder = t("口令（可留空）");
    const importButton = importRow.createEl("button", { text: t("导入并换用") });
    importButton.onclick = () => {
      void this.plugin.adoptKey(importText.value.trim(), importPassphrase.value).then(() => {
        importText.value = "";
      });
    };

    heading(pane, t("本设备"));
    const retireRow = pane.createDiv({ cls: "waystation-actions" });
    const retireButton = retireRow.createEl("button", { text: t("退役本设备") });
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
    pane.createDiv({
      text: t("退役会删除各中继上本设备的数据，并把本设备记入吊销名单；此后需要重新向中继注册才能继续使用。"),
    });

    this.securityDynamic = pane.createDiv({ cls: "waystation-security-status" });
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

    table(container, [
      [t("内容密钥标识"), snapshot.contentKeyId],
      [t("本设备是否已退役"), snapshot.retired ? t("是") : t("否")],
    ]);

    heading(container, t("中继身份"));
    container.createDiv({
      text: t("首次配对时中继的公钥没有旁证，只能先收下；把下面的指纹与中继那一侧核对一次，此后换了钥匙就会停下来。"),
    });
    for (const relay of snapshot.relays) {
      table(container, [
        [t("{name} 的公钥指纹", { name: relay.name }), relay.fingerprint ?? t("尚未配对")],
        [t("{name} 的证书指纹", { name: relay.name }), relay.spki ?? t("不使用或尚未钉住")],
      ]);
    }

    if (snapshot.revoked.includes(snapshot.selfFingerprint)) {
      container.createDiv({ text: t("本设备的指纹出现在吊销名单里，需要中继那边恢复之后才能继续使用。") });
    }
  }

  private updateTabs(): void {
    for (const [name, button] of this.tabButtons) {
      button.setText(tabLabel(name));
      button.style.fontWeight = name === this.tab ? "600" : "400";
    }
  }
}

/** 小节标题。 */
function heading(parent: HTMLElement, text: string): HTMLElement {
  const element = parent.createEl("h4", { text });
  element.style.marginTop = "1em";
  element.style.marginBottom = "0.35em";
  return element;
}

/** 一张两列的小表。 */
function table(parent: HTMLElement, rows: readonly (readonly [string, string])[]): void {
  const list = parent.createEl("table", { cls: "waystation-table" });
  for (const [name, value] of rows) {
    const row = list.createEl("tr");
    row.createEl("td", { text: name }).style.paddingRight = "0.75em";
    row.createEl("td", { text: value }).style.wordBreak = "break-all";
  }
}

/** 一段文件名清单，过长时只列前若干条。 */
function pathList(parent: HTMLElement, paths: readonly string[]): void {
  if (paths.length === 0) {
    parent.createDiv({ text: t("没有改动文件。") });
    return;
  }
  for (const path of paths.slice(0, MAX_LISTED_PATHS)) {
    parent.createDiv({ text: path });
  }
  if (paths.length > MAX_LISTED_PATHS) {
    parent.createDiv({ text: t("另有 {count} 个文件未列出。", { count: paths.length - MAX_LISTED_PATHS }) });
  }
}

/** 假冲突的提示：只影响措辞，不影响是否算冲突。 */
function suspectNotes(parent: HTMLElement, payload: StatusPayload): void {
  if (payload.suspectFiles.length === 0 && payload.conflictFiles.length === 0) {
    return;
  }
  const parts: string[] = [];
  if (payload.suspectFiles.length > 0) {
    parts.push(t("{count} 个文件的差异看来只是行尾或权限位", { count: payload.suspectFiles.length }));
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
    conflict.localSuspect || conflict.peerSuspect ? t("（其中一边的差异看来只是行尾或权限位）") : "";
  parent.createDiv({ text: t("{path}：与 {names} 的重叠{caution}", { path: conflict.path, names, caution }) });
}

/** 一台对端的状态。 */
function peerBlock(parent: HTMLElement, peer: DeviceStatus, onRevoke: (fingerprint: string) => void): void {
  const block = parent.createDiv({ cls: "waystation-peer" });
  heading(block, displayName(peer));
  table(block, [
    [t("指纹"), peer.fingerprint],
    [t("序号"), String(peer.sequence)],
    [t("采集时间"), clockText(peer.collectedAt)],
    [t("改动文件"), String(peer.payload.count)],
  ]);
  pathList(block, peer.payload.paths);
  suspectNotes(block, peer.payload);
  const actions = block.createDiv({ cls: "waystation-actions" });
  const button = actions.createEl("button", { text: t("吊销这台设备") });
  button.onclick = () => {
    onRevoke(peer.fingerprint);
  };
}

/** 一台中继的现状。 */
function relayBlock(parent: HTMLElement, relay: RelayStatus): void {
  const block = parent.createDiv({ cls: "waystation-relay" });
  heading(block, relay.name);
  table(block, [
    [t("地址"), relay.url],
    [t("传输级别"), levelText(relay)],
    [t("频道标识"), relay.channelId === "" ? t("尚未注册") : relay.channelId],
    [t("最近一次成功"), clockText(relay.lastSuccessAt)],
    [t("最近一次失败"), relay.lastFailure ?? t("无")],
  ]);
  if (relay.degraded) {
    const warn = block.createDiv({ cls: "waystation-warning" });
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
  const element = parent.createDiv({ cls: "waystation-flash", text });
  window.setTimeout(() => {
    element.remove();
  }, 6000);
}
