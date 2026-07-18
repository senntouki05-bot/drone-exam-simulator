/**
 * input/CalibrationWizard.ts — キャリブレーションウィザードのロジック（ヘッドレス・DOM非依存）。
 *
 * 「スロットルを上に」等の指示で軸番号・向き・端点・中立を実測し、宣言ボタンの割当と
 * デッドゾーン設定を経て GamepadCalibration を生成する。UI（ui/InputSetupUI.ts）は
 * 毎フレーム feed(生軸, ボタン) を呼び、step の指示文と進捗を表示するだけ。
 *
 * 手順（計11ステップ）:
 *   1. 中立記録（全軸の中立生値を confirmNeutral() でスナップショット）
 *   2-9. 4機能 ×（正方向→負方向）: 中立からの偏差が最大の未割当軸を候補にし、
 *        しきい値以上の倒し込みが holdFeeds 回連続したら端点として記録（保持中の最大偏差値を採用）
 *   10. 宣言ボタン割当（新規押下のエッジ検出・スキップ可）
 *   11. デッドゾーン調整 → finish()
 *
 * 誤検出対策:
 *  - 各機能の正方向検出は「未割当軸がすべて中立付近に戻る」まで武装しない（armed）。
 *    ただし割当済み軸は除外するので、スロットル（自己中立しない）が下がったままでも次へ進める。
 *  - 負方向は同じ軸の逆側偏差のみを見る（他の軸に触れても誤記録しない）。
 */

import {
  AXIS_FUNCTIONS,
  CALIBRATION_VERSION,
  DEFAULT_DEADZONE,
  type AxisCalibration,
  type AxisFunction,
  type GamepadCalibration,
  type StickMode,
} from './calibration';

export type WizardStepKind =
  | 'neutral'
  | 'axis-positive'
  | 'axis-negative'
  | 'declare-button'
  | 'deadzone'
  | 'done';

export interface WizardStepView {
  kind: WizardStepKind;
  /** 軸ステップ中の対象機能（それ以外はnull） */
  func: AxisFunction | null;
  /** 画面に出す指示文 */
  prompt: string;
  /** 1始まりのステップ番号 */
  stepIndex: number;
  stepCount: number;
  /** 端点キャプチャの保持進捗 0〜1（UIのバー表示用） */
  holdProgress: number;
  /** 直近の記録フィードバック（「軸2を記録しました」等） */
  message: string | null;
}

export interface WizardOptions {
  gamepadId: string;
  mode?: StickMode;
  /** 端点キャプチャに必要な連続検出フィード数（既定45≒60fpsで0.75秒） */
  holdFeeds?: number;
  /** 端点検出のしきい値（中立からの生値偏差。Gamepad APIの軸は-1〜1） */
  deflectionThreshold?: number;
  /** 「中立に戻った」とみなすしきい値 */
  neutralThreshold?: number;
}

const FUNC_LABEL: Record<AxisFunction, string> = {
  throttle: 'スロットル',
  rudder: 'ラダー',
  elevator: 'エレベーター',
  aileron: 'エルロン',
};

const FUNC_DIR: Record<AxisFunction, { pos: string; neg: string }> = {
  throttle: { pos: '上（上昇側）', neg: '下（下降側）' },
  rudder: { pos: '右', neg: '左' },
  elevator: { pos: '上（前進側）', neg: '下（後退側）' },
  aileron: { pos: '右', neg: '左' },
};

const STEP_COUNT = 11; // 中立1 + 4機能×2 + 宣言ボタン1 + デッドゾーン1

export class CalibrationWizard {
  private readonly gamepadId: string;
  private readonly mode: StickMode;
  private readonly holdFeeds: number;
  private readonly deflT: number;
  private readonly neutT: number;

  private phase: WizardStepKind = 'neutral';
  private funcIdx = 0;
  private centers: number[] = [];
  private readonly lastAxes: number[] = [];
  private readonly prevButtons: boolean[] = [];
  private readonly assigned = new Map<AxisFunction, AxisCalibration>();
  /** axis-negative待ちの割当（正方向端点まで記録済み） */
  private pending: { axisIndex: number; center: number; positive: number } | null = null;

  private armed = false;
  private candidate = -1;
  private holdCount = 0;
  private extremeRaw = 0;
  private deadzoneValue = DEFAULT_DEADZONE;
  private declareButtonIndex: number | null = null;
  private message: string | null = null;
  private resultCalib: GamepadCalibration | null = null;

