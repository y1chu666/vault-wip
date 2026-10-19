// 插件入口：装配核心逻辑，接上 Obsidian 的事件与界面。
//
// 所有判断都在 src/core 里做完，这里只负责搬运：取插件目录、读配置、按节奏触发、
// 把结果画到界面上。界面代码不进覆盖率统计，因此这里保持薄，能一眼看完。
import { FileSystemAdapter, Notice, Plugin, getLanguage } from "obsidian";

import type { Notice as EngineNotice } from "./core/alerts.js";
import { parseConfig, templateConfig, type Config } from "./core/config.js";
import { Engine, type EngineSnapshot } from "./core/engine.js";
import { PLUGIN_NAME, getLocale, setLocale, t, type Locale } from "./core/i18n.js";
import { pluginFiles, readTextFile, writeTextFile, type PluginFiles } from "./core/storage.js";
import { WaystationSettingTab } from "./settings.js";
import { VIEW_TYPE, WaystationView } from "./view.js";

/** 提醒与状态栏统一带上插件名：通知中心里同时有几条时，先认得出是谁发的。 */
function prefixed(text: string): string {
  return t("{name}：{text}", { name: PLUGIN_NAME, text });
}

/**
 * 按设置与 Obsidian 的界面语言算出用哪一套文案。
 *
 * 以「zh 开头」为界：中文及其变体都归中文，其余一律英文。清单里给出的语言代码
 * 是 ISO 代码，因此在语言增补时不必跟着改这里。
 */
function localeFrom(choice: Config["ui"]["language"]): Locale {
  if (choice !== "auto") {
    return choice;
  }
  return getLanguage().toLowerCase().startsWith("zh") ? "zh" : "en";
}

export default class VaultWaystationPlugin extends Plugin {
  private engine: Engine | null = null;
  private files: PluginFiles | null = null;
  private currentValues: Config | null = null;
  private configError: string | null = null;
  private timerId: number | null = null;
  private statusBar: HTMLElement | null = null;
  private settingTab: WaystationSettingTab | null = null;
  private readonly views = new Set<WaystationView>();

