// 本模块负责插件配置的读取、校验与写出。
//
// 配置文件是取值的唯一来源：界面只是编辑器，运行时不另行改写语义。
// 配置里不存放任何秘密，设备私钥、内容密钥与钉住的中继公钥由独立的存储负责，
// 这样一份配置可以放心地随仓库一起备份或公开。
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { t } from "./i18n.js";

/** 配置格式版本。字段含义有变时递增，并在读取时按版本迁移。 */
export const CONFIG_VERSION = 1;

/** 传输级别，与协议中的四级一一对应。 */
export const TRANSPORT_LEVELS = ["https", "pinned", "insecure", "plaintext"] as const;

/** 传输级别。 */
export type TransportLevel = (typeof TRANSPORT_LEVELS)[number];

/** 界面语言的取值。auto 表示跟随 Obsidian 的界面语言。 */
export const LANGUAGE_CHOICES = ["auto", "zh", "en"] as const;

/** 界面语言的写法。 */
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

/** 默认的定时采集间隔（秒）。 */
export const DEFAULT_INTERVAL_SECONDS = 15;

/** 默认的失焦降频阈值（秒）。 */
export const DEFAULT_IDLE_AFTER_SECONDS = 300;

/** 默认的失焦后的采集间隔（秒）。 */
export const DEFAULT_IDLE_INTERVAL_SECONDS = 60;

/** 默认的重提醒间隔（秒）。 */
export const DEFAULT_REPEAT_SECONDS = 600;
/** 冲突仍在时的默认重提醒间隔（秒）。 */
export const DEFAULT_CONFLICT_REPEAT_SECONDS = 600;
/** 默认的远端查询间隔（秒）。 */
export const DEFAULT_QUERY_INTERVAL_SECONDS = 600;

const MAX_RELAYS = 8;
const MAX_ALIAS_LENGTH = 64;
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_RELAY_NAME_LENGTH = 32;
const MAX_REMOTE_NAME_LENGTH = 64;
/** 定时采集间隔的下限（秒）。 */
export const MIN_INTERVAL_SECONDS = 5;
/** 各项间隔的上限（秒）。取三十天，既容得下按时计的间隔，也能挡住多打几个零。 */
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

/** 中继配置。 */
export interface RelaySettings {
  /** 设备本地给该中继起的名字，仅用于显示。 */
  readonly name: string;
  /** 中继地址，形如 `https://relay.example.com:8787`。 */
  readonly url: string;
  /** 连接该中继使用的传输级别。 */
  readonly transport: TransportLevel;
  /** 频道标识；创建或加入成功后写入，留空表示尚未确定。 */
  readonly channelId: string;
  /** 频道令牌；创建频道时得到，加入已有频道时需要填写。 */
  readonly channelToken: string;
}

/** 采集配置。 */
export interface CollectSettings {
  /** git 可执行文件路径；留空表示从 PATH 中查找。 */
  readonly git: string;
  /** 定时采集间隔（秒）。 */
  readonly intervalSeconds: number;
  /** 窗口失焦超过该秒数后改用降频间隔，0 表示不降频。 */
  readonly idleAfterSeconds: number;
  /** 失焦后的采集间隔（秒）。 */
  readonly idleIntervalSeconds: number;
  /** 是否识别冲突残留文件，用于把假冲突排除在提醒之外。 */
  readonly detectConflictFiles: boolean;
}

/** 远端查询的配置。 */
export interface QuerySettings {
  /** 要查询的远端名；留空表示用当前分支的上游。 */
  readonly remote: string;
  /** 自动查询的最短间隔（秒）；0 表示不自动查询。 */
  readonly intervalSeconds: number;
}

/** 界面配置。 */
export interface UiSettings {
  /** 界面语言：跟随 Obsidian、恒用中文或恒用英文。 */
  readonly language: LanguageChoice;
  /** 加载完成后是否把状态视图放进右侧栏。 */
  readonly openOnStart: boolean;
}

