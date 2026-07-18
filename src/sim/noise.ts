/**
 * sim/noise.ts — シード注入可能な乱数と1次元Perlin風（値）ノイズ（DOM非依存の純関数）。
 *
 * - mulberry32: 32bitシードの決定的PRNG（風モデルのガスト計画・hoverNoise等に使用）。
 * - noise1D: 整数格子上のハッシュ値をsmootherstep補間する1次元値ノイズ。
 *   同一(seed, t)なら常に同じ値を返す＝テストで軌道を機械検証できる。
 * - fbm1D: noise1Dの2オクターブ合成（乱流の変調用）。出力は概ね[-1, 1]。
 */

/** 決定的PRNG（mulberry32）。戻り値は[0,1)の一様乱数を返す関数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 整数iとシードから[-1, 1]の決定的ハッシュ値 */
function hashLattice(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h / 0xffffffff) * 2 - 1;
}

/** smootherstep（C2連続の補間係数） */
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 1次元値ノイズ。同一(seed, t)で決定的。出力は[-1, 1] */
export function noise1D(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashLattice(seed, i);
  const b = hashLattice(seed, i + 1);
  return a + (b - a) * smoother(f);
}

/** 2オクターブのfBm（周波数1x+2x）。出力は概ね[-1, 1] */
export function fbm1D(seed: number, t: number): number {
  return (noise1D(seed, t) + 0.4 * noise1D(seed ^ 0x5bd1e995, t * 2)) / 1.4;
}
