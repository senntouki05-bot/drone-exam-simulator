/**
 * exam/ExamSeries.ts — 試験モード3課目通し（4-1→4-2→4-3）のヘッドレス進行管理。
 *
 * 実装原則3: DOM・WebGL・Audio系APIを一切importしない純粋モジュール。
 * 共通ルール「持ち点100点は3課目を通じて単一」を、各課目のExamSessionへ startPoints で
 * 直前課目の持ち点を引き継ぐことで実現する。各課目終了時に70点以上を維持していれば
 * 次課目へ、即不合格・持ち点割れが発生したら実試験どおり試験終了
 * （continueOnFail=true なら「続行して練習」も可）。
 *
 * 課目間の機体H再配置は統合側（main）の仕事: 本クラスは awaitingNext=「課目完了→
 * 次課目のstart()待ち」の状態を持つだけで、機体位置には関与しない。
 *
 * 練習続行時の持ち点（continueOnFail=true で不合格後も続行する場合）:
 *   次課目の startPoints = max(直近結果points, config.pass.passPoints)。
 *   理由: 70点未満のまま次課目を始めると開始直後に points_exhausted となり開始不能に
 *   なるため、採点体験維持の便宜として70点床で再開する。総合の passed 判定は
 *   false のまま（この床上げは合否に影響しない）。
 */

import type { Course } from './Course';
import { DEDUCTIONS, type DeductionsConfig } from './DeductionsConfig';
import {
  ExamSession,
  type ActiveInstruction,
  type ExamDirection,
  type ExamEvent,
  type ExamResult,
  type ExamSample,
} from './ExamSession';
import type { DeductionEvent, ExamWarning } from './ScoringEngine';

export interface ExamSeriesResult {
  /** 全課目completed かつ 全result.passed */
  passed: boolean;
  /** 最終持ち点 */
  points: number;
  /** 課目ごとの結果（実施分のみ） */
  results: ExamResult[];
  /** 最後の課目まで行かずに終了したか */
  endedEarly: boolean;
}

export interface ExamSeriesOptions {
  /** 通し順の課目列（試験モード=COURSES: 4-1→4-2→4-3） */
  courses: readonly Course[];
  /** 機体半径 [m]（パイロン衝突判定用・MachineProfile.radiusM） */
  machineRadiusM: number;
  config?: DeductionsConfig;
  /** 注入乱数 [0,1)（各課目のExamSessionへそのまま渡す） */
  random?: () => number;
  /** 各課目のExamSessionへそのまま渡す（既定'random'） */
  direction?: ExamDirection;
  /** 既定false=実試験どおり即終了。trueで不合格後も練習として続行 */
  continueOnFail?: boolean;
  onInstruction?: (i: ActiveInstruction) => void;
  onWarning?: (w: ExamWarning) => void;
  onDeduction?: (d: DeductionEvent) => void;
  onCourseFinished?: (r: ExamResult, courseIndex: number) => void;
  onSeriesFinished?: (r: ExamSeriesResult) => void;
}

export class ExamSeries {
  private readonly opts: ExamSeriesOptions;
  private readonly cfg: DeductionsConfig;

  /** 実施済み課目の結果（時系列順） */
  readonly results: ExamResult[] = [];

  private idx = 0;
  private current: ExamSession | null = null;
  private awaiting = false;
  private done = false;

  result: ExamSeriesResult | null = null;

  /** 自動開始しない（start()を待つ）。課目列が空の定義ミスは即座に失敗させる */
  constructor(opts: ExamSeriesOptions) {
    if (opts.courses.length === 0) throw new Error('ExamSeries: courses が空');
    this.opts = opts;
    this.cfg = opts.config ?? DEDUCTIONS;
  }

  /** 現在（次に開始する）課目のindex */
  get courseIndex(): number {
    return this.idx;
  }

  get course(): Course {
    return this.opts.courses[this.idx];
  }

  /** 進行中の課目セッション（課目間・終了後はnull） */
  get session(): ExamSession | null {
    return this.current;
  }