/** 提醒配置。 */
export interface NotifySettings {
  /** 持续故障的重提醒间隔（秒），0 表示关闭。 */
  readonly repeatSeconds: number;
  /** 冲突仍在时的重提醒间隔（秒）；0 表示每个冲突只提示一次。 */
  readonly conflictRepeatSeconds: number;
}

/** 设备配置。 */
export interface DeviceSettings {
  /** 本设备名称。写进记录内容供对端辨认，中继看不到；留空时对端只按指纹称呼。 */
  readonly name: string;
}

/** 频道配置。 */
export interface ChannelSettings {
  /** 仓库别名，注册时按此名称请求频道。 */
  readonly alias: string;
}

/** 一份完整的插件配置。 */
export interface Config {
  readonly version: number;
  readonly device: DeviceSettings;
  readonly channel: ChannelSettings;
  readonly collect: CollectSettings;
  readonly notify: NotifySettings;
  readonly ui: UiSettings;
  readonly query: QuerySettings;
  readonly relay: readonly RelaySettings[];
}

/** 配置不可用。消息面向使用者，说明哪里写错了。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 取值是否是一种界面语言的写法。 */
export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return typeof value === "string" && (LANGUAGE_CHOICES as readonly string[]).includes(value);
}

/** 传输级别是否属于降级：中间人可能在场的两级。 */
export function isDegraded(level: TransportLevel): boolean {
  return level === "insecure" || level === "plaintext";
}

/**
 * 解析配置文本。
 *
 * 出错时抛出 {@link ConfigError}，消息里列出全部问题，使一次修改就能改对。
 */
export function parseConfig(text: string): Config {
  const raw = parseDocument(text);

  const problems: string[] = [];
  checkKeys(
    raw,
    ["version", "device", "channel", "collect", "notify", "ui", "query", "relay"],
    t("配置"),
    problems,
  );
  const version = readInteger(raw, "version", t("配置"), problems);
  if (version !== undefined && version !== CONFIG_VERSION) {
    problems.push(t("配置版本为 {found}，本版本只认识 {known}", { found: version, known: CONFIG_VERSION }));
  }

  const device = parseDevice(raw["device"], problems);
  const channel = parseChannel(raw["channel"], problems);
  const collect = parseCollect(raw["collect"], problems);
  const notify = parseNotify(raw["notify"], problems);
  const ui = parseUi(raw["ui"], problems);
  const query = parseQuery(raw["query"], problems);
  const relay = parseRelays(raw["relay"], problems);

  if (problems.length > 0) {
    throw new ConfigError(problems.join(t("；")));
  }

  return {
    version: CONFIG_VERSION,
    device,
    channel,
    collect,
    notify,
    ui,
    query,
    relay,
  };
}

/**
 * 把配置写成 TOML 文本。
 *
 * 写出时丢弃注释，与视图改配置的行为一致；要留注释请手工编辑文件，
 * 界面不会替你保留手工写下的注释。
 */
export function serializeConfig(config: Config): string {
  const document = {
    version: config.version,
    device: {
      name: config.device.name,
    },
    channel: {
      alias: config.channel.alias,
    },
    collect: {
      git: config.collect.git,
      interval_seconds: config.collect.intervalSeconds,
      idle_after_seconds: config.collect.idleAfterSeconds,
      idle_interval_seconds: config.collect.idleIntervalSeconds,
      detect_conflict_files: config.collect.detectConflictFiles,
    },
    notify: {
      repeat_seconds: config.notify.repeatSeconds,
      conflict_repeat_seconds: config.notify.conflictRepeatSeconds,
    },
    ui: {
      language: config.ui.language,
      open_on_start: config.ui.openOnStart,
    },
    query: {
      remote: config.query.remote,
      interval_seconds: config.query.intervalSeconds,
    },
    relay: config.relay.map((relay) => ({
      name: relay.name,
      url: relay.url,
      transport: relay.transport,
      channel_id: relay.channelId,
      channel_token: relay.channelToken,
    })),
  };

  return stringifyToml(document);
}

