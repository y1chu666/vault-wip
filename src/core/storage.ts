// 本模块负责插件在本机留下的文件：配置、设备私钥、内容密钥、钉住的中继信息与状态缓存。
//
// 文件都放在插件目录下，调用方给出目录，这里只认路径，不认识 Obsidian。
// 密钥文件落盘时收紧权限，并在同目录写一份只列密钥文件名的 .gitignore：
// 插件目录若随仓库或同步工具流转，这一步能挡住提交，挡不住使用者主动外发。
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateContentKey, encodeContentKey, decodeContentKey } from "./crypto.js";
import type { ContentKey } from "./crypto.js";
import { DeviceKey } from "./identity.js";
import type { DeviceStatus } from "./state.js";
import { decodeText, encodeText } from "./text.js";

/** 状态缓存的格式版本。 */
export const STATE_VERSION = 1;

/** 密钥文件的权限：只有属主可读写。 */
const SECRET_MODE = 0o600;

/** 密钥文件名，写进 .gitignore 的就是这些。 */
export const SECRET_FILE_NAMES = [
  "device.key",
  "content.key",
  // 导出给其他设备的内容密钥文件与它的口令封装版本：默认也挡住，免得顺手提交上去。
  "content-key.export",
  "content-key.protected",
] as const;

/** 插件在本机的文件。 */
export interface PluginFiles {
  /** 配置文件。 */
  readonly config: string;
  /** 设备私钥。 */
  readonly deviceKey: string;
  /** 内容密钥。 */
  readonly contentKey: string;
  /** 钉住的中继信息。 */
  readonly pins: string;
  /** 状态缓存。 */
  readonly state: string;
  /** 本目录的忽略清单。 */
  readonly ignore: string;
}

/** 文件读写失败。 */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** 由插件目录给出各文件的绝对路径。 */
export function pluginFiles(baseDir: string): PluginFiles {
  return {
    config: join(baseDir, "config.toml"),
    deviceKey: join(baseDir, "device.key"),
    contentKey: join(baseDir, "content.key"),
    pins: join(baseDir, "pins.json"),
    state: join(baseDir, "state.json"),
    ignore: join(baseDir, ".gitignore"),
  };
}

/** 读一份文本文件；文件不存在时返回空。其余失败抛出 {@link StorageError}。 */
export async function readTextFile(path: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw new StorageError(`读取 ${path} 失败：${messageOf(error)}`);
  }

  try {
    return decodeText(bytes);
  } catch {
    throw new StorageError(`${path} 不是 UTF-8 文本`);
  }
}

/**
 * 写一份文本文件。
 *
 * 先写同目录下的临时文件再改名：中途失败或断电最多留下一个临时文件，
 * 不会把原有内容截成半截——配置与状态都经不起这种损坏。
 */
