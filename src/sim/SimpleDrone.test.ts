import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../core/GameLoop';
import { NEUTRAL_INPUT } from './FlightModel';
import { SimpleDrone } from './SimpleDrone';

/** nステップ進めるヘルパ */
function stepFor(drone: SimpleDrone, seconds: number, input: Partial<typeof NEUTRAL_INPUT>): void {
  const full = { ...NEUTRAL_INPUT, ...input };
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) drone.step(FIXED_DT, full);
}

describe('SimpleDrone（M0仮機体）', () => {
  it('接地中スロットル中立では動かず、スロットルを上げると離陸する', () => {
    const drone = new SimpleDrone();
    stepFor(drone, 1, { elevator: 1 }); // 接地中は前進入力だけでは滑走しない
    expect(drone.state.p.y).toBe(0);
    expect(drone.state.p.z).toBe(0);

    stepFor(drone, 2, { throttle: 1 });
    expect(drone.state.p.y).toBeGreaterThan(1); // 2秒フルスロットルで1m以上上昇
  });

  it('中立に戻すと減速して実質ホールドする（GPSモード風）', () => {
    const drone = new SimpleDrone();
    stepFor(drone, 2, { throttle: 1 }); // 離陸
    stepFor(drone, 2, { elevator: 1 }); // 前進（-z方向）
    expect(drone.state.p.z).toBeLessThan(-1);

    stepFor(drone, 3, {}); // 中立3秒
    const speed = Math.hypot(drone.state.v.x, drone.state.v.z);
    expect(speed).toBeLessThan(0.01); // ほぼ停止
  });

  it('水平速度は最大速度（3m/s＝危険速度5m/s未満）を超えない', () => {
    const drone = new SimpleDrone();
    stepFor(drone, 2, { throttle: 1 });
    stepFor(drone, 5, { elevator: 1, aileron: 0 });
    const speed = Math.hypot(drone.state.v.x, drone.state.v.z);
    expect(speed).toBeLessThanOrEqual(3.0 + 1e-9);
  });
});
