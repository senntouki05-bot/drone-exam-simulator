/**
 * noise（シード付きPRNG・1次元値ノイズ）の機械検証。
 */

import { describe, expect, it } from 'vitest';
import { fbm1D, mulberry32, noise1D } from './noise';

describe('mulberry32', () => {
  it('同一シードで同一列・異なるシードで異なる列', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const c = mulberry32(124);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('出力は[0, 1)', () => {
    const r = mulberry32(999);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('noise1D / fbm1D', () => {
  it('同一(seed, t)で決定的', () => {
    expect(noise1D(42, 3.7)).toBe(noise1D(42, 3.7));
    expect(fbm1D(42, 3.7)).toBe(fbm1D(42, 3.7));
  });

  it('出力は[-1, 1]', () => {
    for (let i = 0; i < 500; i++) {
      const t = i * 0.137;
      expect(Math.abs(noise1D(7, t))).toBeLessThanOrEqual(1);
      expect(Math.abs(fbm1D(7, t))).toBeLessThanOrEqual(1);
    }
  });

  it('連続的（小さなΔtで値が飛ばない）', () => {
    for (let i = 0; i < 200; i++) {
      const t = i * 0.31;
      const d = Math.abs(noise1D(11, t + 0.001) - noise1D(11, t));
      expect(d).toBeLessThan(0.02);
    }
  });
});