  /** 現在の持ち点（進行中はsession.points、課目間・終了後は直近結果） */
  get points(): number {
    if (this.current !== null) return this.current.points;
    if (this.results.length > 0) return this.results[this.results.length - 1].points;
    return this.cfg.pass.startPoints;
  }

  get finished(): boolean {
    return this.done;
  }

  /** 課目完了→次課目start()待ち（機体のH再配置待ち。再配置は統合側の仕事） */
  get awaitingNext(): boolean {
    return this.awaiting;
  }

  /** 最初/次の課目を開始する（未開始 or awaitingNext時のみ。それ以外はthrow） */
  start(): ExamSession {
    const canStart =
      !this.done && this.current === null && (this.awaiting || this.results.length === 0);
    if (!canStart) {
      throw new Error('ExamSeries.start(): 未開始または awaitingNext のときのみ開始できる');
    }
    const session = new ExamSession({
      course: this.opts.courses[this.idx],
      machineRadiusM: this.opts.machineRadiusM,
      config: this.cfg,
      random: this.opts.random,
      direction: this.opts.direction,
      startPoints: this.nextStartPoints(),
      onInstruction: this.opts.onInstruction,
      onWarning: this.opts.onWarning,
      onDeduction: this.opts.onDeduction,
      onFinished: (r) => this.handleCourseFinished(r),
    });
    this.awaiting = false;
    this.current = session;
    return session;
  }

  /** 進行中セッションへ委譲する（なければ何もしない） */
  step(tSim: number, sample: ExamSample, events: readonly ExamEvent[]): void {
    this.current?.step(tSim, sample, events);
  }

  /** 進行中セッションをabort→シリーズ終了（endedEarly）。UIの中止操作用 */
  abort(): void {
    if (this.done) return;
    if (this.current !== null) {
      // session.abort() → onFinished → handleCourseFinished が endedEarly で確定させる
      this.current.abort();
    } else {
      this.finalize(true);
    }
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  /** 次課目の開始持ち点（ヘッダコメント「練習続行時の持ち点」参照） */
  private nextStartPoints(): number {
    if (this.results.length === 0) return this.cfg.pass.startPoints;
    const last = this.results[this.results.length - 1];
    if (last.endReason === 'completed') return last.points; // 通常の持ち越し（≥70が保証される）
    return Math.max(last.points, this.cfg.pass.passPoints); // 練習続行の70点床
  }

  private handleCourseFinished(r: ExamResult): void {
    const courseIdx = this.idx;
    this.current = null;
    this.results.push(r);
    this.opts.onCourseFinished?.(r, courseIdx);

    const hasNext = courseIdx + 1 < this.opts.courses.length;
    if (r.endReason === 'completed') {
      if (hasNext) {
        this.idx = courseIdx + 1;
        this.awaiting = true; // 機体H再配置→start()待ち
      } else {
        this.finalize(false); // 最終課目まで完走
      }
      return;
    }
    // completed以外（immediate_fail / points_exhausted / aborted）
    if (r.endReason !== 'aborted' && this.opts.continueOnFail === true) {
      if (hasNext) {
        this.idx = courseIdx + 1;
        this.awaiting = true; // 練習続行（持ち点は次回start()で70点床）
        return;
      }
      // 最終課目での不合格: 全課目を実施済みなので endedEarly=false
      this.finalize(false);
      return;
    }
    // 実試験どおり即終了（abortedは設定によらず終了）
    this.finalize(true);
  }

  private finalize(endedEarly: boolean): void {
    if (this.done) return;
    this.done = true;
    this.awaiting = false;
    const passed =
      this.results.length === this.opts.courses.length && this.results.every((r) => r.passed);
    this.result = {
      passed,
      points:
        this.results.length > 0
          ? this.results[this.results.length - 1].points
          : this.cfg.pass.startPoints,
      results: this.results.slice(),
      endedEarly,
    };
    this.opts.onSeriesFinished?.(this.result);
  }
}
