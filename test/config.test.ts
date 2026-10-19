import { describe, expect, it } from "vitest";

import {
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_IDLE_AFTER_SECONDS,
  DEFAULT_IDLE_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REPEAT_SECONDS,
  defaultConfig,
  isDegraded,
  parseConfig,
  serializeConfig,
  templateConfig,
  type Config,
} from "../src/core/config.js";

/** 一份最小可用配置：其余各节都应取默认值。 */
const minimal = `
version = 1

[channel]
alias = "vault-example"

[[relay]]
name = "relay-a"
url = "https://relay.example.com:8787"
transport = "pinned"
`;

/** `channel` 一节，供需要把键写在顶层的用例拼装文本。 */
const channelBlock = `[channel]\nalias = "vault-example"\n`;

/** 一段可用的中继，拼在 channelBlock 之后。 */
const relayBlock = `\n[[relay]]\nname = "relay-a"\nurl = "https://relay.example.com:8787"\ntransport = "pinned"\n`;

/** parse 期望成功，返回解析结果。 */
function parsed(text: string): Config {
  return parseConfig(text);
}

/** parse 期望失败，返回消息。 */
function failure(text: string): string {
  try {
    parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("配置本应解析失败");
}

describe("parseConfig", () => {
  it("为省略的节填入默认值", () => {
    const config = parsed(minimal);

    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.channel.alias).toBe("vault-example");
    // 省略 device 一节时本设备没有名称，对端便只按指纹称呼。
    expect(config.device).toEqual({ name: "" });
    expect(config.collect).toEqual({
      git: "",
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      idleAfterSeconds: DEFAULT_IDLE_AFTER_SECONDS,
      idleIntervalSeconds: DEFAULT_IDLE_INTERVAL_SECONDS,
      detectConflictFiles: true,
    });
    expect(config.notify.repeatSeconds).toBe(DEFAULT_REPEAT_SECONDS);
    expect(config.relay).toHaveLength(1);
    expect(config.relay[0]).toEqual({
      name: "relay-a",
      url: "https://relay.example.com:8787",
      transport: "pinned",
    });
  });

  it("读入完整配置", () => {
    const config = parsed(`
version = 1

[device]
name = "示例设备甲"

[channel]
alias = "vault-example"

[collect]
git = "/usr/bin/git"
interval_seconds = 30
idle_after_seconds = 600
idle_interval_seconds = 120
detect_conflict_files = false

[notify]
repeat_seconds = 1800

[[relay]]
name = "relay-a"
url = "https://relay.example.com:8787"
transport = "https"

[[relay]]
name = "relay-b"
url = "http://relay.invalid:8080"
transport = "plaintext"
`);

    expect(config.device.name).toBe("示例设备甲");
    expect(config.collect).toEqual({
      git: "/usr/bin/git",
      intervalSeconds: 30,
      idleAfterSeconds: 600,
      idleIntervalSeconds: 120,
      detectConflictFiles: false,
    });
    expect(config.notify.repeatSeconds).toBe(1800);
    expect(config.relay.map((relay) => relay.name)).toEqual(["relay-a", "relay-b"]);
  });

  it("生成的样例文本可以直接读回", () => {
    const config = parsed(templateConfig("vault-example"));

    expect(config.channel.alias).toBe("vault-example");
    expect(config.relay[0]?.transport).toBe("pinned");
  });

  it("写出之后再读回得到同一份配置", () => {
    const before = defaultConfig("vault-example");
    const after = parsed(serializeConfig(before));

    expect(after).toEqual(before);
  });

  it("序列化后的文本不含注释", () => {
    expect(serializeConfig(defaultConfig("vault-example"))).not.toContain("#");
  });
});

