/**
 * FlightDynamics（M2カスケード制御＋セミインプリシットEuler）の機械検証。
 * 物理ステップを実際に回して挙動を検証する（描画なし・実時計なし・シード固定＝決定的）。
 *
 * Done条件（CLAUDE-CODE-PROMPT.md M2）:
 *  - ATTIで定常風を与えると水平ドリフトが発生し、当て舵指令で減速する
 *  - GPSでスティック中立にすると位置ホールドに収束する
 */

import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../core/GameLoop';
import { FlightDynamics, type WindSource } from './FlightDynamics';
import { NEUTRAL_INPUT, horizontalSpeed, type ControlInput } from './FlightModel';
import { MACHINES } from './MachineProfile';
import { WindModel, type WindConfig } from './WindModel';

const PHANTOM = MACHINES[0]; // phantom4-like（基準機）

/** テスト用の固定風（WindSourceの最小実装） */
function fixedWind(x: number, z: number): WindSource {
  return { current: { x, y: 0, z } };
}

/** nステップ進めるヘルパ（風はWindSourceなので更新不要の固定値） */
function stepFor(
  drone: FlightDynamics,
  seconds: number,
  input: Partial<ControlInput>,
): void {
  const full = { ...NEUTRAL_INPUT, ...input };
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) drone.step(FIXED_DT, full);
}

describe('FlightDynamics 共通', () => {
  it('接地中スロットル中立では動かず、スロットルを上げると離陸する', () => {
    const drone = new FlightDynamics({ profile: PHANTOM });
    stepFor(drone, 1, { elevator: 1 }); // 接地中は前進入力だけでは滑走しない
    expect(drone.state.p.y).toBe(0);
    expect(drone.state.p.z).toBe(0);

    stepFor(drone, 1.5, { throttle: 1 });
    expect(drone.state.p.y).toBeGreaterThan(1); // 1.5秒フルスロットルで1m以上上昇
  });

  it('同一シード・同一入力列で軌道が完全一致する（決定性）', () => {
    const cfg: WindConfig = {
      steadyMs: 3,
      steadyDirDeg: 10,
      gust: {
        enabled: true,
        ampMinMs: 0.5,
        ampMaxMs: 1.2,
        intervalMinS: 1,
        intervalMaxS: 2,
        durMinS: 1,
        durMaxS: 2,
        tauS: 0.8,
      },
      turbulence: { ampMs: 0.4, freqHz: 0.7 },
    };
    const run = (): { x: number; y: number; z: number; yaw: number } => {
      const wind = new WindModel(cfg, 42);
      const drone = new FlightDynamics({ profile: PHANTOM, wind, seed: 7, mode: 'atti' });
      const input = { ...NEUTRAL_INPUT };
      let t = 0;
      for (let i = 0; i < Math.round(6 / FIXED_DT); i++) {
        input.throttle = t < 1.5 ? 1 : 0;
        input.elevator = t >= 2 && t < 3 ? 0.5 : 0;
        input.rudder = t >= 3 && t < 4 ? 0.3 : 0;
        wind.update(FIXED_DT, t);
        drone.step(FIXED_DT, input);
        t += FIXED_DT;
      }
      const s = drone.state;
      return { x: s.p.x, y: s.p.y, z: s.p.z, yaw: s.yawRad };
    };
    const a = run();
    const b = run();
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.z).toBe(a.z);
    expect(b.yaw).toBe(a.yaw);
  });

  it('姿勢クォータニオンqがヨー/傾斜と同期する（ヨー90°で|q.y|≈sin45°）', () => {
    const drone = new FlightDynamics({ profile: PHANTOM });
    stepFor(drone, 1.5, { throttle: 1 });
    // ヨーレート120deg/s（expo通過後は減るため0.75秒フルラダーで約90°を狙わず、角度自体を検証）
    stepFor(drone, 1, { rudder: 1 });
    const s = drone.state;
    const expectedHalf = s.yawRad / 2;
    // 傾斜がほぼ0のとき q ≈ (0, sin(yaw/2), 0, cos(yaw/2))
    expect(Math.abs(s.q.y - Math.sin(expectedHalf))).toBeLessThan(0.02);
    expect(Math.abs(s.q.w - Math.cos(expectedHalf))).toBeLessThan(0.02);
  });
});

