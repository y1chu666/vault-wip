// 本模块决定什么时候弹出提示，以及提示怎么写。
//
// 提示一律只在窗口聚焦时弹出：编辑到一半被系统通知打断，比没有提示更烦人。
// 真冲突、启动后对端有改动、持续故障与恢复各有各的去重规则，规则集中在这里，
// 界面层只负责把给出的文字显示出来。
import { t } from "./i18n.js";
import type { Conflict, DeviceStatus } from "./state.js";
import { displayName } from "./state.js";

/** 提醒配置。 */
export interface AlertSettings {
  /** 持续故障的重提醒间隔（秒），0 表示关闭重提醒。 */
  readonly repeatSeconds: number;
  /** 冲突仍在时的重提醒间隔（秒），0 表示每个冲突只提示一次。 */
  readonly conflictRepeatSeconds: number;
}

/** 一条待弹出的提示。 */
export interface Notice {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
}

/** 提示的种类。 */
export type NoticeKind = "conflict" | "peerChanges" | "failure" | "recovered";

/** 持续故障的现状。 */
export interface FailureState {
  /** 故障开始时刻（毫秒）。 */
  readonly since: number;
  /** 面向使用者的原因。 */
  readonly message: string;
}

/** 一次判断所需的输入。 */
export interface AlertInput {
  /** 当前时刻（毫秒）。 */
  readonly now: number;
  /** 窗口是否聚焦。 */
  readonly focused: boolean;
  /** 当前的真冲突。 */
  readonly conflicts: readonly Conflict[];
  /** 有未提交改动的对端。 */
  readonly peersWithChanges: readonly DeviceStatus[];
  /** 中继名，用于措辞。 */
  readonly relayName: string;
  /** 持续故障，恢复后为 null。 */
  readonly failure: FailureState | null;
}

/** 提醒的判断。 */
export class Alerts {
  /** 每个冲突文件上一次提示的时间；冲突消失后移除。 */
  private readonly notifiedConflicts = new Map<string, number>();
  private startupNotified = false;
  private failureNotifiedAt: number | null = null;
  private pendingRecovery = false;
  private wasFailing = false;

  constructor(private readonly settings: AlertSettings) {}

  /**
   * 给出本轮应当弹出的提示。
   *
   * 返回空数组表示什么都不弹：没有新情况，或窗口不在前台。
   */
  evaluate(input: AlertInput): Notice[] {
    this.trackFailure(input);

    if (!input.focused) {
      return [];
    }

    const notices: Notice[] = [];
    notices.push(...this.collectConflictNotices(input));
    notices.push(...this.collectStartupNotice(input));
    notices.push(...this.collectFailureNotice(input));
    notices.push(...this.collectRecoveryNotice(input));
    return notices;
  }

  /**
   * 冲突提示：首次出现即报；仍在冲突时按间隔重报，间隔为 0 则只报一次。
   *
   * 冲突消失后从表里移除，下次再出现仍算首次，免得把「已经提示过」带到新的冲突上。
   */
  private collectConflictNotices(input: AlertInput): Notice[] {
    const current = new Set(input.conflicts.map((conflict) => conflict.path));
    for (const path of [...this.notifiedConflicts.keys()]) {
      if (!current.has(path)) {
        this.notifiedConflicts.delete(path);
      }
    }

    const repeatMs = this.settings.conflictRepeatSeconds * 1000;
    const notices: Notice[] = [];
    for (const conflict of input.conflicts) {
      const last = this.notifiedConflicts.get(conflict.path);
      if (last === undefined) {
        this.notifiedConflicts.set(conflict.path, input.now);
        notices.push(conflictNotice(conflict, input.conflicts.length));
        continue;
      }
      if (repeatMs === 0 || input.now - last < repeatMs) {
        continue;
      }
      this.notifiedConflicts.set(conflict.path, input.now);
      notices.push(conflictNotice(conflict, input.conflicts.length));
    }
    return notices;
  }

