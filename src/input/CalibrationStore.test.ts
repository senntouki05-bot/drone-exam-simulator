import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_VERSION,
  standardGamepadCalibration,
  type GamepadCalibration,
} from './calibration';
import {
  calibrationKey,
  loadCalibration,
  saveCalibration,
  type StorageLike,
} from './CalibrationStore';

/** localStorageのモック（Mapベース） */
function makeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const ID_A = 'RadioMaster TX16S Joystick (Vendor: 1234 Product: 5678)';
const ID_B = 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)';

describe('CalibrationStore（localStorage保存/復元の往復）', () => {
  it('保存→復元でオブジェクトが完全一致する', () => {
    const storage = makeStorage();
    const calib: GamepadCalibration = standardGamepadCalibration(ID_A, 1);
    saveCalibration(storage, calib);
    const loaded = loadCalibration(storage, ID_A);
    expect(loaded).toEqual(calib);
    expect(loaded).not.toBe(calib); // JSON往復した別オブジェクト
  });

  it('gamepad.idごとに別キーで保存され混ざらない', () => {
    const storage = makeStorage();
    const a = standardGamepadCalibration(ID_A, 2);
    const b = standardGamepadCalibration(ID_B, 1);
    saveCalibration(storage, a);
    saveCalibration(storage, b);
    expect(storage.map.size).toBe(2);
    expect(storage.map.has(calibrationKey(ID_A))).toBe(true);
    expect(storage.map.has(calibrationKey(ID_B))).toBe(true);
    expect(loadCalibration(storage, ID_A)).toEqual(a);
    expect(loadCalibration(storage, ID_B)).toEqual(b);
  });

  it('未保存のidはnull', () => {
    expect(loadCalibration(makeStorage(), ID_A)).toBeNull();
  });

  it('壊れたJSONはnull（例外を投げない）', () => {
    const storage = makeStorage();
    storage.map.set(calibrationKey(ID_A), '{not json');
    expect(loadCalibration(storage, ID_A)).toBeNull();
  });

  it('形式不正（版違い・欠損）はnull', () => {
    const storage = makeStorage();
    const calib = standardGamepadCalibration(ID_A);
    storage.map.set(
      calibrationKey(ID_A),
      JSON.stringify({ ...calib, version: CALIBRATION_VERSION + 1 }),
    );
    expect(loadCalibration(storage, ID_A)).toBeNull();
    storage.map.set(calibrationKey(ID_A), JSON.stringify({ ...calib, axes: {} }));
    expect(loadCalibration(storage, ID_A)).toBeNull();
  });

  it('保存キーのidと中身のgamepadIdが食い違う場合はnull', () => {
    const storage = makeStorage();
    const calib = standardGamepadCalibration(ID_B); // 中身はID_B
    storage.map.set(calibrationKey(ID_A), JSON.stringify(calib)); // キーはID_A
    expect(loadCalibration(storage, ID_A)).toBeNull();
  });
});