  constructor(opts: WizardOptions) {
    this.gamepadId = opts.gamepadId;
    this.mode = opts.mode ?? 2;
    this.holdFeeds = opts.holdFeeds ?? 45;
    this.deflT = opts.deflectionThreshold ?? 0.45;
    this.neutT = opts.neutralThreshold ?? 0.25;
  }

  /** 毎フレーム、現在の生軸とボタン押下状態を流し込む */
  feed(rawAxes: readonly number[], buttons: readonly boolean[] = []): void {
    this.lastAxes.length = rawAxes.length;
    for (let i = 0; i < rawAxes.length; i++) this.lastAxes[i] = rawAxes[i] ?? 0;

    switch (this.phase) {
      case 'axis-positive':
        this.feedAxisPositive();
        break;
      case 'axis-negative':
        this.feedAxisNegative();
        break;
      case 'declare-button':
        this.feedDeclareButton(buttons);
        break;
      default:
        break;
    }

    // ボタンのエッジ検出用に前回値を更新（全フェーズ共通）
    this.prevButtons.length = buttons.length;
    for (let i = 0; i < buttons.length; i++) this.prevButtons[i] = buttons[i] ?? false;
  }

  /** 中立ステップの確定（UIの「中立を記録」ボタン）。軸が1つも読めていなければfalse */
  confirmNeutral(): boolean {
    if (this.phase !== 'neutral' || this.lastAxes.length === 0) return false;
    this.centers = this.lastAxes.slice();
    this.armed = true; // 直前に中立を確認済みなので検出を即有効化
    this.phase = 'axis-positive';
    this.message = '中立位置を記録しました';
    return true;
  }

  /** 宣言ボタン割当のスキップ（Spaceキーのみ使用） */
  skipDeclare(): void {
    if (this.phase !== 'declare-button') return;
    this.declareButtonIndex = null;
    this.message = '宣言ボタンは未割当（Spaceキーで宣言します）';
    this.phase = 'deadzone';
  }

  setDeadzone(v: number): void {
    this.deadzoneValue = Math.min(0.5, Math.max(0, v));
  }

  get deadzone(): number {
    return this.deadzoneValue;
  }

  /** デッドゾーン調整ステップで確定し、キャリブレーションを返す（それ以外の状態ではnull） */
  finish(): GamepadCalibration | null {
    if (this.phase !== 'deadzone') return null;
    const axes = {} as Record<AxisFunction, AxisCalibration>;
    for (const f of AXIS_FUNCTIONS) {
      const a = this.assigned.get(f);
      if (!a) return null;
      axes[f] = a;
    }
    this.resultCalib = {
      version: CALIBRATION_VERSION,
      gamepadId: this.gamepadId,
      mode: this.mode,
      deadzone: this.deadzoneValue,
      axes,
      declareButtonIndex: this.declareButtonIndex,
    };
    this.phase = 'done';
    return this.resultCalib;
  }

  get result(): GamepadCalibration | null {
    return this.resultCalib;
  }

  get step(): WizardStepView {
    const func =
      this.phase === 'axis-positive' || this.phase === 'axis-negative'
        ? this.currentFunc()
        : null;
    return {
      kind: this.phase,
      func,
      prompt: this.prompt(func),
      stepIndex: this.stepIndex(),
      stepCount: STEP_COUNT,
      holdProgress: Math.min(1, this.holdCount / this.holdFeeds),
      message: this.message,
    };
  }

  // --- 内部 ---

  private prompt(func: AxisFunction | null): string {
    switch (this.phase) {
      case 'neutral':
        return 'すべてのスティックを中立位置に合わせてください（スロットルスティックは中央）。合わせたら「中立を記録」を押してください';
      case 'axis-positive':
        return `${FUNC_LABEL[func!]}を${FUNC_DIR[func!].pos}いっぱいに倒し、そのまま保持してください`;
      case 'axis-negative':
        return `${FUNC_LABEL[func!]}を${FUNC_DIR[func!].neg}いっぱいに倒し、そのまま保持してください`;
      case 'declare-button':
        return '安全確認の宣言に使うプロポのボタンを押してください（スキップするとSpaceキーのみになります）';
      case 'deadzone':
        return 'デッドゾーン（中立付近の遊び）を調整し、「完了」を押してください';
      case 'done':
        return 'キャリブレーション完了';
    }
  }