export async function writeTextFile(path: string, text: string, mode?: number): Promise<void> {
  const temporary = `${path}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, encodeText(text));
    if (mode !== undefined) {
      await chmod(temporary, mode);
    }
    await rename(temporary, path);
  } catch (error) {
    throw new StorageError(`写入 ${path} 失败：${messageOf(error)}`);
  }
}

/**
 * 保证忽略清单里列出密钥文件。
 *
 * 只补上缺的条目，不动已有的内容：使用者若在同一个文件里写过别的规则，
 * 那些规则属于他们自己。
 */
export async function ensureSecretIgnore(path: string, names: readonly string[]): Promise<void> {
  const existing = (await readTextFile(path)) ?? "# 本目录由 Vault Waystation 使用；以下文件含密钥，不要纳入版本控制。\n";
  const missing = names.filter((name) => !existing.split(/\r?\n/).includes(name));
  if (missing.length === 0) {
    return;
  }
  const separator = existing.endsWith("\n") ? "" : "\n";
  await writeTextFile(path, `${existing}${separator}${missing.join("\n")}\n`);
}

/** 读设备私钥；没有就生成一份并写进文件。 */
export async function loadOrCreateDeviceKey(files: PluginFiles): Promise<{ key: DeviceKey; created: boolean }> {
  const text = await readTextFile(files.deviceKey);
  if (text !== null) {
    try {
      return { key: DeviceKey.fromSeedText(text.trim()), created: false };
    } catch (error) {
      throw new StorageError(`设备私钥不可用：${messageOf(error)}`);
    }
  }

  const key = DeviceKey.generate();
  await writeTextFile(files.deviceKey, `${key.seedHexForStorage()}\n`, SECRET_MODE);
  return { key, created: true };
}

/** 读内容密钥；没有就生成一份并写进文件。 */
export async function loadOrCreateContentKey(files: PluginFiles): Promise<{ key: ContentKey; created: boolean }> {
  const text = await readTextFile(files.contentKey);
  if (text !== null) {
    try {
      return { key: decodeContentKey(text), created: false };
    } catch (error) {
      throw new StorageError(`内容密钥不可用：${messageOf(error)}`);
    }
  }

  const key = generateContentKey();
  await writeTextFile(files.contentKey, `${encodeContentKey(key)}\n`, SECRET_MODE);
  return { key, created: true };
}

/** 一台中继的钉住信息。 */
export interface RelayPin {
  /** 中继用于签署响应的公钥指纹。 */
  readonly serverFingerprint: string;
  /** 该公钥的原文，Base64。 */
  readonly serverPublicKey: string;
  /** 中继证书的 SPKI 指纹；仅钉住自签证书一级使用，其余级别为空。 */
  readonly spki: string;
}

/** 读钉住的中继信息。文件不存在时返回空表；内容不合规时抛出。 */
export async function loadRelayPins(path: string): Promise<Map<string, RelayPin>> {
  const text = await readTextFile(path);
  if (text === null) {
    return new Map();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StorageError(`${path} 不是合法的 JSON，请删掉它重新配对`);
  }
  if (!isTable(raw)) {
    throw new StorageError(`${path} 的内容不是一张表，请删掉它重新配对`);
  }

  const pins = new Map<string, RelayPin>();
  for (const [name, value] of Object.entries(raw)) {
    if (!isTable(value)) {
      throw new StorageError(`${path} 中 ${name} 一项的内容不合规，请删掉它重新配对`);
    }
    const serverFingerprint = value["serverFingerprint"];
    const serverPublicKey = value["serverPublicKey"];
    const spki = value["spki"];
    if (typeof serverFingerprint !== "string" || typeof serverPublicKey !== "string" || typeof spki !== "string") {
      throw new StorageError(`${path} 中 ${name} 一项的内容不合规，请删掉它重新配对`);
    }
    pins.set(name, { serverFingerprint, serverPublicKey, spki });
  }
  return pins;
}

/** 写下钉住的中继信息。 */
export async function saveRelayPins(path: string, pins: ReadonlyMap<string, RelayPin>): Promise<void> {
  const document: Record<string, RelayPin> = {};
  for (const [name, pin] of [...pins.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    document[name] = pin;
  }
  await writeTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

/** 缓存下来的自身进度与已知对端，重启后据此接着走。 */
/** 已注册的频道。频道标识由各中继分别生成，因此按中继名分别记录。 */
export interface ChannelRegistration {
  readonly channelId: string;
  readonly alias: string;
}

export interface PersistedState {
  readonly version: number;
  /** 各中继上的频道；尚未注册时为空表。 */
  readonly channels: Readonly<Record<string, ChannelRegistration>>;
  /** 本设备已上报到的序号。 */
  readonly sequence: number;
  readonly peers: readonly DeviceStatus[];
  /** 已读到的吊销名单，长期保留。 */
  readonly revoked: readonly string[];
  /** 本设备是否已在这一轮中退役；退役后需重新注册才能继续使用。 */
  readonly retired: boolean;
}

/**
 * 读状态缓存。
 *
 * 缓存损坏时返回空，由调用方当作首次运行处理：记录本身随时可以从各中继重新取回，
 * 序号也会在中继指出既有记录后对齐，因此丢弃缓存不会丢失事实。
 */
export async function loadState(path: string): Promise<PersistedState | null> {
  const text = await readTextFile(path);
  if (text === null) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isTable(raw) || raw["version"] !== STATE_VERSION) {
    return null;
  }

  const channels = parseChannels(raw["channels"]);
  const sequence = raw["sequence"];
  const peers = raw["peers"];
  const revoked = raw["revoked"];
  const retired = raw["retired"];
  if (channels === null || !isSequence(sequence) || !Array.isArray(peers) || !Array.isArray(revoked)) {
    return null;
  }
  if (typeof retired !== "boolean") {
    return null;
  }

  const parsedPeers: DeviceStatus[] = [];
  for (const peer of peers as unknown[]) {
    const parsed = parseDeviceStatus(peer);
    if (parsed === null) {
      return null;
    }
    parsedPeers.push(parsed);
  }

  const revokedFingerprints: string[] = [];
  for (const entry of revoked as unknown[]) {
    if (typeof entry !== "string") {
      return null;
    }
    revokedFingerprints.push(entry);
  }

  return {
    version: STATE_VERSION,
    channels,
    sequence,
    peers: parsedPeers,
    revoked: revokedFingerprints,
    retired,
  };
}

/** 写下状态缓存。 */
export async function saveState(path: string, state: PersistedState): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** 文件是否存在。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw new StorageError(`查看 ${path} 失败：${messageOf(error)}`);
  }
}

function parseChannels(raw: unknown): Record<string, ChannelRegistration> | null {
  if (!isTable(raw)) {
    return null;
  }
  const channels: Record<string, ChannelRegistration> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isTable(value)) {
      return null;
    }
    const channelId = value["channelId"];
    const alias = value["alias"];
    if (typeof channelId !== "string" || typeof alias !== "string") {
      return null;
    }
    channels[name] = { channelId, alias };
  }
  return channels;
}

function parseDeviceStatus(raw: unknown): DeviceStatus | null {
  if (!isTable(raw)) {
    return null;
  }
  const { fingerprint, label, sequence, collectedAt, payload } = raw;
  if (typeof fingerprint !== "string" || typeof label !== "string" || !isSequence(sequence)) {
    return null;
  }
  if (typeof collectedAt !== "string" || !isTable(payload)) {
    return null;
  }

  const parsed = parsePayload(payload);
  if (parsed === null) {
    return null;
  }
  return { fingerprint, label, sequence, collectedAt, payload: parsed };
}

function parsePayload(raw: Record<string, unknown>): DeviceStatus["payload"] | null {
  const { label, count, truncated, paths, suspectFiles, conflictFiles } = raw;
  if (typeof label !== "string" || !isSequence(count) || typeof truncated !== "boolean") {
    return null;
  }
  const pathList = parsePathList(paths);
  const suspects = parsePathList(suspectFiles);
  const conflicts = parsePathList(conflictFiles);
  if (pathList === null || suspects === null || conflicts === null) {
    return null;
  }
  return { label, count, truncated, paths: pathList, suspectFiles: suspects, conflictFiles: conflicts };
}

function parsePathList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const entries: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "string") {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