/** 首次运行时的默认配置。中继由使用者补全，因此这里先给出一个占位条目。 */
export function defaultConfig(alias: string): Config {
  return {
    version: CONFIG_VERSION,
    device: { name: "" },
    channel: { alias },
    collect: {
      git: "",
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      idleAfterSeconds: DEFAULT_IDLE_AFTER_SECONDS,
      idleIntervalSeconds: DEFAULT_IDLE_INTERVAL_SECONDS,
      detectConflictFiles: true,
    },
    notify: { repeatSeconds: DEFAULT_REPEAT_SECONDS, conflictRepeatSeconds: DEFAULT_CONFLICT_REPEAT_SECONDS },
    ui: { language: "auto", openOnStart: true },
    query: { remote: "", intervalSeconds: DEFAULT_QUERY_INTERVAL_SECONDS },
    relay: [
      {
        name: "example",
        url: "https://relay.example.com:8787",
        transport: "pinned",
        channelId: "",
        channelToken: "",
      },
    ],
  };
}

/**
 * 首次运行写下的配置样例，带说明文字。
 *
 * 注释只在首次生成时存在：之后由视图改写配置时不会保留注释，
 * 因此需要长期保留注释的使用者应当手工编辑文件。
 */
export function templateConfig(alias: string): string {
  const separator = t("、");
  return `# ${t("Vault WIP 插件配置。")}
#
# ${t("本文件是取值的唯一来源，视图只是它的编辑器。")}
# ${t("本文件不含任何秘密：设备私钥、内容密钥与钉住的中继公钥另行存放。")}

version = 1

[device]
# ${t("本设备名称，写进记录内容供对端辨认。中继看不到它，同仓库的其他设备才看得到。")}
# ${t("留空时对端只按指纹称呼本设备。")}
name = ""

[channel]
# ${t("仓库别名。设备在注册时按此名称请求频道，同一仓库的各设备应当写同一个名字。")}
alias = ${quote(alias)}

[collect]
# ${t("git 可执行文件路径，留空表示从 PATH 中查找。")}
git = ""
# ${t("定时采集间隔（秒）。")}
interval_seconds = ${DEFAULT_INTERVAL_SECONDS}
# ${t("窗口失焦超过该秒数后改用下面的间隔，0 表示不降频。")}
idle_after_seconds = ${DEFAULT_IDLE_AFTER_SECONDS}
# ${t("失焦后的采集间隔（秒）。")}
idle_interval_seconds = ${DEFAULT_IDLE_INTERVAL_SECONDS}
# ${t("是否识别冲突残留文件。")}
detect_conflict_files = true

[notify]
# ${t("持续故障的重提醒间隔（秒），0 表示关闭。")}
repeat_seconds = ${DEFAULT_REPEAT_SECONDS}
# ${t("冲突仍在时的重提醒间隔（秒）；0 表示每个冲突只提示一次。")}
conflict_repeat_seconds = ${DEFAULT_CONFLICT_REPEAT_SECONDS}

[ui]
# ${t("界面语言，可取 {choices}。auto 表示跟随 Obsidian 的界面语言；", { choices: LANGUAGE_CHOICES.join(separator) })}
# ${t("命令名只在插件重新加载之后才会跟着变。")}
language = "auto"
# ${t("启动后在右侧栏挂一个状态视图标签页；不展开侧栏，也不抢焦点。")}
open_on_start = true

[query]
# ${t("远端查询用的远端名，例如 origin；留空表示用当前分支的上游。")}
remote = ""
# ${t("自动查询远端的最短间隔（秒），0 表示不自动查询。")}
interval_seconds = ${DEFAULT_QUERY_INTERVAL_SECONDS}

# ${t("中继可以有多个，重复写若干段 [[relay]] 即可。")}
# ${t("transport 可取 {choices}；后两级的通信不加密或可被冒充，", { choices: TRANSPORT_LEVELS.join(separator) })}
# ${t("需要显式写出，且处于这两级时不允许注册、吊销与退役。")}
[[relay]]
name = "example"
url = "https://relay.example.com:8787"
transport = "pinned"
`;
}