  private stepIndex(): number {
    switch (this.phase) {
      case 'neutral':
        return 1;
      case 'axis-positive':
        return 2 + this.funcIdx * 2;
      case 'axis-negative':
        return 3 + this.funcIdx * 2;
      case 'declare-button':
        return 10;
      case 'deadzone':
      case 'done':
        return 11;
    }
  }

  private feedAxisPositive(): void {
    if (!this.armed) {
      if (this.allUnassignedNearCenter()) this.armed = true;
      return;
    }
    // 未割当軸のうち中立からの偏差が最大の軸を候補にする
    let best = -1;
    let bestAbs = 0;
    for (let i = 0; i < this.lastAxes.length; i++) {
      if (this.isAxisAssigned(i)) continue;
      const d = Math.abs(this.lastAxes[i]! - this.centerOf(i));
      if (d > bestAbs) {
        bestAbs = d;
        best = i;
      }
    }
    if (best < 0 || bestAbs < this.deflT) {
      this.candidate = -1;
      this.holdCount = 0;
      return;
    }
    if (best !== this.candidate) {
      this.candidate = best;
      this.holdCount = 0;
      this.extremeRaw = this.lastAxes[best]!;
    }
    this.holdCount++;
    this.trackExtreme(best, this.centerOf(best));
    if (this.holdCount >= this.holdFeeds) {
      const func = this.currentFunc()!;
      this.pending = {
        axisIndex: best,
        center: this.centerOf(best),
        positive: this.extremeRaw,
      };
      this.message = `${FUNC_LABEL[func]}: 軸${best}を記録しました。次は逆方向です`;
      this.phase = 'axis-negative';
      this.candidate = -1;
      this.holdCount = 0;
    }
  }

  private feedAxisNegative(): void {
    const p = this.pending!;
    const raw = this.lastAxes[p.axisIndex] ?? p.center;
    const d = raw - p.center;
    const posDelta = p.positive - p.center;
    const opposite = (d > 0) !== (posDelta > 0);
    if (!opposite || Math.abs(d) < this.deflT) {
      this.holdCount = 0;
      return;
    }
    if (this.holdCount === 0) this.extremeRaw = raw;
    this.holdCount++;
    this.trackExtreme(p.axisIndex, p.center);
    if (this.holdCount >= this.holdFeeds) {
      const func = this.currentFunc()!;
      this.assigned.set(func, {
        axisIndex: p.axisIndex,
        center: p.center,
        positive: p.positive,
        negative: this.extremeRaw,
      });
      this.message = `${FUNC_LABEL[func]}: 割当完了（軸${p.axisIndex}）`;
      this.pending = null;
      this.holdCount = 0;
      this.candidate = -1;
      this.armed = false; // 次の機能は中立復帰（未割当軸のみ）を待ってから検出
      this.funcIdx++;
      this.phase = this.funcIdx < AXIS_FUNCTIONS.length ? 'axis-positive' : 'declare-button';
    }
  }

  private feedDeclareButton(buttons: readonly boolean[]): void {
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i] && !this.prevButtons[i]) {
        this.declareButtonIndex = i;
        this.message = `ボタン${i}を宣言キーに割り当てました`;
        this.phase = 'deadzone';
        return;
      }
    }
  }

  /** 保持中、中立からの偏差が最大の生値を端点として更新する */
  private trackExtreme(axisIndex: number, center: number): void {
    const raw = this.lastAxes[axisIndex]!;
    if (Math.abs(raw - center) > Math.abs(this.extremeRaw - center)) {
      this.extremeRaw = raw;
    }
  }

  private allUnassignedNearCenter(): boolean {
    if (this.lastAxes.length === 0) return false;
    for (let i = 0; i < this.lastAxes.length; i++) {
      if (this.isAxisAssigned(i)) continue;
      if (Math.abs(this.lastAxes[i]! - this.centerOf(i)) > this.neutT) return false;
    }
    return true;
  }

  private isAxisAssigned(axisIndex: number): boolean {
    if (this.pending?.axisIndex === axisIndex) return true;
    for (const a of this.assigned.values()) {
      if (a.axisIndex === axisIndex) return true;
    }
    return false;
  }

  private centerOf(axisIndex: number): number {
    return this.centers[axisIndex] ?? 0;
  }

  private currentFunc(): AxisFunction | null {
    return AXIS_FUNCTIONS[this.funcIdx] ?? null;
  }
}
