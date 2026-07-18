/**
 * input/CalibrationStore.ts — キャリブレーションのlocalStorage保存/復元（gamepad.idごと）。
 *
 * Storageはインターフェース（StorageLike）で注入可能にし、Vitest(node環境)からは
 * Mapベースの偽ストレージで往復テストする。壊れたJSON・版違い・形式不正はnullを返す
 * （呼び出し側は「未キャリブレーション」として扱い、ウィザードへ誘導する）。
 */

import { isValidCalibration, type GamepadCalibration } from './calibration';

/** localStorage互換の最小インターフェース */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CALIBRATION_KEY_PREFIX = 'droneExamSim.calibration.v1:';

export function calibrationKey(gamepadId: string): string {
  return CALIBRATION_KEY_PREFIX + gamepadId;
}

/** 保存。Storage例外（容量超過・プライベートモード等）は呼び出し側でcatchする */
export function saveCalibration(storage: StorageLike, calib: GamepadCalibration): void {
  storage.setItem(calibrationKey(calib.gamepadId), JSON.stringify(calib));
}

/** 復元。未保存・壊れたデータ・版違いはnull */
export function loadCalibration(
  storage: StorageLike,
  gamepadId: string,
): GamepadCalibration | null {
  const raw = storage.getItem(calibrationKey(gamepadId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidCalibration(parsed)) return null;
  if (parsed.gamepadId !== gamepadId) return null;
  return parsed;
}