/** 把配置文本解析成顶层表。TOML 的顶层恒为一张表，因此这里只需处理语法错误。 */
function parseDocument(text: string): Record<string, unknown> {
  try {
    // 拒绝 __proto__ 一类键，避免配置文本影响解析结果之外的对象原型。
    return parseToml(text, { unsafeKeyBehaviour: "throw" });
  } catch (error) {
    throw new ConfigError(t("配置不是合法的 TOML：{reason}", { reason: messageOf(error) }));
  }
}

function parseDevice(value: unknown, problems: string[]): DeviceSettings {
  if (value === undefined) {
    return { name: "" };
  }
  if (!isTable(value)) {
    problems.push(t("device 应当是一张表"));
    return { name: "" };
  }

  checkKeys(value, ["name"], "device", problems);
  const name = readString(value, "name", "device", problems) ?? "";
  if (name.length > MAX_DEVICE_NAME_LENGTH) {
    problems.push(t("device.name 最长 {limit} 个字符", { limit: MAX_DEVICE_NAME_LENGTH }));
  } else if (containsControlCharacter(name)) {
    problems.push(t("device.name 不能含有控制字符"));
  }
  return { name };
}

function parseChannel(value: unknown, problems: string[]): ChannelSettings {
  if (value === undefined) {
    problems.push(t("缺少 channel 一节"));
    return { alias: "" };
  }
  if (!isTable(value)) {
    problems.push(t("channel 应当是一张表"));
    return { alias: "" };
  }

  checkKeys(value, ["alias"], "channel", problems);
  const alias = readString(value, "alias", "channel", problems) ?? "";
  if (alias === "") {
    problems.push(t("channel.alias 不能为空：注册时按它请求频道"));
  } else if (alias.length > MAX_ALIAS_LENGTH) {
    problems.push(t("channel.alias 最长 {limit} 个字符", { limit: MAX_ALIAS_LENGTH }));
  } else if (containsControlCharacter(alias)) {
    problems.push(t("channel.alias 不能含有控制字符"));
  }
  return { alias };
}

function parseCollect(value: unknown, problems: string[]): CollectSettings {
  const fallback: CollectSettings = {
    git: "",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    idleAfterSeconds: DEFAULT_IDLE_AFTER_SECONDS,
    idleIntervalSeconds: DEFAULT_IDLE_INTERVAL_SECONDS,
    detectConflictFiles: true,
  };
  if (value === undefined) {
    return fallback;
  }
  if (!isTable(value)) {
    problems.push(t("collect 应当是一张表"));
    return fallback;
  }

  checkKeys(
    value,
    ["git", "interval_seconds", "idle_after_seconds", "idle_interval_seconds", "detect_conflict_files"],
    "collect",
    problems,
  );
  const git = readString(value, "git", "collect", problems) ?? fallback.git;
  const detectConflictFiles =
    readBoolean(value, "detect_conflict_files", "collect", problems) ?? fallback.detectConflictFiles;

  const intervalSeconds = readInterval(
    value,
    "interval_seconds",
    "collect",
    fallback.intervalSeconds,
    problems,
    MIN_INTERVAL_SECONDS,
  );
  const idleAfterSeconds = readInterval(value, "idle_after_seconds", "collect", fallback.idleAfterSeconds, problems, 0);
  const idleIntervalSeconds = readInterval(
    value,
    "idle_interval_seconds",
    "collect",
    fallback.idleIntervalSeconds,
    problems,
    MIN_INTERVAL_SECONDS,
  );

  if (idleIntervalSeconds < intervalSeconds) {
    problems.push(t("collect.idle_interval_seconds 不应小于 collect.interval_seconds：降频只会更慢"));
  }

  return { git, intervalSeconds, idleAfterSeconds, idleIntervalSeconds, detectConflictFiles };
}

