// 本模块收拢界面文案：中文原句直接写在调用处，英文译文集中在下面这张表里。
//
// 拿中文原句当键，是因为这个项目以中文为准：改了原句就等于改了这条文案，全仓库
// 检索一句就能一并改到。译文表由 MessageKey 约束，漏译一条就通不过类型检查，
// 因此不存在「英文界面里突然冒出一句中文」的后路。
//
// 语言状态只有一处。插件外壳按设置与 Obsidian 的界面语言算出用哪一套，然后告诉
// 本模块；核心逻辑不认 Obsidian，因此它自己不问语言，只在这里取文字。
//
// 一句话在拼接时就已定下语言，因此切换语言只影响此后新产生的文字：诊断里先前的
// 条目保留写入时的语言，那是当时确实发生过的记录。

/** 支持的语言。 */
export const LOCALES = ["zh", "en"] as const;

/** 一种语言。 */
export type Locale = (typeof LOCALES)[number];

/**
 * 插件在界面上的名字。
 *
 * 这个名字不翻译：清单里的名字、通知前缀与状态栏前缀都要一致，翻成别的写法只会
 * 让使用者对不上号。放在这里是因为界面与外壳都要用它。
 */
export const PLUGIN_NAME = "Vault Waystation";

/**
 * 英文译文。键是中文原句，占位写成 {名称}。
 *
 * 译文可自由调换词序，只须用同一个占位名称；句读按英文习惯来，因此不保留中文的
 * 全角标点。列表分隔符一类的碎片也在这里，便于译文换成半角标点。
 *
 * 导出是为了让测试逐条核对译文（不夹中文、占位对得上）；界面只经由 t 取用。
 */
