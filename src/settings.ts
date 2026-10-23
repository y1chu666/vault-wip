// 设置页：把配置文件的取值摆成一张表。
//
// 每次改动都重新序列化整份配置再写回文件：配置文件是取值的唯一来源，界面只是它的
// 编辑器。写完立刻以新配置重建引擎，不必重载插件。
import { App, PluginSettingTab, Setting } from "obsidian";

import type { Config, TransportLevel } from "./core/config.js";
import {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  isLanguageChoice,
  parseConfig,
  serializeConfig,
} from "./core/config.js";
import { t } from "./core/i18n.js";
import { readTextFile, writeTextFile } from "./core/storage.js";
import type VaultWipPlugin from "./main.js";

/** 把只读的取值类型变成可写，供设置页在副本上改一项。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 配置文件的可写副本。 */
interface ConfigDraft {
  version: number;
  device: { name: string };
  channel: { alias: string };
  collect: Mutable<Config["collect"]>;
  notify: { repeatSeconds: number; conflictRepeatSeconds: number };
  ui: Mutable<Config["ui"]>;
  query: Mutable<Config["query"]>;
  relay: Mutable<Config["relay"][number]>[];
}

/** 传输级别的取值与说明，顺序即推荐顺序。 */
const TRANSPORTS: readonly TransportLevel[] = ["https", "pinned", "insecure", "plaintext"];

/** 传输级别的说明。文案随语言变，因此不写死在取值表里。 */
function transportLabel(level: TransportLevel): string {
  switch (level) {
    case "https":
      return t("公开证书（推荐）");
    case "pinned":
      return t("钉住自签证书");
    case "insecure":
      return t("忽略证书错误（降级）");
    case "plaintext":
      return t("明文（降级）");
  }
}

/** 时长输入的单位（秒），按从大到小排列。 */
const DURATION_UNITS = [3600, 60, 1] as const;

export class WipSettingTab extends PluginSettingTab {
  private credential = "";

  constructor(
    app: App,
    private readonly plugin: VaultWipPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-wip-settings");

    const error = this.plugin.configErrorText();
    if (error !== null) {
      new Setting(containerEl)
        .setName(t("配置文件有误"))
        .setDesc(`${error}\n${t("改正之后按下面的按钮重新读取。")}`);
      new Setting(containerEl).addButton((button) =>
        button.setButtonText(t("重新读取配置")).onClick(() => {
          void this.plugin.reload().then(() => {
            this.display();
          });
        }),
      );
      const path = this.plugin.configPath();
      if (path !== null) {
        containerEl.createEl("p", { text: t("配置文件：{path}", { path }) });
      }
      return;
    }

    const config = this.plugin.currentConfig();
    if (config === null) {
      containerEl.createEl("p", { text: t("尚未就绪。") });
      return;
    }

    this.renderUi(config);
    this.renderDevice(config);
    this.renderChannel(config);
    this.renderCollect(config);
    this.renderQuery(config);
    this.renderNotify(config);
    this.renderRelays(config);
    this.renderRegistration(config);
    this.renderFooter();
  }