describe("parseConfig 的错误处理", () => {
  it("拒绝不合语法的 TOML", () => {
    expect(failure("这不是 TOML")).toContain("不是合法的 TOML");
  });

  it("拒绝可能污染原型的键", () => {
    expect(failure(`__proto__ = "x"`)).toContain("不是合法的 TOML");
  });

  it("拒绝其他版本的配置", () => {
    expect(failure(minimal.replace("version = 1", "version = 2"))).toContain("只认识 1");
  });

  it("拒绝顶层不认识的配置项", () => {
    expect(failure(`${minimal}\nextra = 1`)).toContain("不认识的配置项：extra");
  });

  it("缺少 channel 时给出提示", () => {
    expect(failure(`version = 1\n\n[[relay]]\nname = "a"\nurl = "https://relay.example.com"\ntransport = "https"`)).toContain(
      "缺少 channel",
    );
  });

  it("拒绝空的仓库别名", () => {
    expect(failure(minimal.replace(`alias = "vault-example"`, `alias = ""`))).toContain("channel.alias 不能为空");
  });

  it("拒绝过长的仓库别名", () => {
    expect(failure(minimal.replace("vault-example", "a".repeat(65)))).toContain("最长 64 个字符");
  });

  it("拒绝含控制字符的仓库别名", () => {
    expect(failure(minimal.replace("vault-example", "a\\u0007b"))).toContain("控制字符");
  });

  it("拒绝把 channel 写成非表", () => {
    expect(failure(minimal.replace(`[channel]\nalias = "vault-example"`, `channel = "vault-example"`))).toContain(
      "channel 应当是一张表",
    );
  });

  it("拒绝 channel 中不认识的配置项", () => {
    expect(failure(minimal.replace("alias = ", "alias_name = "))).toContain("不认识的配置项");
  });

  it("拒绝把 device 写成非表", () => {
    expect(failure(`version = 1\ndevice = "示例设备甲"\n\n${channelBlock}${relayBlock}`)).toContain(
      "device 应当是一张表",
    );
  });

  it("拒绝 device 中不认识的配置项", () => {
    expect(failure(`version = 1\n\n[device]\nlabel = "示例设备甲"\n\n${channelBlock}${relayBlock}`)).toContain(
      "不认识的配置项：label",
    );
  });

  it("拒绝过长的设备名称", () => {
    expect(failure(`${minimal}\n[device]\nname = "${"甲".repeat(65)}"`)).toContain("最长 64 个字符");
  });

  it("拒绝含控制字符的设备名称", () => {
    expect(failure(`${minimal}\n[device]\nname = "甲\\u0007乙"`)).toContain("控制字符");
  });

  it("拒绝类型不符的设备名称", () => {
    expect(failure(`${minimal}\n[device]\nname = 1`)).toContain("device.name 应当是字符串");
  });

  it("拒绝超出范围的采集间隔", () => {
    expect(failure(`${minimal}\n[collect]\ninterval_seconds = 1`)).toContain("interval_seconds");
    expect(failure(`${minimal}\n[collect]\ninterval_seconds = 99999`)).toContain("interval_seconds");
  });

  it("拒绝降频间隔小于常规定时", () => {
    expect(failure(`${minimal}\n[collect]\ninterval_seconds = 60\nidle_interval_seconds = 30`)).toContain(
      "降频只会更慢",
    );
  });

  it("拒绝类型不符的取值", () => {
    expect(failure(minimal.replace("version = 1", `version = "一"`))).toContain("version 应当是整数");
    expect(failure(`${minimal}\n[collect]\ngit = 1`)).toContain("collect.git 应当是字符串");
    expect(failure(`${minimal}\n[collect]\ndetect_conflict_files = "true"`)).toContain("应当是 true 或 false");
    expect(failure(`${minimal}\n[notify]\nrepeat_seconds = "600"`)).toContain("repeat_seconds 应当是整数");
  });

  it("拒绝不合可选值的重提醒间隔", () => {
    expect(failure(`${minimal}\n[notify]\nrepeat_seconds = 601`)).toContain("repeat_seconds 只能取");
  });

  it("拒绝把 collect 与 notify 写成非表", () => {
    expect(failure(`version = 1\ncollect = 1\n\n${channelBlock}${relayBlock}`)).toContain("collect 应当是一张表");
    expect(failure(`version = 1\nnotify = 1\n\n${channelBlock}${relayBlock}`)).toContain("notify 应当是一张表");
  });

  it("缺少 relay 时给出提示", () => {
    expect(failure(`version = 1\n\n${channelBlock}`)).toContain("缺少 relay");
  });

  it("把不是数组的 relay 判为写错", () => {
    expect(failure(`version = 1\nrelay = "relay-a"\n\n${channelBlock}`)).toContain("每段以 [[relay]] 开头");
  });

  it("拒绝中继条目不是表", () => {
    expect(failure(`version = 1\nrelay = [1]\n\n${channelBlock}`)).toContain("relay[0] 应当是一张表");
  });

  it("拒绝没有中继的配置", () => {
    expect(failure(`version = 1\nrelay = []\n\n${channelBlock}`)).toContain("至少需要配置一个中继");
  });

  it("拒绝过多中继", () => {
    const block = `\n[[relay]]\nname = "relay-%d"\nurl = "https://relay.example.com"\ntransport = "https"`;
    const many = Array.from({ length: 9 }, (_, index) => block.replace("%d", String(index))).join("\n");

    expect(failure(`${minimal}${many}`)).toContain("中继最多 8 个");
  });

  it("拒绝缺少名称或地址的中继", () => {
    expect(failure(minimal.replace(`name = "relay-a"`, `name = ""`))).toContain("name 不能为空");
    expect(failure(minimal.replace(`url = "https://relay.example.com:8787"`, `url = ""`))).toContain("url 不能为空");
  });

  it("拒绝重名的中继", () => {
    const duplicated = minimal.replace(
      `transport = "pinned"`,
      `transport = "pinned"\n\n[[relay]]\nname = "relay-a"\nurl = "https://relay.example.com"\ntransport = "https"`,
    );

    expect(failure(duplicated)).toContain("与其他中继重名");
  });

  it("拒绝过长的中继名称", () => {
    expect(failure(minimal.replace(`name = "relay-a"`, `name = "${"a".repeat(33)}"`))).toContain("最长 32 个字符");
  });

  it("拒绝不是地址的取值", () => {
    expect(failure(minimal.replace(`url = "https://relay.example.com:8787"`, `url = "relay.example.com"`))).toContain(
      "不是合法的地址",
    );
  });

  it("拒绝协议不为 http 或 https 的地址", () => {
    expect(
      failure(minimal.replace(`url = "https://relay.example.com:8787"`, `url = "ftp://relay.example.com"`)),
    ).toContain("协议只能是 http 或 https");
  });

  it("拒绝缺少传输级别的中继", () => {
    expect(failure(minimal.replace(`transport = "pinned"\n`, ""))).toContain("transport 不能为空");
  });

  it("拒绝未知的传输级别", () => {
    expect(failure(minimal.replace(`transport = "pinned"`, `transport = "也许安全"`))).toContain(
      "transport 只能取",
    );
  });

  it("拒绝传输级别与地址协议不一致的条目", () => {
    expect(failure(minimal.replace(`transport = "pinned"`, `transport = "plaintext"`))).toContain("地址却以 https 开头");
    expect(
      failure(minimal.replace(`url = "https://relay.example.com:8787"`, `url = "http://relay.example.com:8787"`)),
    ).toContain("地址却以 http 开头");
  });

  it("把多个问题一并报出", () => {
    const message = failure(`version = 2\n\n[channel]\nalias = ""`);

    expect(message).toContain("只认识 1");
    expect(message).toContain("不能为空");
    expect(message).toContain("缺少 relay");
  });
});

