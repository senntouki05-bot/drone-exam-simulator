import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type ControlInput } from '../sim/FlightModel';
import {
  CALIBRATION_VERSION,
  DEFAULT_DEADZONE,
  applyCalibration,
  isValidCalibration,
  normalizeAxis,
  standardGamepadCalibration,
  withMode,
  type AxisCalibration,
  type GamepadCalibration,
} from './calibration';

const sym = (axisIndex: number): AxisCalibration => ({
  axisIndex,
  center: 0,
  positive: 1,
  negative: -1,
});

const inv = (axisIndex: number): AxisCalibration => ({
  axisIndex,
  center: 0,
  positive: -1,
  negative: 1,
});

describe('normalizeAxis', () => {
  it('対称軸（中立0・端点±1）を恒等マップする', () => {
    const cal = sym(0);
    expect(normalizeAxis(0, cal, 0)).toBe(0);
    expect(normalizeAxis(1, cal, 0)).toBe(1);
    expect(normalizeAxis(-1, cal, 0)).toBe(-1);
    expect(normalizeAxis(0.5, cal, 0)).toBeCloseTo(0.5, 12);
  });

  it('端点超えはクランプする', () => {
    const cal = sym(0);
    expect(normalizeAxis(2, cal, 0)).toBe(1);
    expect(normalizeAxis(-1.5, cal, 0)).toBe(-1);
  });

  it('反転軸（上に倒すと生値が負）は端点記録だけで正しく反転する', () => {
    const cal = inv(0);
    expect(normalizeAxis(-1, cal, 0)).toBe(1);
    expect(normalizeAxis(1, cal, 0)).toBe(-1);
    expect(normalizeAxis(0.5, cal, 0)).toBeCloseTo(-0.5, 12);
  });

  it('中立が0でない軸・非対称可動域を線形マップする', () => {
    // 中立-0.2、正側の可動域1.2、負側の可動域0.8
    const cal: AxisCalibration = { axisIndex: 0, center: -0.2, positive: 1, negative: -1 };
    expect(normalizeAxis(-0.2, cal, 0)).toBe(0);
    expect(normalizeAxis(0.4, cal, 0)).toBeCloseTo(0.5, 12); // (0.4-(-0.2))/1.2
    expect(normalizeAxis(-0.6, cal, 0)).toBeCloseTo(-0.5, 12); // -((-0.6-(-0.2))/(-0.8))
    expect(normalizeAxis(1, cal, 0)).toBe(1);
    expect(normalizeAxis(-1, cal, 0)).toBe(-1);
  });

  it('デッドゾーン内は0、残りは端点±1を維持したまま再スケールする', () => {
    const cal = sym(0);
    expect(normalizeAxis(0.05, cal, 0.1)).toBe(0);
    expect(normalizeAxis(0.1, cal, 0.1)).toBe(0); // 境界ちょうどは0
    expect(normalizeAxis(-0.08, cal, 0.1)).toBe(0);
    expect(normalizeAxis(0.55, cal, 0.1)).toBeCloseTo(0.5, 12); // (0.55-0.1)/0.9
    expect(normalizeAxis(-0.55, cal, 0.1)).toBeCloseTo(-0.5, 12);
    expect(normalizeAxis(1, cal, 0.1)).toBe(1);
    expect(normalizeAxis(-1, cal, 0.1)).toBe(-1);
  });
});

/** 実プロポ風の混在割当: 軸順バラバラ＋反転軸を含む */
function radioLikeCalibration(deadzone = 0): GamepadCalibration {
  return {
    version: CALIBRATION_VERSION,
    gamepadId: 'RadioMaster TX16S Joystick (Vendor: 1234 Product: 5678)',
    mode: 2,
    deadzone,
    axes: {
      throttle: sym(2),
      rudder: inv(5),
      elevator: inv(1),
      aileron: sym(0),
    },
    declareButtonIndex: 3,
  };
}