  /** 界面：只影响本机看到的文字，与上报的内容无关。 */
  private renderUi(config: Config): void {
    new Setting(this.containerEl).setName(t("界面")).setHeading();

    new Setting(this.containerEl)
      .setName(t("界面语言"))
      .setDesc(t("跟随 Obsidian 时按界面的语言取文案；命令名须在插件重新加载后随之改变。"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ auto: t("跟随 Obsidian"), zh: t("中文"), en: t("英文") })
          .setValue(config.ui.language)
          .onChange((value: string) => {
            if (!isLanguageChoice(value)) {
              return;
            }
            this.edit((draft) => {
              draft.ui = { language: value };
            });
          }),
      );
  }

  /** 本设备：名称会写进加密的记录内容，中继看不到。 */
  private renderDevice(config: Config): void {
    new Setting(this.containerEl)
      .setName(t("本设备名称"))
      .setDesc(
        t("写进加密的记录内容，供同仓库的其他设备辨认。中继看不到它。留空时对端只按指纹称呼本设备。"),
      )
      .addText((text) =>
        text
          .setPlaceholder(t("例如：书房台式机"))
          .setValue(config.device.name)
          .onChange((value) => {
            this.edit((draft) => {
              draft.device = { name: value.trim() };
            });
          }),
      );
  }

  private renderChannel(config: Config): void {
    new Setting(this.containerEl)
      .setName(t("仓库别名"))
      .setDesc(t("注册时按这个名称请求频道，同一仓库的各设备要写同一个名字。"))
      .addText((text) =>
        text.setValue(config.channel.alias).onChange((value) => {
          this.edit((draft) => {
            draft.channel = { alias: value.trim() };
          });
        }),
      );
  }

  private renderCollect(config: Config): void {
    new Setting(this.containerEl).setName(t("采集")).setHeading();

    new Setting(this.containerEl)
      .setName(t("git 可执行文件"))
      .setDesc(t("留空表示从 PATH 中查找。"))
      .addText((text) =>
        text.setPlaceholder("git").setValue(config.collect.git).onChange((value) => {
          this.edit((draft) => {
            draft.collect = { ...draft.collect, git: value.trim() };
          });
        }),
      );

    addDuration(
      new Setting(this.containerEl).setName(t("定时采集间隔")),
      config.collect.intervalSeconds,
      MIN_INTERVAL_SECONDS,
      (seconds) => {
        this.edit((draft) => {
          draft.collect = { ...draft.collect, intervalSeconds: seconds };
        });
      },
    );

    addDuration(
      new Setting(this.containerEl).setName(t("窗口失焦后多久降频")).setDesc(t("0 表示不降频。")),
      config.collect.idleAfterSeconds,
      0,
      (seconds) => {
        this.edit((draft) => {
          draft.collect = { ...draft.collect, idleAfterSeconds: seconds };
        });
      },
    );

    addDuration(
      new Setting(this.containerEl).setName(t("失焦后的采集间隔")),
      config.collect.idleIntervalSeconds,
      MIN_INTERVAL_SECONDS,
      (seconds) => {
        this.edit((draft) => {
          draft.collect = { ...draft.collect, idleIntervalSeconds: seconds };
        });
      },
    );

    new Setting(this.containerEl)
      .setName(t("识别合并冲突的残留文件"))
      .setDesc(t("开启时会把留有合并痕迹的文件单独标出，只影响措辞，不影响是否算冲突。"))
      .addToggle((toggle) =>
        toggle.setValue(config.collect.detectConflictFiles).onChange((value) => {
          this.edit((draft) => {
            draft.collect = { ...draft.collect, detectConflictFiles: value };
          });
        }),
      );
  }

  /** 远端查询：只读远端，结果只留在本机界面上。 */
  private renderQuery(config: Config): void {
    new Setting(this.containerEl).setName(t("远端查询")).setHeading();

    new Setting(this.containerEl)
      .setName(t("查询用的远端"))
      .setDesc(
        t("填写要查询的远端名，例如 origin；留空表示用当前分支的上游。查询只向远端问一下两边各有哪些提交，既不拉取也不改动本机引用，结果只在本机界面上显示。"),
      )
      .addText((text) =>
        text
          .setPlaceholder(t("例如：origin"))
          .setValue(config.query.remote)
          .onChange((value) => {
            this.edit((draft) => {
              draft.query = { remote: value.trim() };
            });
          }),
      );
  }

  private renderNotify(config: Config): void {
    new Setting(this.containerEl).setName(t("提醒")).setHeading();

    addDuration(
      new Setting(this.containerEl)
        .setName(t("持续故障的重提醒间隔"))
        .setDesc(t("仅在中继持续无法连通时使用；0 表示只在故障开始时提醒一次。")),
      config.notify.repeatSeconds,
      0,
      (seconds) => {
        this.edit((draft) => {
          draft.notify = { ...draft.notify, repeatSeconds: seconds };
        });
      },
    );

    addDuration(
      new Setting(this.containerEl)
        .setName(t("冲突仍在时的重提醒间隔"))
        .setDesc(t("冲突持续存在时按此间隔再次提醒；0 表示每个冲突只提示一次。")),
      config.notify.conflictRepeatSeconds,
      0,
      (seconds) => {
        this.edit((draft) => {
          draft.notify = { ...draft.notify, conflictRepeatSeconds: seconds };
        });
      },
    );
  }

  private renderRelays(config: Config): void {
    new Setting(this.containerEl)
      .setName(t("中继"))
      .setDesc(t("可填写多台；各中继之间互不相通，记录由本机转发。传输级别与地址协议必须相符。"))
      .setHeading();

    config.relay.forEach((relay: Config["relay"][number], index: number) => {
      new Setting(this.containerEl)
        .setName(t("第 {index} 台", { index: index + 1 }))
        .addText((text) =>
          text.setPlaceholder(t("名称")).setValue(relay.name).onChange((value) => {
            this.updateRelay(index, { name: value.trim() });
          }),
        )
        .addText((text) =>
          text.setPlaceholder("https://relay.example.com:8787").setValue(relay.url).onChange((value) => {
            this.updateRelay(index, { url: value.trim() });
          }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(dropdownOptions(TRANSPORTS, transportLabel))
            .setValue(relay.transport)
            .onChange((value: string) => {
              this.updateRelay(index, { transport: value as TransportLevel });
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon("trash")
            .setTooltip(t("移除这一台"))
            .onClick(() => {
              this.edit((draft) => {
                draft.relay = draft.relay.filter((_, position) => position !== index);
              });
            }),
        );

      new Setting(this.containerEl)
        .setName(t("频道标识"))
        .setDesc(t("由中继生成，全局唯一；留空表示新建频道，填写表示加入这个频道。"))
        .addText((text) =>
          text
            .setPlaceholder(t("留空以新建"))
            .setValue(relay.channelId)
            .onChange((value) => {
              this.updateRelay(index, { channelId: value.trim() });
            }),
        );

      new Setting(this.containerEl)
        .setName(t("频道令牌"))
        .setDesc(t("创建频道时只返回一次；加入已有频道时必须填写。"))
        .addText((text) => {
          text
            .setPlaceholder(t("令牌"))
            .setValue(relay.channelToken)
            .onChange((value) => {
              this.updateRelay(index, { channelToken: value.trim() });
            });
          text.inputEl.type = "password";
        });
    });

    new Setting(this.containerEl).addButton((button) =>
      button.setButtonText(t("添加一台中继")).onClick(() => {
        this.edit((draft) => {
          draft.relay = [...draft.relay, { name: "", url: "", transport: "https", channelId: "", channelToken: "" }];
        });
      }),
    );
  }

  /** 注册凭证只在注册时出具一次，不写入配置，因此这里只放在内存里。 */
  private renderRegistration(config: Config): void {
    new Setting(this.containerEl).setName(t("注册")).setHeading();

    new Setting(this.containerEl)
      .setName(t("注册凭证"))
      .setDesc(
        config.relay.some((relay) => relay.transport === "insecure" || relay.transport === "plaintext")
          ? t("有中继处于降级传输，此时不允许注册；请先改回公开证书或钉住自签证书。")
          : t("向中继注册本仓库时需要出示一次。这份凭证不会写进配置文件。"),
      )
      .addText((text) => {
        text.setPlaceholder(t("凭证")).onChange((value) => {
          this.credential = value;
        });
        text.inputEl.type = "password";
      })
      .addButton((button) =>
        button
          .setButtonText(t("创建或加入频道"))
          .setCta()
          .onClick(() => {
            void this.plugin.registerChannel(this.credential);
          }),
      );
  }

  private renderFooter(): void {
    new Setting(this.containerEl).setName(t("文件")).setHeading();
    const path = this.plugin.configPath();
    this.containerEl.createEl("p", {
      text: t("配置文件：{path}", { path: path ?? t("未知") }),
    });
    this.containerEl.createEl("p", {
      text: t("设备私钥、内容密钥与中继公钥另存于同一目录，已由该目录下的忽略清单排除；请勿将其纳入版本控制。"),
    });
    const directory = this.plugin.pluginDirectory();
    if (directory !== null) {
      this.containerEl.createEl("p", { text: t("插件目录：{path}", { path: directory }) });
    }
  }

  /** 改一项配置：序列化整份写回，再让引擎以新配置继续。 */
  private edit(mutate: (draft: ConfigDraft) => void): void {
    const current = this.plugin.currentConfig();
    if (current === null) {
      return;
    }
    const draft = structuredClone(current) as unknown as ConfigDraft;
    mutate(draft);
    this.write(draft);
  }

  private updateRelay(index: number, patch: Partial<Config["relay"][number]>): void {
    this.edit((draft) => {
      const relay = draft.relay[index];
      if (relay === undefined) {
        return;
      }
      draft.relay = draft.relay.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      );
    });
  }

  private write(config: ConfigDraft): void {
    const path = this.plugin.configPath();
    if (path === null) {
      return;
    }
    void writeTextFile(path, serializeConfig(config))
      .then(() => loadAndApply(this.plugin))
      .catch((error: unknown) => {
        console.error("[vault-wip] 配置写入失败", error);
      });
  }
}

/** 写回之后重新读一遍再交给引擎：解析器是唯一的把关者，界面不另设一套校验。 */
async function loadAndApply(plugin: VaultWipPlugin): Promise<void> {
  const path = plugin.configPath();
  if (path === null) {
    return;
  }
  const text = await readTextFile(path);
  if (text === null) {
    return;
  }
  try {
    plugin.applyConfig(parseConfig(text));
  } catch (error) {
    console.error("[vault-wip] 配置不合规", error);
  }
}

/** 单位的名称。 */
function durationUnitLabel(unit: number): string {
  switch (unit) {
    case 3600:
      return t("时");
    case 60:
      return t("分");
    default:
      return t("秒");
  }
}

/** 把秒数拆成能整除的最大单位，打开设置页时按它显示。 */
function splitDuration(seconds: number): { value: number; unit: number } {
  for (const unit of DURATION_UNITS) {
    if (unit !== 1 && seconds > 0 && seconds % unit === 0) {
      return { value: seconds / unit, unit };
    }
  }
  return { value: seconds, unit: 1 };
}

/** 取值不合规时给出的范围说明。 */
function durationRangeHint(minimum: number): string {
  return t("请填 {minimum} 秒到 {maximum} 天之间的整数。", {
    minimum,
    maximum: MAX_INTERVAL_SECONDS / (24 * 60 * 60),
  });
}

/**
 * 数字加单位的时长输入。
 *
 * 取值不合规时只在原处提示，不写回配置；写得合规时立刻写回，与其它设置项一致。
 */
function addDuration(
  setting: Setting,
  seconds: number,
  minimum: number,
  apply: (seconds: number) => void,
): void {
  const baseDescription = setting.descEl.textContent ?? "";
  const initial = splitDuration(seconds);
  let value = initial.value;
  let unit = initial.unit;

  const showRange = (): void => {
    setting.setDesc(durationRangeHint(minimum));
  };
  const restore = (): void => {
    setting.setDesc(baseDescription);
  };
  /** 按当前的数字与单位写回；不合规时提示并保持原值。 */
  const commit = (): boolean => {
    const total = value * unit;
    if (total < minimum || total > MAX_INTERVAL_SECONDS) {
      showRange();
      return false;
    }
    restore();
    apply(total);
    return true;
  };

  setting.addText((text) => {
    text.inputEl.type = "number";
    text.inputEl.min = "0";
    text.setValue(String(value));
    text.onChange((raw) => {
      if (raw.trim() === "") {
        showRange();
        return;
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        showRange();
        return;
      }
      value = parsed;
      commit();
    });
  });

  setting.addDropdown((dropdown) => {
    dropdown
      .addOptions(dropdownOptions(DURATION_UNITS, durationUnitLabel))
      .setValue(String(unit))
      .onChange((raw) => {
        const previous = unit;
        const next = Number(raw);
        if (!Number.isInteger(next) || next <= 0) {
          return;
        }
        unit = next;
        if (!commit()) {
          unit = previous;
          dropdown.setValue(String(previous));
        }
      });
  });
}

/** 把档位列表变成下拉选项。 */
function dropdownOptions<T>(values: readonly T[], label: (value: T) => string): Record<string, string> {
  const options: Record<string, string> = {};
  for (const value of values) {
    options[String(value)] = label(value);
  }
  return options;
}
