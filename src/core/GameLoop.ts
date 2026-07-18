/**
 * core/GameLoop.ts — 固定Δt（既定240Hz）＋描画補間のゲームループ（Gaffer on Games方式）。
 *
 * - rAFのフレームΔtは MAX_FRAME_DT=0.25s でキャップする（実装原則6）。
 * - タブ非表示（visibilitychange=hidden）で自動ポーズ。復帰はUI側の再開ダイアログ
 *   （onAutoPauseコールバック→ユーザー操作→resume()）に委ね、visible復帰だけでは再開しない。
 * - 制限時間・タイマー類の基準となるシム時間（simTime）は固定Δtの積算のみで進む（実時計不使用）。
 * - rAF・visibilitychange購読先はコンストラクタ注入可能で、node環境のVitestから
 *   frame(nowMs) を直接呼んでヘッドレスにテストできる。
 */

/** 物理の固定タイムステップ [s]（240Hz） */
export const FIXED_DT = 1 / 240;

/** 1フレームの実Δtの上限 [s]（スパイラル・オブ・デス防止） */
export const MAX_FRAME_DT = 0.25;

/** visibilitychange の購読先（本番=document・テスト=偽オブジェクト） */
export interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface GameLoopOptions {
  /** 物理1ステップ。dtは常に固定Δt。tSimはこのステップ開始時点のシム時間 [s] */
  update: (dt: number, tSim: number) => void;
  /** 描画。alpha=前回ステップ→今回ステップの補間係数 [0,1) */
  render?: (alpha: number) => void;
  /** 固定Δt [s]。既定 FIXED_DT */
  fixedDt?: number;
  /** フレームΔtキャップ [s]。既定 MAX_FRAME_DT */
  maxFrameDt?: number;
  /** タブ非表示による自動ポーズが発生したとき（UIが再開ダイアログを出す） */
  onAutoPause?: () => void;
  /** rAF注入（省略時はグローバルrequestAnimationFrame。無い環境ではstart()しても駆動されない） */
  raf?: (cb: (nowMs: number) => void) => number;
  cancelRaf?: (id: number) => void;
  /** visibilitychange購読先の注入（省略時はグローバルdocument・nullで購読しない） */
  visibilityTarget?: VisibilityTarget | null;
}

export class GameLoop {
  private readonly fixedDt: number;
  private readonly maxFrameDt: number;
  private readonly updateFn: (dt: number, tSim: number) => void;
  private readonly renderFn: ((alpha: number) => void) | undefined;
  private readonly onAutoPause: (() => void) | undefined;
  private readonly raf: ((cb: (nowMs: number) => void) => number) | undefined;
  private readonly cancelRaf: ((id: number) => void) | undefined;
  private readonly visibilityTarget: VisibilityTarget | null;
  private visibilityListener: (() => void) | null = null;

  private accumulator = 0;
  private simTimeS = 0;
  private lastNowMs: number | null = null;
  private rafId: number | null = null;
  private running = false;
  private paused = false;

  constructor(opts: GameLoopOptions) {
    this.fixedDt = opts.fixedDt ?? FIXED_DT;
    this.maxFrameDt = opts.maxFrameDt ?? MAX_FRAME_DT;
    this.updateFn = opts.update;
    this.renderFn = opts.render;
    this.onAutoPause = opts.onAutoPause;
    this.raf =
      opts.raf ??
      (typeof requestAnimationFrame !== 'undefined'
        ? (cb) => requestAnimationFrame(cb)
        : undefined);
    this.cancelRaf =
      opts.cancelRaf ??
      (typeof cancelAnimationFrame !== 'undefined'
        ? (id) => cancelAnimationFrame(id)
        : undefined);
    this.visibilityTarget =
      opts.visibilityTarget !== undefined
        ? opts.visibilityTarget
        : typeof document !== 'undefined'
          ? document
          : null;
  }

  /** シム時間 [s]（固定Δtの積算のみで進む） */
  get simTime(): number {
    return this.simTimeS;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastNowMs = null;
    this.bindVisibility();
    this.scheduleFrame();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafId !== null) {
      this.cancelRaf?.(this.rafId);
      this.rafId = null;
    }
    this.unbindVisibility();
  }

  pause(): void {
    this.paused = true;
  }

  /** 再開。直前の実時間経過をキャッチアップしない（次フレームで基準時刻を取り直す） */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.lastNowMs = null;
  }

  /**
   * 1フレーム分を処理する。rAF駆動時も内部でこれを呼ぶ（テストからは直接呼ぶ）。
   * - フレームΔtは maxFrameDt でキャップ
   * - アキュムレータから固定Δtを取り出せるだけ update を回し、残余で render(alpha)
   */
  frame(nowMs: number): void {
    if (this.paused) {
      // ポーズ中は時間を消費しない。基準時刻も破棄し、再開後の巨大Δtを防ぐ。
      this.lastNowMs = null;
      return;
    }
    if (this.lastNowMs === null) {
      // 基準時刻の確立のみ（開始直後・再開直後）。物理は進めず現状態で描画だけする。
      this.lastNowMs = nowMs;
      this.renderFn?.(this.accumulator / this.fixedDt);
      return;
    }
    let frameDt = (nowMs - this.lastNowMs) / 1000;
    this.lastNowMs = nowMs;
    if (!Number.isFinite(frameDt) || frameDt < 0) frameDt = 0;
    if (frameDt > this.maxFrameDt) frameDt = this.maxFrameDt;

    this.accumulator += frameDt;
    while (this.accumulator >= this.fixedDt) {
      this.updateFn(this.fixedDt, this.simTimeS);
      this.simTimeS += this.fixedDt;
      this.accumulator -= this.fixedDt;
    }
    this.renderFn?.(this.accumulator / this.fixedDt);
  }

  private scheduleFrame(): void {
    if (!this.raf) return;
    this.rafId = this.raf((nowMs) => {
      if (!this.running) return;
      this.frame(nowMs);
      this.scheduleFrame();
    });
  }

  private bindVisibility(): void {
    const target = this.visibilityTarget;
    if (!target || this.visibilityListener) return;
    this.visibilityListener = () => {
      if (target.visibilityState === 'hidden' && this.running && !this.paused) {
        this.pause();
        this.onAutoPause?.();
      }
      // visible復帰では自動再開しない（UIの再開ダイアログ→resume()を待つ）
    };
    target.addEventListener('visibilitychange', this.visibilityListener);
  }

  private unbindVisibility(): void {
    if (this.visibilityTarget && this.visibilityListener) {
      this.visibilityTarget.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }
}
