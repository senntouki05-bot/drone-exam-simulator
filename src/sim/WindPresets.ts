/**
 * sim/WindPresets.ts — data/wind-presets.json の読込と検証（DOM非依存）。
 *
 * 数値の正本はJSON側（実装原則1: 細則に明文がない値は data/ に _note 付きで置く）。
 * 屋外プリセットは定常+突風ピーク合計が5m/s未満（実施中止基準未満）に収まることを検証する。
 */

import presetsRaw from '../../data/wind-presets.json';
import type { WindConfig } from './WindModel';

export interface WindPreset {
  id: string;
  label: string;
  config: WindConfig;
}

/** 実施中止基準 [m/s]（5m/s以上の突風で屋外実施不可・DESIGN.md 2.4） */
const WIND_ABORT_MS = 5;

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`wind-presets.json: ${path} が数値でない`);
  }
  return v;
}

export function parseWindPreset(raw: unknown): WindPreset {
  if (typeof raw !== 'object' || raw === null) throw new Error('wind-presets.json: 形式不正');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.label !== 'string') {
    throw new Error('wind-presets.json: id/label がない');
  }
  const g = (r.gust ?? {}) as Record<string, unknown>;
  const t = (r.turbulence ?? {}) as Record<string, unknown>;
  const config: WindConfig = {
    steadyMs: num(r.steadyMs, `${r.id}.steadyMs`),
    steadyDirDeg: num(r.steadyDirDeg, `${r.id}.steadyDirDeg`),
    gust: {
      enabled: g.enabled === true,
      ampMinMs: num(g.ampMinMs, `${r.id}.gust.ampMinMs`),
      ampMaxMs: num(g.ampMaxMs, `${r.id}.gust.ampMaxMs`),
      intervalMinS: num(g.intervalMinS, `${r.id}.gust.intervalMinS`),
      intervalMaxS: num(g.intervalMaxS, `${r.id}.gust.intervalMaxS`),
      durMinS: num(g.durMinS, `${r.id}.gust.durMinS`),
      durMaxS: num(g.durMaxS, `${r.id}.gust.durMaxS`),
      tauS: num(g.tauS, `${r.id}.gust.tauS`),
    },
    turbulence: {
      ampMs: num(t.ampMs, `${r.id}.turbulence.ampMs`),
      freqHz: num(t.freqHz, `${r.id}.turbulence.freqHz`),
    },
  };
  const peak = config.steadyMs + (config.gust.enabled ? config.gust.ampMaxMs : 0);
  if (peak >= WIND_ABORT_MS) {
    throw new Error(
      `wind-presets.json: ${r.id} の定常+突風ピーク(${peak}m/s)が実施中止基準${WIND_ABORT_MS}m/s以上`,
    );
  }
  return { id: r.id, label: r.label, config };
}

function parseAll(raw: unknown): readonly WindPreset[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { presets?: unknown }).presets)) {
    throw new Error('wind-presets.json: presets配列がない');
  }
  const list = ((raw as { presets: unknown[] }).presets).map(parseWindPreset);
  if (list.length === 0) throw new Error('wind-presets.json: プリセットが空');
  return list;
}

/** バンドル済みの風プリセット（先頭=屋内無風が既定） */
export const WIND_PRESETS: readonly WindPreset[] = parseAll(presetsRaw);
