/**
 * input/GamepadManager.ts — Gamepad APIの検出・ポーリング・キャリブレーション適用。
 *
 * 検出は「rAF駆動のフレーム内での毎回ポーリング」＋「gamepadconnected/disconnectedイベント」の併用。
 * Chromeはユーザーのボタン押下があるまでgetGamepads()にデバイスを出さないことがある
 * （軸操作だけでは不可のケースあり）。接続画面の導線文言は ui/InputSetupUI.ts の CONNECT_GUIDE_TEXT。
 *
 * navigator.getGamepads・イベント購読先・Storage はコンストラクタ注入可能で、
 * Vitest(node環境)からモックでユニットテストできる（GamepadManager.test.ts）。
 * 接続を検出したら gamepad.id をキーに保存済みキャリブレーションを自動復元する。
 *
 * 実機確認手順（M1の人間の受入項目。README編集は禁止のためここに記す）:
 *  1. Chrome(macOS)で `npm run dev` → 表示URLを開く（入力デバッグ画面は `?input=debug` を付与）
 *  2. プロポをUSB接続（EdgeTX機は接続時のダイアログで「USB Joystick (HID)」を選択）。
 *     またはゲームパッド（Xbox等）を接続。DJI純正送信機は非対応
 *  3. 画面右上パネルの案内どおり、スイッチを操作するか任意のボタンを押す → 機器名が表示されること
 *  4. 「キャリブレーション開始」→ ウィザードの指示で4軸＋宣言ボタンを登録 → 完了
 *  5. `?input=debug` で各生軸の値が動き、正規化4軸が期待方向（スロットル上=+1等）に振れること
 *  6. ページ再読込→スイッチ/ボタンで再認識 → 保存済み設定が自動復元されること（再ウィザード不要）
 *  7. モード1/モード2切替でスロットルとエレベーターの割当が入れ替わること
 *  8. 未接続時はキーボード（W/S=スロットル・A/D=ラダー・↑↓=エレベーター・←→=エルロン・
 *     Space=宣言）で操縦できること
 */

import type { ControlInput } from '../sim/FlightModel';
import type { InputSource } from './InputSource';
import {
  applyCalibration,
  standardGamepadCalibration,
  withMode,
  type GamepadCalibration,
  type StickMode,
} from './calibration';
import { loadCalibration, saveCalibration, type StorageLike } from './CalibrationStore';

/** Gamepad互換の最小構造（テストではこれを満たす素のオブジェクトをモック注入する） */
export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: ReadonlyArray<{ readonly pressed: boolean }>;
}

export type GetGamepads = () => ReadonlyArray<GamepadLike | null>;

/** gamepadconnected/disconnectedの購読先（本番=window・テスト=偽オブジェクト） */
export interface GamepadEventTargetLike {
  addEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void;
  removeEventListener(
    type: 'gamepadconnected' | 'gamepaddisconnected',
    listener: () => void,
  ): void;
}

export interface GamepadManagerOptions {
  /** 省略時は navigator.getGamepads（無い環境では常に空） */
  getGamepads?: GetGamepads;
  /** 省略時は window。nullでイベント購読なし（ポーリングのみ） */
  eventTarget?: GamepadEventTargetLike | null;
  /** 省略時は localStorage。nullで永続化なし */
  storage?: StorageLike | null;
}

export type ConnectionListener = (connected: boolean, gamepadId: string | null) => void;

export class GamepadManager implements InputSource {
  private readonly getGamepads: GetGamepads;
  private readonly eventTarget: GamepadEventTargetLike | null;
  private readonly storage: StorageLike | null;
  private readonly listeners = new Set<ConnectionListener>();
  private readonly onGamepadEvent = (): void => this.poll();

  private connectedFlag = false;
  private idInternal: string | null = null;
  private mappingInternal: string | null = null;
  private calib: GamepadCalibration | null = null;
  private readonly axesBuf: number[] = [];
  private readonly buttonsBuf: boolean[] = [];

  constructor(opts: GamepadManagerOptions = {}) {
    this.getGamepads =
      opts.getGamepads ??
      (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? () => navigator.getGamepads()
        : () => []);
    this.eventTarget =
      opts.eventTarget !== undefined
        ? opts.eventTarget
        : typeof window !== 'undefined'
          ? window
          : null;
    this.storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof localStorage !== 'undefined'
          ? localStorage
          : null;
    this.eventTarget?.addEventListener('gamepadconnected', this.onGamepadEvent);
    this.eventTarget?.addEventListener('gamepaddisconnected', this.onGamepadEvent);
  }

