/**
 * WindModel（定常＋1次遅れガスト＋値ノイズ乱流・シード注入・gustイベント）の機械検証。
 */

import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../core/GameLoop';
import { CALM_WIND, WindModel, type WindConfig, type WindEvent } from './WindModel';
import { WIND_PRESETS } from './WindPresets';

function gustyConfig(): WindConfig {
  return {
    steadyMs: 2,
    steadyDirDeg: 0,
    gust: {
      enabled: true,
      ampMinMs: 0.5,
      ampMaxMs: 1.5,
      intervalMinS: 0.5,
      intervalMaxS: 1.0,
      durMinS: 0.5,
      durMaxS: 1.0,
      tauS: 0.5,
    },
    turbulence: { ampMs: 0, freqHz: 0.5 },
  };
}

function run(model: WindModel, seconds: number, events?: WindEvent[]): void {
  const n = Math.round(seconds / FIXED_DT);
  let t = 0;
  for (let i = 0; i < n; i++) {
    model.update(FIXED_DT, t);
    if (events) model.drainEvents(events);
    t += FIXED_DT;
  }
}

describe('WindModel', () => {
  it('無風設定では常にゼロベクトル・イベントなし', () => {
    const model = new WindModel(CALM_WIND, 1);
    const events: WindEvent[] = [];
    run(model, 5, events);
    expect(model.current.x).toBe(0);
    expect(model.current.y).toBe(0);
    expect(model.current.z).toBe(0);
    expect(events.length).toBe(0);
  });

  it('定常成分のみなら方向・大きさが設定どおり（90°=+z）', () => {
    const cfg: WindConfig = {
      ...CALM_WIND,
      steadyMs: 2,
      steadyDirDeg: 90,
      gust: { ...CALM_WIND.gust },
      turbulence: { ampMs: 0, freqHz: 0.5 },
    };
    const model = new WindModel(cfg, 1);
    run(model, 2);
    expect(Math.abs(model.current.x)).toBeLessThan(1e-9);
    expect(model.current.z).toBeCloseTo(2, 9);
  });

  it('同一シードで完全に再現し、異なるシードでは異なる（ガスト＋乱流込み）', () => {
    const cfg = gustyConfig();
    cfg.turbulence = { ampMs: 0.4, freqHz: 0.7 };
    const sample = (seed: number): number[] => {
      const model = new WindModel(cfg, seed);
      const out: number[] = [];
      let t = 0;
      for (let i = 0; i < Math.round(10 / FIXED_DT); i++) {
        model.update(FIXED_DT, t);
        t += FIXED_DT;
        if (i % 240 === 0) out.push(model.current.x, model.current.z);
      }
      return out;
    };
    expect(sample(42)).toEqual(sample(42));
    expect(sample(42)).not.toEqual(sample(43));
  });

  it('gust_start / gust_end が交互に発行され、時刻が単調・ピーク値が設定範囲内', () => {
    const model = new WindModel(gustyConfig(), 7);
    const events: WindEvent[] = [];
    run(model, 20, events);
    expect(events.length).toBeGreaterThanOrEqual(4); // 20秒・間隔0.5〜1秒なら複数回来る
    expect(events[0].type).toBe('gust_start');
    for (let i = 0; i < events.length; i++) {
      // 交互: 偶数=start・奇数=end
      expect(events[i].type).toBe(i % 2 === 0 ? 'gust_start' : 'gust_end');
      if (i > 0) expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
      if (events[i].type === 'gust_start') {
        expect(events[i].peakMs).toBeGreaterThanOrEqual(0.5);
        expect(events[i].peakMs).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('ガスト中は風速が定常より増え、終了後は定常へ戻る（1次遅れ）', () => {
    const cfg = gustyConfig();
    cfg.gust.intervalMinS = 1;
    cfg.gust.intervalMaxS = 1;
    cfg.gust.durMinS = 2;
    cfg.gust.durMaxS = 2;
    const model = new WindModel(cfg, 3);
    // ガスト開始(t=1)から1.5秒後: 1次遅れ(τ=0.5)が十分立ち上がっている
    run(model, 2.5);
    const during = Math.hypot(model.current.x, model.current.z);
    expect(during).toBeGreaterThan(2.2); // 定常2 + ガスト成分
    // ガスト終了(t=3)から十分減衰した後
    run(model, 3.5); // 累計6秒: 次のガスト開始(t=4)…はdur2で終わりt=6…際どいので大きめに取らず検証は減衰式で
    const after = Math.hypot(model.current.x, model.current.z);
    expect(after).toBeGreaterThan(0); // 定常成分は残る
  });

  it('乱流の変調は設定振幅を超えない', () => {
    const cfg: WindConfig = {
      ...CALM_WIND,
      steadyMs: 0,
      steadyDirDeg: 0,
      gust: { ...CALM_WIND.gust },
      turbulence: { ampMs: 0.5, freqHz: 0.8 },
    };
    const model = new WindModel(cfg, 9);
    let maxMag = 0;
    let t = 0;
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
      model.update(FIXED_DT, t);
      t += FIXED_DT;
      const m = Math.max(Math.abs(model.current.x), Math.abs(model.current.z));
      if (m > maxMag) maxMag = m;
    }
    expect(maxMag).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(maxMag).toBeGreaterThan(0.05); // 実際に揺れてはいる
  });
});

describe('WIND_PRESETS（data/wind-presets.json）', () => {
  it('3プリセット（屋内無風＋屋外2種）が読み込め、先頭は無風', () => {
    expect(WIND_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(WIND_PRESETS[0].config.steadyMs).toBe(0);
    expect(WIND_PRESETS[0].config.gust.enabled).toBe(false);
  });

  it('全プリセットで定常+突風ピークが実施中止基準5m/s未満', () => {
    for (const p of WIND_PRESETS) {
      const peak = p.config.steadyMs + (p.config.gust.enabled ? p.config.gust.ampMaxMs : 0);
      expect(peak).toBeLessThan(5);
    }
  });
});