function parseNotify(value: unknown, problems: string[]): NotifySettings {
  const fallback: NotifySettings = {
    repeatSeconds: DEFAULT_REPEAT_SECONDS,
    conflictRepeatSeconds: DEFAULT_CONFLICT_REPEAT_SECONDS,
  };
  if (value === undefined) {
    return fallback;
  }
  if (!isTable(value)) {
    problems.push(t("notify 应当是一张表"));
    return fallback;
  }

  checkKeys(value, ["repeat_seconds", "conflict_repeat_seconds"], "notify", problems);
  const repeatSeconds = readInterval(
    value,
    "repeat_seconds",
    "notify",
    fallback.repeatSeconds,
    problems,
    0,
  );
  const conflictRepeatSeconds = readInterval(
    value,
    "conflict_repeat_seconds",
    "notify",
    fallback.conflictRepeatSeconds,
    problems,
    0,
  );
  return { repeatSeconds, conflictRepeatSeconds };
}

function parseUi(value: unknown, problems: string[]): UiSettings {
  const fallback: UiSettings = { language: "auto", openOnStart: true };
  if (value === undefined) {
    return fallback;
  }
  if (!isTable(value)) {
    problems.push(t("ui 应当是一张表"));
    return fallback;
  }

  checkKeys(value, ["language", "open_on_start"], "ui", problems);
  const language = readString(value, "language", "ui", problems) ?? fallback.language;
  const openOnStart = readBoolean(value, "open_on_start", "ui", problems) ?? fallback.openOnStart;
  if (!isLanguageChoice(language)) {
    problems.push(t("ui.language 只能取 {choices}", { choices: LANGUAGE_CHOICES.join(t("、")) }));
    return { ...fallback, openOnStart };
  }
  return { language, openOnStart };
}

function parseQuery(value: unknown, problems: string[]): QuerySettings {
  const fallback: QuerySettings = { remote: "", intervalSeconds: DEFAULT_QUERY_INTERVAL_SECONDS };
  if (value === undefined) {
    return fallback;
  }
  if (!isTable(value)) {
    problems.push(t("query 应当是一张表"));
    return fallback;
  }

  checkKeys(value, ["remote", "interval_seconds"], "query", problems);
  const remote = readString(value, "remote", "query", problems) ?? fallback.remote;
  const intervalSeconds = readInterval(
    value,
    "interval_seconds",
    "query",
    fallback.intervalSeconds,
    problems,
    0,
  );
  if (remote.length > MAX_REMOTE_NAME_LENGTH) {
    problems.push(t("query.remote 最长 {limit} 个字符", { limit: MAX_REMOTE_NAME_LENGTH }));
  } else if (containsControlCharacter(remote)) {
    problems.push(t("query.remote 不能含有控制字符"));
  } else if (remote.startsWith("-")) {
    // 以短横线开头的名字会被 git 当成选项，而远端名只需是个名字。
    problems.push(t("query.remote 不能以短横线开头"));
  }
  return { remote, intervalSeconds };
}