describe('GPSモード（位置安定ON）', () => {
  it('スティック中立でブレーキング減速→位置ホールドに収束する', () => {
    const drone = new FlightDynamics({ profile: PHANTOM, initial: { p: { z: 9 } } });
    stepFor(drone, 1.5, { throttle: 1 }); // 離陸
    stepFor(drone, 2, { elevator: 1 }); // 前進（-z方向）で速度を乗せる
    expect(horizontalSpeed(drone.state.v)).toBeGreaterThan(2);

    stepFor(drone, 4, {}); // 中立4秒: ブレーキ→ホールド
    expect(horizontalSpeed(drone.state.v)).toBeLessThan(0.1);
    const holdX = drone.state.p.x;
    const holdZ = drone.state.p.z;

    // さらに5秒中立: ホールド位置に留まる（hoverNoise=0.02m の微小揺らぎのみ）
    let maxDev = 0;
    for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
      drone.step(FIXED_DT, NEUTRAL_INPUT);
      const dev = Math.hypot(drone.state.p.x - holdX, drone.state.p.z - holdZ);
      if (dev > maxDev) maxDev = dev;
    }
    expect(maxDev).toBeLessThan(0.15);
  });

  it('定常風があっても位置ホールドが持ちこたえる（速度ループ積分が打ち消す）', () => {
    const drone = new FlightDynamics({ profile: PHANTOM, wind: fixedWind(3, 0) });
    stepFor(drone, 1.5, { throttle: 1 }); // 離陸（ホールド目標=原点付近）
    stepFor(drone, 8, {}); // 中立8秒
    expect(horizontalSpeed(drone.state.v)).toBeLessThan(0.2);
    expect(Math.abs(drone.state.p.x)).toBeLessThan(0.5); // 風下へ流されず保持
    // 収束後さらに5秒のドリフトも小さい
    const x0 = drone.state.p.x;
    const z0 = drone.state.p.z;
    stepFor(drone, 5, {});
    expect(Math.hypot(drone.state.p.x - x0, drone.state.p.z - z0)).toBeLessThan(0.2);
  });

  it('水平速度はmaxSpeedMs（<危険速度5m/s）近傍で頭打ちになる', () => {
    const drone = new FlightDynamics({ profile: PHANTOM, initial: { p: { z: 9 } } });
    stepFor(drone, 1.5, { throttle: 1 });
    let maxSpeed = 0;
    const full = { ...NEUTRAL_INPUT, elevator: 1 };
    for (let i = 0; i < Math.round(3.5 / FIXED_DT); i++) {
      drone.step(FIXED_DT, full);
      const s = horizontalSpeed(drone.state.v);
      if (s > maxSpeed) maxSpeed = s;
    }
    expect(maxSpeed).toBeLessThanOrEqual(PHANTOM.maxSpeedMs + 0.3);
    expect(maxSpeed).toBeGreaterThan(PHANTOM.maxSpeedMs - 0.5); // 指令には追従している
    expect(maxSpeed).toBeLessThan(5); // 危険速度未満
  });

  it('スロットル中立で高度を保持する', () => {
    const drone = new FlightDynamics({ profile: PHANTOM });
    stepFor(drone, 1.5, { throttle: 1 });
    stepFor(drone, 4, {}); // 上昇の行き足が収まりホールド目標へ整定
    const alt = drone.state.p.y;
    stepFor(drone, 5, { elevator: 0.5 }); // 水平移動しても
    expect(Math.abs(drone.state.p.y - alt)).toBeLessThan(0.2); // 高度はほぼ維持
  });
});