  override async onload(): Promise<void> {
    this.statusBar = this.addStatusBarItem();

    await this.reload();

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new WaystationView(leaf, this);
      this.views.add(view);
      return view;
    });

    this.addRibbonIcon("radio-tower", t("{name}：查看各端状态", { name: PLUGIN_NAME }), () => {
      void this.activateView();
    });
    this.settingTab = new WaystationSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // 采集与上报分开：这些时机只影响「什么时候报一次」，报什么由采集决定。
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        void this.tick("fileSwitch");
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", () => {
        void this.tick("save");
      }),
    );
    this.registerDomEvent(window, "focus", () => {
      this.engine?.setFocused(true);
      void this.tick("focus");
    });
    this.registerDomEvent(window, "blur", () => {
      this.engine?.setFocused(false);
    });
  }

  override onunload(): void {
    this.stopTimer();
    this.engine?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.views.clear();
  }

  /** 当前现状；配置有误或尚未装配时为 null。 */
  snapshot(): EngineSnapshot | null {
    return this.engine?.snapshot() ?? null;
  }

  /** 配置读不出来时的说明。 */
  configErrorText(): string | null {
    return this.configError;
  }

  /** 当前生效的配置，供设置页作为草稿。 */
  currentConfig(): Config | null {
    return this.currentValues;
  }

  /** 以一份新配置继续，不必重载插件。 */
  applyConfig(config: Config): void {
    this.currentValues = config;
    this.configError = null;
    const before = getLocale();
    setLocale(localeFrom(config.ui.language));
    this.engine?.setConfig(config);
    if (getLocale() !== before) {
      // 换了语言就重画设置页：文案已经变了，旧的那一屏不该继续留着。
      this.settingTab?.display();
    }
    this.refresh();
  }

  /** 配置文件路径。 */
  configPath(): string | null {
    return this.files?.config ?? null;
  }

  /** 插件目录的绝对路径，导出的文件也放在这里。 */
  pluginDirectory(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }
    const relative = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${adapter.getBasePath()}/${relative}`;
  }

  /** 重新读配置并装配引擎。配置有误时留着错误说明，不再往下走。 */
  async reload(): Promise<void> {
    this.stopTimer();

    const directory = this.pluginDirectory();
    if (directory === null) {
      this.configError = t("本插件只在桌面端可用");
      new Notice(prefixed(this.configError));
      return;
    }

    const files = pluginFiles(directory);
    this.files = files;
    const existing = await readTextFile(files.config);
    const text = existing ?? templateConfig(suggestAlias(this.app.vault.getName()));
    if (existing === null) {
      // 首次运行写一份说明齐备的配置：免得使用者面对一个空文件。
      await writeTextFile(files.config, text);
    }

    let config: Config;
    try {
      config = parseConfig(text);
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error);
      this.currentValues = null;
      this.engine?.stop();
      this.engine = null;
      this.refresh();
      return;
    }

    this.configError = null;
    this.currentValues = config;
    setLocale(localeFrom(config.ui.language));
    this.engine = await Engine.create({
      files,
      config,
      vaultRoot: this.vaultRoot(),
      notify: (notice) => {
        this.showNotice(notice);
      },
      onChange: () => {
        this.refresh();
      },
      isFocused: () => document.hasFocus(),
      log: (message) => {
        console.debug(`[vault-waystation] ${message}`);
      },
    });

    await this.engine.tick("startup");
    this.schedule();
  }

  /** 以注册凭证向各中继注册本仓库。 */
  async registerChannel(credential: string): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      new Notice(prefixed(t("配置尚未就绪")));
      return;
    }
    try {
      await engine.register(credential);
      new Notice(prefixed(t("注册完成")));
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
    }
    this.refresh();
  }

  /** 吊销一台设备。 */
  async revoke(fingerprint: string): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    try {
      await engine.revoke(fingerprint);
      new Notice(prefixed(t("已吊销设备 {fingerprint}", { fingerprint: fingerprint.slice(0, 8) })));
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
    }
    this.refresh();
  }

  /** 本设备退役。 */
  async retire(): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    try {
      await engine.retire();
      new Notice(prefixed(t("本设备已退役，需要重新注册才能继续使用")));
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
    }
    this.refresh();
  }

  /** 内容密钥的文本形式，供导出与复制。 */
  contentKeyText(): string | null {
    return this.engine?.contentKeyText() ?? null;
  }

  /** 用口令封起内容密钥。 */
  protectedKey(passphrase: string): string | null {
    try {
      return this.engine?.protectContentKeyWith(passphrase) ?? null;
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
      return null;
    }
  }

  /** 换用粘贴进来的内容密钥；带口令时先解开口令。 */
  async adoptKey(text: string, passphrase: string): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    try {
      if (passphrase === "") {
        await engine.adoptContentKey(text);
      } else {
        await engine.adoptProtectedContentKey(text, passphrase);
      }
      new Notice(prefixed(t("已换用新的内容密钥")));
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
    }
    this.refresh();
  }

  /**
   * 把一段文本写到插件目录下的文件里，返回路径。
   *
   * 插件目录里的导出文件会被同目录的忽略清单挡住，不会随仓库提交；
   * 使用者仍须自行把它当作秘密看待。
   */
  async writeExport(name: string, text: string): Promise<string | null> {
    const directory = this.pluginDirectory();
    if (directory === null) {
      return null;
    }
    const path = `${directory}/${name}`;
    try {
      await writeTextFile(path, `${text.trim()}\n`, 0o600);
      return path;
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
      return null;
    }
  }

  /**
   * 重置本机序号。
   *
   * 平时没有人需要按这个按钮：序号由本设备自己推进。它只在序号已经无法继续推进时
   * 才有用，界面上也写清了这一点，因此不再另加确认步骤之外的阻隔。
   */
  async resetSequence(): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    try {
      await engine.resetSequence();
      new Notice(prefixed(t("本机计数已重置")));
    } catch (error) {
      new Notice(prefixed(describe(error)), 0);
    }
    this.refresh();
  }

  /** 手工触发一次采集与上报。 */
  async reportNow(): Promise<void> {
    await this.tick("timer");
  }

  /** 打开或聚焦状态视图。 */
  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      const leaf = existing[0];
      if (leaf !== undefined) {
        await this.app.workspace.revealLeaf(leaf);
      }
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** 视图在打开与关闭时登记自己，好让状态变化能推过去。 */
  forgetView(view: WaystationView): void {
    this.views.delete(view);
  }

  /** 触发一次采集与上报，并按引擎给出的节奏安排下一次。 */
  private async tick(trigger: "startup" | "fileSwitch" | "save" | "focus" | "timer"): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    await engine.tick(trigger);
    this.schedule();
  }

  /** 按引擎给出的间隔安排下一次定时采集。 */
  private schedule(): void {
    this.stopTimer();
    const engine = this.engine;
    if (engine === null) {
      return;
    }
    this.timerId = window.setTimeout(() => {
      void this.tick("timer");
    }, engine.nextTimerSeconds() * 1000);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** 把新鲜的状态推给状态栏与各视图。 */
  private refresh(): void {
    const snapshot = this.engine?.snapshot() ?? null;
    this.updateStatusBar(snapshot);
    for (const view of this.views) {
      view.render();
    }
  }

  private updateStatusBar(snapshot: EngineSnapshot | null): void {
    if (this.statusBar === null) {
      return;
    }
    this.statusBar.setText(statusText(snapshot, this.configError));
  }

  private showNotice(notice: EngineNotice): void {
    // 真冲突要一直留着，直到使用者自己关掉；其余提示几秒后自行消失。
    new Notice(`${notice.title}\n${notice.body}`, notice.kind === "conflict" ? 0 : 8000);
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }
}

/** 状态栏上的一句话。 */
export function statusText(snapshot: EngineSnapshot | null, configError: string | null): string {
  if (configError !== null) {
    return prefixed(t("配置有误"));
  }
  if (snapshot === null) {
    return prefixed(t("未就绪"));
  }
  if (snapshot.retired) {
    return prefixed(t("本设备已退役"));
  }

  const parts: string[] = [];
  if (snapshot.relays.length === 0) {
    parts.push(t("未配置中继"));
  } else {
    const reachable = snapshot.relays.filter((relay) => relay.lastFailure === null).length;
    parts.push(t("中继 {reachable}/{total}", { reachable, total: snapshot.relays.length }));
  }

  if (snapshot.conflicts.length > 0) {
    parts.push(t("冲突 {count}", { count: snapshot.conflicts.length }));
  } else {
    const changes = snapshot.peers.filter((peer) => peer.payload.count > 0).length;
    if (changes > 0) {
      parts.push(t("对端 {count} 台有改动", { count: changes }));
    }
  }

  return prefixed(parts.join(" · "));
}

/** 由仓库名给一个可用的频道别名。 */
function suggestAlias(vaultName: string): string {
  const cleaned = vaultName.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned === "" ? "vault" : cleaned.slice(0, 64);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