export const ENGLISH = {
  // 碎片：列表与句子的连接符。
  "、": ", ",
  "；": "; ",
  "「{name}」": '"{name}"',
  "{name}：{text}": "{name}: {text}",

  // 插件外壳：提醒、状态栏与命令。
  "{name}：查看各端状态": "{name}: show device status",
  "本插件只在桌面端可用": "This plugin is available on desktop only",
  "配置尚未就绪": "settings are not ready yet",
  "注册完成": "registration complete",
  "已吊销设备 {fingerprint}": "revoked device {fingerprint}",
  "本设备已退役，需要重新注册才能继续使用": "this device has been retired; register again before using it",
  "已换用新的内容密钥": "switched to the new content key",
  "本机计数已重置": "the local counter has been reset",
  "配置有误": "configuration error",
  "未就绪": "not ready",
  "本设备已退役": "device retired",
  "未配置中继": "no relay configured",
  "中继 {reachable}/{total}": "relays {reachable}/{total}",
  "冲突 {count}": "conflicts {count}",
  "对端 {count} 台有改动": "{count} devices with changes",

  // 提示语。
  "可能冲突的改动": "Changes that may conflict",
  "{subject}在本地与{names}上都有未提交改动，提交或拉取之前请先确认。{hint}":
    "{subject} has uncommitted changes both here and on {names}. Please confirm before committing or pulling.{hint}",
  "「{path}」等 {count} 个文件": '"{path}" and {count} files in total',
  "本地这边的差异看来只是行尾或权限位，可能无需处理。":
    " The difference on this side looks like line endings or permission bits only; it may need no action.",
  "对端那边的差异看来只是行尾或权限位，可能无需处理。":
    " The difference on the other side looks like line endings or permission bits only; it may need no action.",
  "对端有未提交改动": "Another device has uncommitted changes",
  "{described}，开始编辑之前请先留意。": "{described}. Please keep that in mind before you start editing.",
  "{name}有 {count} 处未提交改动": "{name} has {count} uncommitted changes",
  "中继不可达": "Relay unreachable",
  "已持续 {duration}无法联系中继{relay}：{reason}":
    "Unable to reach relay {relay} for {duration}: {reason}",
  "中继已恢复": "Relay recovered",
  "与中继{relay}的联系已恢复，本地状态将照常上报。":
    "Connection to relay {relay} has recovered; local state will be reported as usual.",

  // 时长。
  "{seconds} 秒": "{seconds} seconds",
  "{minutes} 分钟": "{minutes} minutes",
  "{hours} 小时": "{hours} hours",
  "{hours} 小时 {minutes} 分钟": "{hours} hours {minutes} minutes",
  "{millis} 毫秒": "{millis} ms",

  // 状态视图：分栏与表头。
  "概览": "Overview",
  "各端状态": "Devices",
  "中继": "Relays",
  "安全": "Security",
  "诊断": "Diagnostics",
  "名称": "Name",
  "（未命名）": "(unnamed)",
  "指纹": "Fingerprint",
  "已上报序号": "Reported sequence",
  "序号": "Sequence",
  "仓库别名": "Vault alias",
  "改动文件": "Changed files",
  "清单是否截断": "List truncated",
  "是": "Yes",
  "否": "No",
  "采集时间": "Collected at",
  "耗时": "Duration",
  "git 版本": "Git version",
  "未知": "unknown",
  "无": "none",
  "地址": "Address",
  "传输级别": "Transport level",
  "频道标识": "Channel id",
  "最近一次成功": "Last success",
  "最近一次失败": "Last failure",
  "内容密钥标识": "Content key id",
  "本设备是否已退役": "Device retired",

  // 状态视图：概览。
  "本设备": "This device",
  "本机改动": "Local changes",
  "与对端的冲突": "Conflicts with other devices",
  "本设备已退役：需要重新注册才能继续使用。":
    "This device has been retired. Register again before using it.",
  "尚未取得本机状态。": "Local status is not available yet.",
  "没有发现两端改到同一个文件。": "No file has been changed on both sides.",
  "立即采集并上报": "Collect and report now",

  // 状态视图：各端状态。
  "还没有收到其他设备的记录。": "No updates from other devices yet.",
  "已被吊销": "Revoked",
  "下列设备的记录此后不再参与判断；吊销名单长期保留，不会自行消失。":
    "These devices no longer take part in the check. The revoke list is kept permanently and does not expire.",
  "吊销这台设备": "Revoke this device",
  "没有改动文件。": "No changed files.",
  "另有 {count} 个文件未列出。": "{count} more files are not listed.",
  "{count} 个文件的差异看来只是行尾或权限位":
    "The differences in {count} files look like line endings or permission bits only",
  "{count} 个文件留有合并冲突的痕迹": "{count} files still hold traces of a merge conflict",
  "{path}：与 {names} 的重叠{caution}": "{path}: overlaps with {names}{caution}",
  "（其中一边的差异看来只是行尾或权限位）":
    " (the difference on one side looks like line endings or permission bits only)",

  // 状态视图：中继。
  "尚未配置中继：请在插件设置里添加一台。": "No relay is configured yet. Add one in the plugin settings.",
  "有中继处于降级传输：通信不加密或可被冒充，此时不允许注册、吊销与退役。":
    "A relay is on a degraded transport: traffic is unencrypted or can be impersonated, so registration, revocation and retirement are unavailable.",
  "这一级属于降级传输：注册、吊销与退役在此不可用。":
    "This level is a degraded transport: registration, revocation and retirement are unavailable here.",
  "尚未注册": "not registered yet",
  "不使用或尚未钉住": "not used or not pinned yet",
  "尚未配对": "not paired yet",
  "公开证书": "public certificate",
  "钉住自签证书": "pinned self-signed certificate",
  "忽略证书错误（降级）": "certificate errors ignored (degraded)",
  "明文（降级）": "plaintext (degraded)",

  // 状态视图：诊断。
  "最近一次采集": "Last collection",
  "本机计数": "Local counter",
  "序号由本设备自己推进，平时不必过问。只有在它已经无法继续推进时（例如上一条记录越过了可表示范围），才需要在这里重置；重置只改本机计数，中继上的数据一条不动。":
    "The sequence is advanced by this device alone and normally needs no attention. Reset it only when it can no longer advance, for instance when the previous record passed the representable range; a reset changes the local counter only and leaves the data on the relays untouched.",
  "重置本机计数": "Reset the local counter",
  "确认重置：下一次上报将从 1 重新对齐": "Confirm reset: the next report starts again from 1",
  "事件": "Events",
  "尚无事件。": "No events yet.",
  "被舍弃的记录": "Discarded records",
  "{at} 设备 {fingerprint}：{reason}": "{at} device {fingerprint}: {reason}",
  "序号异常": "Sequence anomalies",
  "设备 {fingerprint} 在序号 {incoming} 上出现了与序号 {known} 不同的内容":
    "Device {fingerprint} sent different content for sequence {incoming} than for sequence {known}",

  // 状态视图：安全。
  "记录内容以仓库为范围端到端加密，中继只见到密文。内容密钥由本机生成，可以按下面三种方式交给同仓库的其他设备。":
    "Record contents are encrypted end to end within a vault, so a relay only ever sees ciphertext. The content key is generated on this device and can be handed to other devices of the same vault in any of the three ways below.",
  "本机密钥串": "Key string of this device",
  "复制密钥串": "Copy key string",
  "保存到文件": "Save to file",
  "密钥串已复制到剪贴板": "Key string copied to the clipboard",
  "复制失败，请改用保存到文件": "Copying failed; use \"save to file\" instead",
  "已写入 {path}：请按秘密看待这个文件。": "Written to {path}. Treat this file as a secret.",
  "口令封装": "Passphrase-protected",
  "口令封装的文件仍需要口令才能解开，可以走不那么可信的渠道；口令往往比随机密钥串弱，因此这种方式排在密钥串之后。":
    "A passphrase-protected file still needs the passphrase to be opened, so it may travel over a less trusted channel. A passphrase is usually weaker than a random key string, which is why this way comes after the key string.",
  "口令": "passphrase",
  "复制封装的密钥": "Copy protected key",
  "封装的密钥已复制到剪贴板": "Protected key copied to the clipboard",
  "已写入 {path}：连同口令一起交给另一台设备。":
    "Written to {path}. Hand it to the other device together with the passphrase.",
  "导入密钥": "Import a key",
  "把另一台设备给出的密钥串或口令封装文本粘贴进来；口令留空表示文本是密钥串本身。":
    "Paste the key string or the passphrase-protected text from the other device; leave the passphrase empty if the text is the key string itself.",
  "密钥串或口令封装文本": "key string or passphrase-protected text",
  "口令（可留空）": "passphrase (may be empty)",
  "导入并换用": "Import and switch",
  "中继身份": "Relay identity",
  "首次配对时中继的公钥没有旁证，只能先收下；把下面的指纹与中继那一侧核对一次，此后换了钥匙就会停下来。":
    "At the first pairing a relay's public key has no second opinion, so it is taken as it comes. Compare the fingerprints below with the relay side once; from then on a changed key stops the connection.",
  "{name} 的公钥指纹": "{name} public key fingerprint",
  "{name} 的证书指纹": "{name} certificate fingerprint",
  "本设备的指纹出现在吊销名单里，需要中继那边恢复之后才能继续使用。":
    "This device's fingerprint is on the revoke list; the relay side must undo that before this device can be used again.",
  "退役本设备": "Retire this device",
  "确认退役：删除各中继上的本设备数据并记入吊销名单":
    "Confirm retirement: delete this device's data on every relay and add it to the revoke list",
  "退役会删除各中继上本设备的数据，并把本设备记入吊销名单；此后需要重新向中继注册才能继续使用。":
    "Retiring deletes this device's data on every relay and adds it to the revoke list; afterwards it must register with the relays again before it can be used.",

  // 状态视图：读取配置失败时的说明。
  "配置有误：{error}": "Configuration error: {error}",
  "配置文件：{path}": "Configuration file: {path}",
  "尚未就绪：请在设置里填好中继信息。": "Not ready yet: fill in the relay settings first.",

  // 设置页。
  "公开证书（推荐）": "public certificate (recommended)",
  "配置文件有误": "The configuration file has errors",
  "改正之后按下面的按钮重新读取。": "Fix it, then use the button below to read the file again.",
  "重新读取配置": "Read the configuration again",
  "尚未就绪。": "Not ready yet.",
  "本设备名称": "Name of this device",
  "写进加密的记录内容，供同仓库的其他设备辨认。中继看不到它。留空时对端只按指纹称呼本设备。":
    "Written into the encrypted record contents so other devices of the same vault can tell them apart. A relay cannot see it. When left empty, the other side refers to this device by fingerprint alone.",
  "例如：书房台式机": "for example: study desktop",
  "注册时按这个名称请求频道，同一仓库的各设备要写同一个名字。":
    "The channel is requested under this name at registration; every device of the same vault must write the same name.",
  "采集": "Collection",
  "git 可执行文件": "git executable",
  "留空表示从 PATH 中查找。": "Leave empty to look it up in PATH.",
  "定时采集间隔": "Interval between scheduled collections",
  "窗口失焦后多久降频": "Delay before slowing down when the window loses focus",
  "0 表示不降频。": "0 means no slowdown.",
  "不降频": "no slowdown",
  "失焦后的采集间隔": "Interval while unfocused",
  "识别合并冲突的残留文件": "Recognise leftover files from a merge conflict",
  "开启时会把留有合并痕迹的文件单独标出，只影响措辞，不影响是否算冲突。":
    "When on, files that still hold traces of a merge are called out separately; this changes the wording only, not whether something counts as a conflict.",
  "提醒": "Notifications",
  "持续故障的重提醒间隔": "Interval between repeated notices of an ongoing failure",
  "只在中继持续联系不上时使用；0 表示只在故障开始时提醒一次。":
    "Used only while a relay stays unreachable; 0 means to notify once when the failure starts.",
  "关闭重提醒": "no repeat notice",
  "可以填多台；各中继之间互不相通，记录由本机搬运。传输级别与地址协议必须相符。":
    "Several relays may be listed. Relays do not talk to each other, and this device carries records between them. The transport level must match the address scheme.",
  "第 {index} 台": "Relay {index}",
  "移除这一台": "Remove this one",
  "添加一台中继": "Add a relay",
  "注册": "Registration",
  "注册凭证": "Registration credential",
  "有中继处于降级传输，此时不允许注册；请先改回公开证书或钉住自签证书。":
    "A relay is on a degraded transport, so registration is not allowed; switch back to a public certificate or a pinned self-signed certificate first.",
  "向中继注册本仓库时需要出示一次。这份凭证不会写进配置文件。":
    "It is shown once when this vault registers with a relay. The credential is never written to the configuration file.",
  "凭证": "credential",
  "注册本仓库": "Register this vault",
  "文件": "Files",
  "设备私钥、内容密钥与中继公钥另存于同一目录，已被该目录下的忽略清单挡住；请勿把它们纳入版本控制。":
    "The device private key, the content key and the relay public keys live in the same folder, kept out of version control by the ignore list there; do not add them.",
  "插件目录：{path}": "Plugin folder: {path}",

  // 设置页：界面语言。
  "界面": "Interface",
  "界面语言": "Interface language",
  "跟随 Obsidian 时按界面的语言取文案；命令名在插件重新加载之后才会跟着变。":
    "When following Obsidian, the wording follows the interface language; command names change only after the plugin is reloaded.",
  "跟随 Obsidian": "follow Obsidian",
  "中文": "Chinese",
  "英文": "English",
} as const;

/** 可用的文案键，即英文表里有的那些中文原句。 */
export type MessageKey = keyof typeof ENGLISH;

/** 句子里的占位实参。 */
export type MessageParams = Readonly<Record<string, string | number>>;

/** 模板里占位的写法。 */
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

let current: Locale = "zh";

/** 当前语言。 */
export function getLocale(): Locale {
  return current;
}

/** 换用另一种语言。此后新产生的文字随之改变，已经写下的不变。 */
export function setLocale(locale: Locale): void {
  current = locale;
}

/** 取值是否是一种支持的语言。 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * 取一句话。
 *
 * 中文用原句，英文查表；表里没有对应键时类型检查就通不过，因此这里不必留退路。
 * 占位按名称替换，没给出对应实参的占位原样留下，免得悄悄少掉一截。
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = current === "en" ? ENGLISH[key] : key;
  if (params === undefined) {
    return template;
  }

  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
