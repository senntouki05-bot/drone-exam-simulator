/**
 * input/calibration.ts — キャリブレーションの型と純関数（DOM・Gamepad API非依存）。
 *
 * - AxisCalibration: 機能（スロットル等）ごとに「どの軸番号を」「中立・正方向端点・
 *   負方向端点の生値つきで」使うか。端点の生値をそのまま持つことで、反転軸
 *   （上に倒すと負になる等）・中立が0でない軸・可動域が非対称な軸を同じ式で正規化できる。
 * - GamepadCalibration: 4機能の軸割当＋宣言ボタン＋デッドゾーン＋スティックモード。
 *   localStorage保存の形式そのもの（CalibrationStore.ts参照）。
 * - モード1/モード2: どちらもラダー=左スティック水平・エルロン=右スティック水平で共通。
 *   違いは垂直軸だけ（モード2: スロットル=左/エレベーター=右、モード1: その逆）。
 *   したがってプリセット切替は throttle と elevator の軸割当を入れ替えるだけでよい（withMode）。
 */

import type { ControlInput } from '../sim/FlightModel';

export type AxisFunction = 'throttle' | 'rudder' | 'elevator' | 'aileron';
export type StickMode = 1 | 2;

export const AXIS_FUNCTIONS: readonly AxisFunction[] = [
  'throttle',
  'rudder',
  'elevator',
  'aileron',
];

export const CALIBRATION_VERSION = 1;

/** デッドゾーン既定値（正規化後の中立付近をこの幅だけ0に落とす） */
export const DEFAULT_DEADZONE = 0.05;

export interface AxisCalibration {
  /** Gamepad.axes のインデックス */
  axisIndex: number;
  /** スティック中立時の生値 */
  center: number;
  /** 機能の正方向（スロットル上・ラダー右・エレベーター前・エルロン右）いっぱいの生値 */
  positive: number;
  /** 機能の負方向いっぱいの生値 */
  negative: number;
}

export interface GamepadCalibration {
  version: typeof CALIBRATION_VERSION;
  /** Gamepad.id（この単位でlocalStorageに保存する） */
  gamepadId: string;
  mode: StickMode;
  /** 正規化後値に適用するデッドゾーン [0,1) */
  deadzone: number;
  axes: Record<AxisFunction, AxisCalibration>;
  /** 安全確認宣言に使うボタン番号（null=未割当・Spaceキーのみ） */
  declareButtonIndex: number | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 生値→正規化値（-1〜+1）。
 * 中立から正方向端点側の偏差は 0→+1、負方向端点側は 0→-1 に線形マップし、端点超えはクランプ。
 * デッドゾーンは正規化後に適用し、|v|≤dz を0、残り(dz→1)を(0→1)へ再スケール（端点±1は維持）。
 */
export function normalizeAxis(raw: number, cal: AxisCalibration, deadzone: number): number {
  const dPos = cal.positive - cal.center;
  const dNeg = cal.negative - cal.center;
  const d = raw - cal.center;
  let v = 0;
  if (d !== 0) {
    if (dPos !== 0 && (d > 0) === (dPos > 0)) {
      v = d / dPos;
    } else if (dNeg !== 0 && (d > 0) === (dNeg > 0)) {
      v = -(d / dNeg);
    }
  }
  v = clamp(v, -1, 1);
  const dz = clamp(deadzone, 0, 0.9);
  const abs = Math.abs(v);
  if (abs <= dz) return 0;
  const scaled = (abs - dz) / (1 - dz);
  return v > 0 ? scaled : -scaled;
}

/** キャリブレーションを生軸配列へ適用し、正規化4軸をoutへ書き込む（アロケーションしない） */
export function applyCalibration(
  rawAxes: readonly number[],
  calib: GamepadCalibration,
  out: ControlInput,
): void {
  out.throttle = normalizeFunc(rawAxes, calib, 'throttle');
  out.rudder = normalizeFunc(rawAxes, calib, 'rudder');
  out.elevator = normalizeFunc(rawAxes, calib, 'elevator');
  out.aileron = normalizeFunc(rawAxes, calib, 'aileron');
}

function normalizeFunc(
  rawAxes: readonly number[],
  calib: GamepadCalibration,
  func: AxisFunction,
): number {
  const cal = calib.axes[func];
  const raw = rawAxes[cal.axisIndex];
  // 軸が読めないとき（切断直後等）は中立扱い
  return normalizeAxis(raw ?? cal.center, cal, calib.deadzone);
}

/**
 * スティックモードのプリセット切替。
 * throttle⇔elevatorの軸割当を入れ替える（ラダー/エルロンは両モード共通）。
 * 同一モードなら同じオブジェクトをそのまま返す。
 */
export function withMode(calib: GamepadCalibration, mode: StickMode): GamepadCalibration {
  if (calib.mode === mode) return calib;
  return {
    ...calib,
    mode,
    axes: {
      ...calib.axes,
      throttle: calib.axes.elevator,
      elevator: calib.axes.throttle,
    },
  };
}

/**
 * W3C標準マッピング（mapping==='standard'）のゲームパッド用プリセット。
 * axes[0]=左X(+右)・axes[1]=左Y(+下)・axes[2]=右X(+右)・axes[3]=右Y(+下)。
 * 縦軸は「上に倒すと負」なので端点を反転して割り当てる。宣言ボタン=0（Aボタン）。
 */
export function standardGamepadCalibration(
  gamepadId: string,
  mode: StickMode = 2,
): GamepadCalibration {
  const axis = (axisIndex: number, inverted: boolean): AxisCalibration => ({
    axisIndex,
    center: 0,
    positive: inverted ? -1 : 1,
    negative: inverted ? 1 : -1,
  });
  const base: GamepadCalibration = {
    version: CALIBRATION_VERSION,
    gamepadId,
    mode: 2,
    deadzone: DEFAULT_DEADZONE,
    axes: {
      throttle: axis(1, true),
      rudder: axis(0, false),
      elevator: axis(3, true),
      aileron: axis(2, false),
    },
    declareButtonIndex: 0,
  };
  return withMode(base, mode);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isValidAxisCalibration(x: unknown): x is AxisCalibration {
  if (typeof x !== 'object' || x === null) return false;
  const a = x as Record<string, unknown>;
  return (
    Number.isInteger(a.axisIndex) &&
    (a.axisIndex as number) >= 0 &&
    isFiniteNumber(a.center) &&
    isFiniteNumber(a.positive) &&
    isFiniteNumber(a.negative) &&
    a.positive !== a.center &&
    a.negative !== a.center
  );
}

/** localStorageから復元した値の形式検証（壊れたデータはnull扱いにするために使う） */
export function isValidCalibration(x: unknown): x is GamepadCalibration {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  if (c.version !== CALIBRATION_VERSION) return false;
  if (typeof c.gamepadId !== 'string' || c.gamepadId.length === 0) return false;
  if (c.mode !== 1 && c.mode !== 2) return false;
  if (!isFiniteNumber(c.deadzone) || c.deadzone < 0 || c.deadzone >= 1) return false;
  if (
    c.declareButtonIndex !== null &&
    (!Number.isInteger(c.declareButtonIndex) || (c.declareButtonIndex as number) < 0)
  ) {
    return false;
  }
  const axes = c.axes as Record<string, unknown> | null | undefined;
  if (typeof axes !== 'object' || axes === null) return false;
  for (const f of AXIS_FUNCTIONS) {
    if (!isValidAxisCalibration(axes[f])) return false;
  }
  return true;
}
