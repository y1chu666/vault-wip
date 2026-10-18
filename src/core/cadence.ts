// 本模块决定什么时候采集与上报。
//
// 定时采集保证长时间不动也有信号；启动完成、切换文件、保存与窗口重新聚焦
// 都立即上报一次，但两秒之内只发一次，免得连续保存若干个文件就发出一串请求。
// 窗口失焦超过一定时间后放慢定时采集，闲着的时候不必频繁打扰中继。

/** 集中上报的防抖窗口（毫秒）。 */
export const DEBOUNCE_MS = 2000;

/** 触发上报的时机。`timer` 由定时器按节奏触发，不受防抖限制。 */
export type Trigger = "startup" | "fileSwitch" | "save" | "focus";

/** 节奏配置。 */
export interface CadenceSettings {
  /** 常规定时采集间隔（秒）。 */
  readonly intervalSeconds: number;
  /** 失焦超过该秒数后改用放慢的间隔，0 表示不放慢。 */
  readonly idleAfterSeconds: number;
  /** 放慢后的间隔（秒）。 */
  readonly idleIntervalSeconds: number;
}

/** 取当前时刻的方式，留成参数是为了让用例不必等待真实时间。 */
export type Clock = () => number;

/** 上报节奏。 */
export class Cadence {
  private focused = true;
  private blurredAt: number | null = null;
  private lastImmediateAt: number | null = null;

  constructor(
    private readonly settings: CadenceSettings,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * 记录窗口聚焦状态。
   *
   * 失焦时刻只在首次转入失焦时记录：反复收到失焦通知时若不断刷新，
   * 放慢采集就永远不会生效。
   */
  setFocused(focused: boolean): void {
    if (focused) {
      this.focused = true;
      this.blurredAt = null;
      return;
    }

    this.focused = false;
    if (this.blurredAt === null) {
      this.blurredAt = this.clock();
    }
  }

  /** 窗口是否已失焦到应当放慢采集。 */
  isIdle(): boolean {
    if (this.focused || this.settings.idleAfterSeconds === 0 || this.blurredAt === null) {
      return false;
    }
    return this.clock() - this.blurredAt >= this.settings.idleAfterSeconds * 1000;
  }

  /** 定时器下一次应当间隔多少秒。 */
  timerSeconds(): number {
    return this.isIdle() ? this.settings.idleIntervalSeconds : this.settings.intervalSeconds;
  }

  /**
   * 判断一次立即触发是否真的应当上报。
   *
   * 启动必须上报一次，否则刚打开仓库时界面上什么都没有；其余时机在防抖窗口内合并。
   */
  shouldReportNow(trigger: Trigger): boolean {
    const now = this.clock();
    if (trigger === "startup") {
      this.lastImmediateAt = now;
      return true;
    }

    if (this.lastImmediateAt !== null && now - this.lastImmediateAt < DEBOUNCE_MS) {
      return false;
    }

    this.lastImmediateAt = now;
    return true;
  }
}