  dispose(): void {
    this.eventTarget?.removeEventListener('gamepadconnected', this.onGamepadEvent);
    this.eventTarget?.removeEventListener('gamepaddisconnected', this.onGamepadEvent);
    this.listeners.clear();
  }

  /**
   * 現在のゲームパッド状態を取り込む。rAF駆動のフレーム内（GameLoopのupdate）から毎回呼ぶ。
   * 接続/切断の検出・保存済みキャリブレーションの自動復元・生値バッファの更新を行う。
   */
  poll(): void {
    const pads = this.getGamepads();
    let active: GamepadLike | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        active = p;
        break;
      }
    }

    if (active) {
      const isNew = !this.connectedFlag || this.idInternal !== active.id;
      if (isNew) {
        this.connectedFlag = true;
        this.idInternal = active.id;
        this.mappingInternal = active.mapping;
        // 保存済みキャリブレーションの自動復元（gamepad.idごと）
        this.calib = this.storage ? loadCalibration(this.storage, active.id) : null;
        this.fireChange();
      }
      this.axesBuf.length = active.axes.length;
      for (let i = 0; i < active.axes.length; i++) this.axesBuf[i] = active.axes[i] ?? 0;
      this.buttonsBuf.length = active.buttons.length;
      for (let i = 0; i < active.buttons.length; i++) {
        this.buttonsBuf[i] = active.buttons[i]?.pressed ?? false;
      }
    } else if (this.connectedFlag) {
      this.connectedFlag = false;
      this.idInternal = null;
      this.mappingInternal = null;
      this.calib = null; // 次の接続時にstorageから復元する
      this.axesBuf.length = 0;
      this.buttonsBuf.length = 0;
      this.fireChange();
    }
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  get gamepadId(): string | null {
    return this.idInternal;
  }

  get mapping(): string | null {
    return this.mappingInternal;
  }

  /** 接続中かつキャリブレーション済み＝飛行入力として使える状態 */
  get ready(): boolean {
    return this.connectedFlag && this.calib !== null;
  }

  get calibration(): GamepadCalibration | null {
    return this.calib;
  }

  /** 直近poll時点の生軸（未接続時は空） */
  get rawAxes(): readonly number[] {
    return this.axesBuf;
  }

  /** 直近poll時点のボタン押下（未接続時は空） */
  get rawButtons(): readonly boolean[] {
    return this.buttonsBuf;
  }

  /** キャリブレーションを設定し永続化する（ウィザード完了・プリセット適用時） */
  saveCalibration(calib: GamepadCalibration): void {
    this.calib = calib;
    this.persist();
  }

  /** スティックモードのプリセット切替（throttle⇔elevator入替）。未キャリブレーション時は何もしない */
  setMode(mode: StickMode): void {
    if (!this.calib) return;
    this.calib = withMode(this.calib, mode);
    this.persist();
  }

  /** W3C標準マッピングのパッド向けプリセットを適用（mapping==='standard'のとき用） */
  applyStandardPreset(mode: StickMode): void {
    if (!this.idInternal) return;
    this.saveCalibration(standardGamepadCalibration(this.idInternal, mode));
  }

  /** 接続/切断のリスナ登録。戻り値で解除 */
  onConnectionChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- InputSource ---

  read(out: ControlInput): void {
    if (!this.connectedFlag || !this.calib) {
      out.aileron = 0;
      out.elevator = 0;
      out.throttle = 0;
      out.rudder = 0;
      return;
    }
    applyCalibration(this.axesBuf, this.calib, out);
  }

  get declarePressed(): boolean {
    const idx = this.calib?.declareButtonIndex;
    if (idx == null || !this.connectedFlag) return false;
    return this.buttonsBuf[idx] === true;
  }

  // --- 内部 ---

  private persist(): void {
    if (!this.storage || !this.calib) return;
    try {
      saveCalibration(this.storage, this.calib);
    } catch {
      // 容量超過・プライベートモード等では永続化のみ諦める（メモリ上の設定は有効）
    }
  }

  private fireChange(): void {
    for (const l of this.listeners) l(this.connectedFlag, this.idInternal);
  }
}