function parseRelays(value: unknown, problems: string[]): RelaySettings[] {
  if (value === undefined) {
    problems.push(t("缺少 relay：至少需要配置一个中继"));
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push(t("relay 应当是一组中继配置，每段以 [[relay]] 开头"));
    return [];
  }
  if (value.length === 0) {
    problems.push(t("至少需要配置一个中继"));
    return [];
  }
  if (value.length > MAX_RELAYS) {
    problems.push(t("中继最多 {limit} 个，当前为 {count} 个", { limit: MAX_RELAYS, count: value.length }));
  }

  const relays: RelaySettings[] = [];
  const names = new Set<string>();

  value.forEach((entry, index) => {
    const where = `relay[${index}]`;
    if (!isTable(entry)) {
      problems.push(t("{where} 应当是一张表", { where }));
      return;
    }

    checkKeys(entry, ["name", "url", "transport", "channel_id", "channel_token"], where, problems);
    const name = readString(entry, "name", where, problems) ?? "";
    const url = readString(entry, "url", where, problems) ?? "";
    const transport = readTransport(entry["transport"], where, problems);
    const channelId = readString(entry, "channel_id", where, problems) ?? "";
    const channelToken = readString(entry, "channel_token", where, problems) ?? "";

    if (name === "") {
      problems.push(t("{where}.name 不能为空", { where }));
    } else if (name.length > MAX_RELAY_NAME_LENGTH) {
      problems.push(t("{where}.name 最长 {limit} 个字符", { where, limit: MAX_RELAY_NAME_LENGTH }));
    } else if (names.has(name)) {
      problems.push(t("{where}.name 与其他中继重名：{name}", { where, name }));
    }
    names.add(name);

    const scheme = checkUrl(url, `${where}.url`, problems);
    if (scheme !== undefined && transport !== undefined && !isSchemeConsistent(transport, scheme)) {
      problems.push(t("{where} 的 transport 为 {transport}，地址却以 {scheme} 开头", { where, transport, scheme }));
    }

    if (transport !== undefined && name !== "" && url !== "") {
      relays.push({ name, url, transport, channelId, channelToken });
    }
  });

  return relays;
}

function readTransport(value: unknown, where: string, problems: string[]): TransportLevel | undefined {
  if (value === undefined) {
    problems.push(t("{where}.transport 不能为空：连接方式必须显式写出", { where }));
    return undefined;
  }
  if (typeof value !== "string" || !isTransportLevel(value)) {
    problems.push(
      t("{where}.transport 只能取 {choices}", { where, choices: TRANSPORT_LEVELS.join(t("、")) }),
    );
    return undefined;
  }
  return value;
}

function isTransportLevel(value: string): value is TransportLevel {
  return (TRANSPORT_LEVELS as readonly string[]).includes(value);
}

function isSchemeConsistent(transport: TransportLevel, scheme: string): boolean {
  return transport === "plaintext" ? scheme === "http" : scheme === "https";
}

/** 校验地址，返回识别出的协议名；地址不合规时返回空。 */
function checkUrl(value: string, where: string, problems: string[]): string | undefined {
  if (value === "") {
    problems.push(t("{where} 不能为空", { where }));
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(t("{where} 不是合法的地址：{value}", { where, value }));
    return undefined;
  }

  const scheme = parsed.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    problems.push(t("{where} 的协议只能是 http 或 https，实际为 {scheme}", { where, scheme }));
    return undefined;
  }
  // http 与 https 属于特殊协议，解析器已经保证主机名非空，这里不再重复判断。
  return scheme;
}

function readInterval(
  table: Record<string, unknown>,
  key: string,
  where: string,
  fallback: number,
  problems: string[],
  minimum: number,
): number {
  const value = readInteger(table, key, where, problems);
  if (value === undefined) {
    return fallback;
  }
  if (value < minimum || value > MAX_INTERVAL_SECONDS) {
    problems.push(
      t("{where}.{key} 应当介于 {minimum} 与 {maximum} 之间（秒），实际为 {value}", {
        where,
        key,
        minimum,
        maximum: MAX_INTERVAL_SECONDS,
        value,
      }),
    );
    return fallback;
  }
  return value;
}

function readString(
  table: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    problems.push(t("{where}.{key} 应当是字符串", { where, key }));
    return undefined;
  }
  return value;
}

function readInteger(
  table: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): number | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    problems.push(t("{where}.{key} 应当是整数", { where, key }));
    return undefined;
  }
  return value;
}

function readBoolean(
  table: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): boolean | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    problems.push(t("{where}.{key} 应当是 true 或 false", { where, key }));
    return undefined;
  }
  return value;
}

/** 拒绝未列出的键：写错的配置项若被静默忽略，使用者会以为它已经生效。 */
function checkKeys(
  table: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      problems.push(t("{where} 中不认识的配置项：{key}", { where, key }));
    }
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // 日期在 TOML 中是独立类型，落到这里说明配置结构与预期不符。
  return !(value instanceof Date);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