  /** 启动后的对端改动：每次启动只提示一次，且只有在对端确实有改动时提示。 */
  private collectStartupNotice(input: AlertInput): Notice[] {
    if (this.startupNotified || input.peersWithChanges.length === 0) {
      return [];
    }

    this.startupNotified = true;
    return [startupNotice(input.peersWithChanges)];
  }

  /** 持续故障：按配置的间隔重提醒，间隔为 0 表示只在开始时提示一次。 */
  private collectFailureNotice(input: AlertInput): Notice[] {
    if (input.failure === null) {
      return [];
    }

    const repeatMs = this.settings.repeatSeconds * 1000;
    if (this.failureNotifiedAt !== null && (repeatMs === 0 || input.now - this.failureNotifiedAt < repeatMs)) {
      return [];
    }

    this.failureNotifiedAt = input.now;
    return [failureNotice(input.relayName, input.failure, input.now)];
  }

  /** 恢复：故障消失后提示一次，即使当时窗口不在前台，也要留到聚焦时再报。 */
  private collectRecoveryNotice(input: AlertInput): Notice[] {
    if (!this.pendingRecovery) {
      return [];
    }

    this.pendingRecovery = false;
    return [recoveredNotice(input.relayName)];
  }

  private trackFailure(input: AlertInput): void {
    if (input.failure !== null) {
      this.wasFailing = true;
      return;
    }

    if (this.wasFailing) {
      this.pendingRecovery = true;
      this.wasFailing = false;
      this.failureNotifiedAt = null;
    }
  }
}

/** 冲突提示的文字。假冲突的判定只影响措辞，因此这里据实说明，不隐瞒也不夸大。 */
export function conflictNotice(conflict: Conflict, total: number): Notice {
  const names = conflict.peers.map((peer) => peer.name).join(t("、"));
  const subject =
    total > 1
      ? t("「{path}」等 {count} 个文件", { path: conflict.path, count: total })
      : t("「{name}」", { name: conflict.path });
  const hint = conflictHint(conflict);

  return {
    kind: "conflict",
    title: t("可能冲突的改动"),
    body: t("{subject}在本地与{names}上都有未提交改动，提交或拉取之前请先确认。{hint}", {
      subject,
      names,
      hint,
    }),
  };
}

function conflictHint(conflict: Conflict): string {
  if (conflict.localSuspect) {
    return t("本地这边的差异仅在行尾或权限位。");
  }
  if (conflict.peerSuspect) {
    return t("对端那边的差异仅在行尾或权限位。");
  }
  return "";
}

/** 启动提示的文字。 */
export function startupNotice(peers: readonly DeviceStatus[]): Notice {
  const described = peers
    .map((peer) => t("{name}有 {count} 处未提交改动", { name: displayName(peer), count: peer.payload.count }))
    .join(t("；"));

  return {
    kind: "peerChanges",
    title: t("对端有未提交改动"),
    body: t("{described}，开始编辑之前请先留意。", { described }),
  };
}

/** 故障提示的文字。 */
export function failureNotice(relayName: string, failure: FailureState, now: number): Notice {
  const failureDuration = Math.max(0, Math.round((now - failure.since) / 1000));
  return {
    kind: "failure",
    title: t("中继不可达"),
    body: t("已持续 {duration}无法联系中继{relay}：{reason}", {
      duration: formatDuration(failureDuration),
      relay: t("「{name}」", { name: relayName }),
      reason: failure.message,
    }),
  };
}

/** 恢复提示的文字。 */
export function recoveredNotice(relayName: string): Notice {
  return {
    kind: "recovered",
    title: t("中继已恢复"),
    body: t("与中继{relay}的联系已恢复，本地状态将照常上报。", { relay: t("「{name}」", { name: relayName }) }),
  };
}

/** 把秒数写成中文里的时长说法。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return t("{seconds} 秒", { seconds });
  }
  if (seconds < 3600) {
    return t("{minutes} 分钟", { minutes: Math.floor(seconds / 60) });
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0
    ? t("{hours} 小时", { hours })
    : t("{hours} 小时 {minutes} 分钟", { hours, minutes });
}