describe("isDegraded", () => {
  it("把忽略证书与明文两级视为降级", () => {
    expect(isDegraded("https")).toBe(false);
    expect(isDegraded("pinned")).toBe(false);
    expect(isDegraded("insecure")).toBe(true);
    expect(isDegraded("plaintext")).toBe(true);
  });
});

describe("界面语言", () => {
  it("不写这一项时跟随 Obsidian", () => {
    expect(parsed(minimal).ui).toEqual({ language: "auto" });
  });

  it("可以固定成中文或英文", () => {
    expect(parsed(`${channelBlock}[ui]\nlanguage = "en"\n${relayBlock}`).ui.language).toBe("en");
    expect(parsed(`${channelBlock}[ui]\nlanguage = "zh"\n${relayBlock}`).ui.language).toBe("zh");
  });

  it("拒绝不认识的取值，并列出可取值", () => {
    expect(failure(`${channelBlock}[ui]\nlanguage = "fr"\n${relayBlock}`)).toContain("ui.language 只能取");
  });

  it("拒绝 ui 一节里的多余键", () => {
    expect(failure(`${channelBlock}[ui]\nlocale = "en"\n${relayBlock}`)).toContain("ui");
  });

  it("ui 不是一张表时如实说出来", () => {
    expect(failure(`ui = 1\n${channelBlock}${relayBlock}`)).toContain("ui 应当是一张表");
  });

  it("写回之后仍然认得出这一项", () => {
    const before = defaultConfig("vault-example");
    const withEnglish: Config = { ...before, ui: { language: "en" } };
    expect(parsed(serializeConfig(withEnglish)).ui.language).toBe("en");
  });

  it("首次生成的配置里带上这一项", () => {
    expect(templateConfig("vault-example")).toContain("[ui]");
  });
});