describe('ATTIモード（位置安定OFF）', () => {
  it('定常風で水平にドリフトする（外側ループがないため風下へ流される）', () => {
    const drone = new FlightDynamics({ profile: PHANTOM, wind: fixedWind(3, 0), mode: 'atti' });
    stepFor(drone, 1.5, { throttle: 1 }); // 離陸
    const altAfterClimb = drone.state.p.y;
    stepFor(drone, 8, {}); // スティック中立8秒（傾斜0のまま）

    // 風下(+x)へドリフトが発生している
    expect(drone.state.v.x).toBeGreaterThan(0.8);
    expect(drone.state.p.x).toBeGreaterThan(3);
    // 高度はゆっくり保持（気圧計相当）＝大きくは落ちない
    expect(Math.abs(drone.state.p.y - altAfterClimb)).toBeLessThan(0.8);
  });

  it('ドリフト中に当て舵（風上へエルロン）を入れると減速する', () => {
    const drone = new FlightDynamics({ profile: PHANTOM, wind: fixedWind(3, 0), mode: 'atti' });
    stepFor(drone, 1.5, { throttle: 1 });
    stepFor(drone, 8, {}); // ドリフトさせる
    const driftSpeed = drone.state.v.x;
    expect(driftSpeed).toBeGreaterThan(0.8);

    // 当て舵: 機首は-z向きのままなので風上(-x)へはエルロン負
    const full = { ...NEUTRAL_INPUT, aileron: -0.6 };
    let minAbsVx = Infinity;
    for (let i = 0; i < Math.round(3 / FIXED_DT); i++) {
      drone.step(FIXED_DT, full);
      const a = Math.abs(drone.state.v.x);
      if (a < minAbsVx) minAbsVx = a;
    }
    expect(minAbsVx).toBeLessThan(0.3); // ドリフトを一度は止められる
  });

  it('中立に戻しても慣性で滑走し、抗力でしか減速しない（GPSと対照）', () => {
    // 同一入力列: 離陸→前進0.5×2秒→中立2秒
    const flyProfile = (mode: 'gps' | 'atti'): number => {
      const drone = new FlightDynamics({ profile: PHANTOM, mode, initial: { p: { z: 9 } } });
      stepFor(drone, 1.5, { throttle: 1 });
      stepFor(drone, 2, { elevator: 0.5 });
      stepFor(drone, 2, {});
      return horizontalSpeed(drone.state.v);
    };
    expect(flyProfile('gps')).toBeLessThan(0.3); // GPS: ブレーキングでほぼ停止
    expect(flyProfile('atti')).toBeGreaterThan(2.0); // ATTI: 滑走が続く
  });

  it('ATTIでドリフト中にGPSへ切り替えると風に抗して停止・保持する', () => {
    const wind = fixedWind(3, 0);
    const drone = new FlightDynamics({ profile: PHANTOM, wind, mode: 'atti' });
    stepFor(drone, 1.5, { throttle: 1 });
    stepFor(drone, 6, {}); // ドリフト
    expect(drone.state.v.x).toBeGreaterThan(0.6);

    drone.setMode('gps');
    stepFor(drone, 4, {});
    expect(horizontalSpeed(drone.state.v)).toBeLessThan(0.2);
    const x0 = drone.state.p.x;
    stepFor(drone, 4, {});
    expect(Math.abs(drone.state.p.x - x0)).toBeLessThan(0.3); // 風下へ流され続けない
  });

  it('機体差: soten-like（軽量・高抗力）はphantom4-likeより速くドリフトする', () => {
    const drift = (profileId: string): number => {
      const prof = MACHINES.find((m) => m.id === profileId)!;
      const drone = new FlightDynamics({ profile: prof, wind: fixedWind(3, 0), mode: 'atti' });
      stepFor(drone, 1.5, { throttle: 1 });
      stepFor(drone, 6, {});
      return drone.state.p.x;
    };
    expect(drift('soten-like')).toBeGreaterThan(drift('phantom4-like') * 1.2);
  });
});
