// 本模块负责把频道内各设备的状态记录合到一起，并判断是否存在真冲突。
//
// 记录只按序号推进：序号更小的记录一律丢弃，序号相同而内容不同则视为异常，
// 因为同一台设备在同一个序号上不该给出两份内容。合并只做判断，不落盘，
// 落盘与上报由调用方按自己的节奏进行。
import { digestHex } from "./envelope.js";
import type { StatusPayload } from "./payload.js";
import { t } from "./i18n.js";

/** 一台设备的已知状态。 */
export interface DeviceStatus {
  readonly fingerprint: string;
  /** 设备名称，取自该设备自己加密的记录内容。 */
  readonly label: string;
  readonly sequence: number;
  /** 采集时间，RFC 3339 文本，协调世界时。 */
  readonly collectedAt: string;
  readonly payload: StatusPayload;
}

/** 一条已知的吊销记录。名称与时间只为界面辨认，旧缓存里可能没有。 */
export interface RevokedDevice {
  readonly fingerprint: string;
  /** 吊销时已知的设备名称；从未见过这台设备时为空。 */
  readonly name: string;
  /** 吊销时刻，RFC 3339；旧缓存里没有则为 null。 */
  readonly revokedAt: string | null;
}

/** 序号推进中的异常。 */
export interface SequenceAnomaly {
  readonly fingerprint: string;
  /** `stale` 表示序号回退，`mismatch` 表示同序号却给出不同内容。 */
  readonly kind: "stale" | "mismatch";
  readonly knownSequence: number;
  readonly incomingSequence: number;
}

/** 一次合并的结果。 */
export interface MergeResult {
  /** 合并后的对端清单，按指纹排序。 */
  readonly peers: DeviceStatus[];
  /** 本次被采纳的指纹。 */
  readonly accepted: readonly string[];
  readonly anomalies: readonly SequenceAnomaly[];
}

/** 本地与对端落在同一文件上的改动。 */
export interface Conflict {
  readonly path: string;
  /** 涉及的对端。 */
  readonly peers: readonly ConflictPeer[];
  /** 本地这边的差异看来只是行尾或权限位。 */
  readonly localSuspect: boolean;
  /** 至少一台对端那边的差异看来只是行尾或权限位。 */
  readonly peerSuspect: boolean;
}

/** 冲突涉及的对端，带上用于显示的称呼。 */
export interface ConflictPeer {
  readonly fingerprint: string;
  readonly name: string;
}

/** 默认称呼：设备没有留下名称时用指纹的前几位代指，免得界面上只剩空白。 */
export function displayName(peer: DeviceStatus): string {
  return peer.label === "" ? t("设备 {fingerprint}", { fingerprint: peer.fingerprint.slice(0, 8) }) : peer.label;
}

/** 下一次上报应当使用的序号。 */
export function nextSequence(current: number): number {
  return current + 1;
}

/**
 * 合并对端记录。
 *
 * 同一台设备的记录只按序号取新：序号相同却内容不同说明设备状态被复制或回退过，
 * 此时保留既有记录并把异常报上去，由使用者决定，而不是悄悄采用新内容。
 */
export function mergePeers(
  known: readonly DeviceStatus[],
  incoming: readonly DeviceStatus[],
): MergeResult {
  const byFingerprint = new Map(known.map((peer) => [peer.fingerprint, peer]));
  const accepted: string[] = [];
  const anomalies: SequenceAnomaly[] = [];

  for (const record of incoming) {
    const existing = byFingerprint.get(record.fingerprint);
    if (existing === undefined) {
      byFingerprint.set(record.fingerprint, record);
      accepted.push(record.fingerprint);
      continue;
    }

    if (record.sequence > existing.sequence) {
      byFingerprint.set(record.fingerprint, record);
      accepted.push(record.fingerprint);
      continue;
    }

    if (record.sequence === existing.sequence && payloadDigest(record.payload) !== payloadDigest(existing.payload)) {
      anomalies.push({
        fingerprint: record.fingerprint,
        kind: "mismatch",
        knownSequence: existing.sequence,
        incomingSequence: record.sequence,
      });
      continue;
    }

    if (record.sequence < existing.sequence) {
      anomalies.push({
        fingerprint: record.fingerprint,
        kind: "stale",
        knownSequence: existing.sequence,
        incomingSequence: record.sequence,
      });
    }
  }

  const peers = [...byFingerprint.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return { peers, accepted, anomalies };
}

/** 记录内容的摘要，用于判断同一序号上的两份内容是否一致。 */
export function payloadDigest(payload: StatusPayload): string {
  return digestHex(
    Buffer.from(
      JSON.stringify({
        label: payload.label,
        count: payload.count,
        truncated: payload.truncated,
        paths: [...payload.paths].sort(),
        suspectFiles: [...payload.suspectFiles].sort(),
        conflictFiles: [...payload.conflictFiles].sort(),
      }),
      "utf8",
    ),
  );
}

/** 只保留未被吊销的设备：被吊销的设备不再参与冲突判定。 */
export function activePeers(peers: readonly DeviceStatus[], revoked: readonly string[]): DeviceStatus[] {
  const revokedSet = new Set(revoked);
  return peers.filter((peer) => !revokedSet.has(peer.fingerprint));
}

/**
 * 找出本地与对端改动落在同一文件上的情形。
 *
 * 这就是本插件要防的那件事：两端都改过同一个文件，谁先提交谁后拉取都可能冲突。
 * 假冲突的判定只用于措辞，因此这里只标注，不排除。
 */
export function findConflicts(local: StatusPayload | null, peers: readonly DeviceStatus[]): Conflict[] {
  if (local === null) {
    return [];
  }

  const localPaths = new Set(local.paths);
  const localSuspects = new Set(local.suspectFiles);
  const found = new Map<string, { peers: ConflictPeer[]; peerSuspect: boolean; localSuspect: boolean }>();

  for (const peer of peers) {
    const peerSuspects = new Set(peer.payload.suspectFiles);
    for (const path of peer.payload.paths) {
      if (!localPaths.has(path)) {
        continue;
      }
      const entry = found.get(path) ?? {
        peers: [],
        peerSuspect: false,
        localSuspect: localSuspects.has(path),
      };
      entry.peers.push({ fingerprint: peer.fingerprint, name: displayName(peer) });
      entry.peerSuspect = entry.peerSuspect || peerSuspects.has(path);
      found.set(path, entry);
    }
  }

  return [...found.entries()]
    .map(([path, entry]) => ({
      path,
      peers: [...entry.peers].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
      localSuspect: entry.localSuspect,
      peerSuspect: entry.peerSuspect,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** 汇总对端有未提交改动的情形，供启动后的提示使用。 */
export function peersWithChanges(peers: readonly DeviceStatus[]): DeviceStatus[] {
  return peers.filter((peer) => peer.payload.count > 0);
}
