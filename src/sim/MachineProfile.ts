/**
 * sim/MachineProfile.ts — 機体プロファイルの型・検証・読込（DOM非依存）。
 *
 * 数値の正本は data/machines/*.json（コードにハードコードしない・実装原則2）。
 * 各JSONの "_note" に出典/仮置きの区別と、maxSpeedMs/maxDescendMs を
 * 危険速度5m/s未満に収める旨を明記してある（減点表SPEEDの注記）。
 * JSONはビルド時にバンドルされる（外部fetchなし・完全静的）。
 */

import phantom4Raw from '../../data/machines/phantom4-like.json';
import sotenRaw from '../../data/machines/soten-like.json';
import trainerRaw from '../../data/machines/trainer.json';

export interface MachineProfile {
  /** ファイル名由来のID（例: "phantom4-like"） */
  id: string;
  name: string;
  massKg: number;
  /** 機体半径 [m]（衝突判定=radiusM専用。区画判定は機体中心を使う） */
  radiusM: number;
  maxTiltDeg: number;
  /** 傾斜応答の1次遅れ時定数 [s] */
  tiltTimeConstS: number;
  /** GPSモードの最大水平速度指令 [m/s]（危険速度5m/s未満） */
  maxSpeedMs: number;
  maxAscendMs: number;
  maxDescendMs: number;
  yawRateDps: number;
  /** GPSモードでスティック中立時のブレーキング減速度 [m/s^2] */
  brakeDecelMs2: number;
  /** GPS位置ホールド中の目標点揺らぎ振幅 [m] */
  hoverNoise: number;
  /** 抗力係数×前面投影面積 Cd·A [m^2] */
  dragCdA: number;
  /** スティックカーブ（0=リニア〜1=x^3） */
  expo: number;
}

const NUMERIC_FIELDS = [
  'massKg',
  'radiusM',
  'maxTiltDeg',
  'tiltTimeConstS',
  'maxSpeedMs',
  'maxAscendMs',
  'maxDescendMs',
  'yawRateDps',
  'brakeDecelMs2',
  'hoverNoise',
  'dragCdA',
  'expo',
] as const;

/** 危険速度の閾値 [m/s]（減点表SPEED: 概ね5m/s以上で即不合格）。プロファイル検証にのみ使用 */
const DANGER_SPEED_MS = 5;

/**
 * JSONの生データを検証してMachineProfileにする。壊れたデータは起動時に即座に失敗させる
 * （実行中に黙って変な物理になるより早期にわかるほうがよい）。
 */
export function parseMachineProfile(id: string, raw: unknown): MachineProfile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`機体プロファイル ${id}: JSONがオブジェクトでない`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) {
    throw new Error(`機体プロファイル ${id}: name がない`);
  }
  for (const f of NUMERIC_FIELDS) {
    const v = r[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`機体プロファイル ${id}: ${f} が数値でない`);
    }
  }
  const p: MachineProfile = {
    id,
    name: r.name,
    massKg: r.massKg as number,
    radiusM: r.radiusM as number,
    maxTiltDeg: r.maxTiltDeg as number,
    tiltTimeConstS: r.tiltTimeConstS as number,
    maxSpeedMs: r.maxSpeedMs as number,
    maxAscendMs: r.maxAscendMs as number,
    maxDescendMs: r.maxDescendMs as number,
    yawRateDps: r.yawRateDps as number,
    brakeDecelMs2: r.brakeDecelMs2 as number,
    hoverNoise: r.hoverNoise as number,
    dragCdA: r.dragCdA as number,
    expo: r.expo as number,
  };
  if (p.massKg <= 0 || p.radiusM <= 0 || p.tiltTimeConstS <= 0) {
    throw new Error(`機体プロファイル ${id}: 質量・半径・時定数は正であること`);
  }
  if (p.maxTiltDeg <= 0 || p.maxTiltDeg >= 60) {
    throw new Error(`機体プロファイル ${id}: maxTiltDeg は (0, 60) の範囲であること`);
  }
  if (p.maxSpeedMs >= DANGER_SPEED_MS || p.maxDescendMs >= DANGER_SPEED_MS) {
    throw new Error(
      `機体プロファイル ${id}: maxSpeedMs/maxDescendMs は危険速度${DANGER_SPEED_MS}m/s未満に収める（減点表SPEED）`,
    );
  }
  if (p.maxSpeedMs <= 0 || p.maxAscendMs <= 0 || p.maxDescendMs <= 0) {
    throw new Error(`機体プロファイル ${id}: 速度上限は正であること`);
  }
  if (p.expo < 0 || p.expo > 1) {
    throw new Error(`機体プロファイル ${id}: expo は [0, 1] であること`);
  }
  if (p.hoverNoise < 0 || p.dragCdA <= 0 || p.brakeDecelMs2 <= 0 || p.yawRateDps <= 0) {
    throw new Error(`機体プロファイル ${id}: hoverNoise/dragCdA/brakeDecelMs2/yawRateDps が不正`);
  }
  return p;
}

/** バンドル済みの全機体（表示順: 基準機→軽量機→練習機） */
export const MACHINES: readonly MachineProfile[] = [
  parseMachineProfile('phantom4-like', phantom4Raw),
  parseMachineProfile('soten-like', sotenRaw),
  parseMachineProfile('trainer', trainerRaw),
];