describe('applyCalibration（既知の軸配列→正規化4軸）', () => {
  it('混在割当（軸順バラバラ・反転あり）で期待値に一致する', () => {
    const calib = radioLikeCalibration(0);
    const out: ControlInput = { ...NEUTRAL_INPUT };
    //            ail=0.5   elev(inv)   thr=0.25          rud(inv)
    const rawAxes = [0.5, -1, 0.25, 0, 0, 0.6];
    applyCalibration(rawAxes, calib, out);
    expect(out.throttle).toBeCloseTo(0.25, 12);
    expect(out.rudder).toBeCloseTo(-0.6, 12);
    expect(out.elevator).toBeCloseTo(1, 12);
    expect(out.aileron).toBeCloseTo(0.5, 12);
  });

  it('全軸中立なら全機能0', () => {
    const out: ControlInput = { ...NEUTRAL_INPUT, aileron: 0.9 };
    applyCalibration([0, 0, 0, 0, 0, 0], radioLikeCalibration(0), out);
    expect(out).toEqual({ aileron: 0, elevator: 0, throttle: 0, rudder: 0 });
  });

  it('割当軸が生軸配列の範囲外なら中立扱い（切断直後の安全側）', () => {
    const out: ControlInput = { ...NEUTRAL_INPUT };
    applyCalibration([0.5, -1], radioLikeCalibration(0), out); // 軸2・5が存在しない
    expect(out.throttle).toBe(0);
    expect(out.rudder).toBe(0);
    expect(out.elevator).toBeCloseTo(1, 12);
    expect(out.aileron).toBeCloseTo(0.5, 12);
  });
});

describe('standardGamepadCalibration（モード1/2プリセット）', () => {
  it('モード2: 左Y=スロットル(上=+)・左X=ラダー・右Y=エレベーター(上=+)・右X=エルロン', () => {
    const calib = standardGamepadCalibration('Xbox 360 Controller (STANDARD GAMEPAD)', 2);
    const out: ControlInput = { ...NEUTRAL_INPUT };
    // W3C標準: [左X, 左Y(下+), 右X, 右Y(下+)] → 左スティック右0.5・左Y上いっぱい・右Y下いっぱい
    applyCalibration([0.5, -1, 0, 1], calib, out);
    expect(out.throttle).toBeCloseTo(1, 12);
    expect(out.rudder).toBeCloseTo((0.5 - DEFAULT_DEADZONE) / (1 - DEFAULT_DEADZONE), 12);
    expect(out.elevator).toBeCloseTo(-1, 12);
    expect(out.aileron).toBe(0);
    expect(calib.declareButtonIndex).toBe(0);
  });

  it('モード1: スロットルとエレベーターの縦軸が入れ替わる（ラダー/エルロンは共通）', () => {
    const calib = standardGamepadCalibration('pad', 1);
    const out: ControlInput = { ...NEUTRAL_INPUT };
    applyCalibration([0.5, -1, 0, 1], calib, out);
    expect(out.throttle).toBeCloseTo(-1, 12); // 右Y下いっぱい→スロットル下
    expect(out.elevator).toBeCloseTo(1, 12); // 左Y上いっぱい→エレベーター上
    expect(out.rudder).toBeCloseTo((0.5 - DEFAULT_DEADZONE) / (1 - DEFAULT_DEADZONE), 12);
    expect(out.aileron).toBe(0);
  });
});

describe('withMode', () => {
  it('同一モードなら同じオブジェクトを返す', () => {
    const calib = radioLikeCalibration();
    expect(withMode(calib, 2)).toBe(calib);
  });

  it('モード切替でthrottle⇔elevatorのみ入れ替わり、2回で元に戻る', () => {
    const calib = radioLikeCalibration();
    const m1 = withMode(calib, 1);
    expect(m1.mode).toBe(1);
    expect(m1.axes.throttle).toEqual(calib.axes.elevator);
    expect(m1.axes.elevator).toEqual(calib.axes.throttle);
    expect(m1.axes.rudder).toEqual(calib.axes.rudder);
    expect(m1.axes.aileron).toEqual(calib.axes.aileron);
    expect(withMode(m1, 2)).toEqual(calib);
  });
});

describe('isValidCalibration', () => {
  it('正しい形式を受理する', () => {
    expect(isValidCalibration(radioLikeCalibration())).toBe(true);
    expect(isValidCalibration(standardGamepadCalibration('pad'))).toBe(true);
  });

  it('壊れた形式を拒否する', () => {
    const base = radioLikeCalibration();
    expect(isValidCalibration(null)).toBe(false);
    expect(isValidCalibration('{}')).toBe(false);
    expect(isValidCalibration({ ...base, version: 999 })).toBe(false);
    expect(isValidCalibration({ ...base, mode: 3 })).toBe(false);
    expect(isValidCalibration({ ...base, deadzone: 1.5 })).toBe(false);
    expect(isValidCalibration({ ...base, declareButtonIndex: -1 })).toBe(false);
    expect(isValidCalibration({ ...base, axes: { ...base.axes, throttle: undefined } })).toBe(
      false,
    );
    // 端点=中立（0除算になる割当）を拒否
    expect(
      isValidCalibration({
        ...base,
        axes: {
          ...base.axes,
          throttle: { axisIndex: 2, center: 0, positive: 0, negative: -1 },
        },
      }),
    ).toBe(false);
  });
});
