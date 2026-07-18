/**
 * exam/DeductionsConfig.ts — 減点表・判定閾値・FSM既定値の型と検証（DOM非依存）。
 *
 * 数値の正本は data/deductions.json（点数・持ち点は細則明文／閾値・FSM値は仮置き・_note参照）。
 * 壊れた設定は起動時に即座に失敗させる（MachineProfile/Courseと同じ方針）。
 */

import rawDeductions from '../../data/deductions.json';

/** 減点コード（−点数系） */
export type DeductCode =
  | 'ZONE_DEV'
  | 'WRONG_OP'
  | 'LAND_BAD'
  | 'SAFETY'
  | 'WOBBLE'
  | 'ROUGH'
  | 'HEADING';

/** 即不合格コード */
export type FailCode = 'CRASH' | 'SPEED' | 'ZONE_FAIL' | 'CENTER_MISS' | 'TIMEOUT';

export type DeductionCode = DeductCode | FailCode;

export interface DeductionThresholds {
  dangerSpeedMs: number;
  dangerSpeedHoldS: number;
  crashDescentMs: number;
  crashTiltDeg: number;
  landBadDescentMs: number;
  zoneDevRecoveryS: number;
  headingErrDeg: number;
  headingHoldS: number;
  headingGraceS: number;
  wrongOpAltErrM: number;
  wrongOpAltHoldS: number;
  wrongOpHeadingHoldS: number;
  sameCodeRateLimitS: number;
  gustGraceS: number;
  wobbleLatSpeedMs: number;
  wobbleFlipCount: number;
  wobbleWindowS: number;
  wobbleLandSlideMs: number;
  roughAccelMs2: number;
  roughHoldS: number;
}

export interface FsmDefaults {
  takeoffAltM: number;
  touchdownAltM: number;
  legReachM: number;
  hover: { radiusM: number; altTolM: number; speedMs: number; holdS: number };
  emergencyHover: { speedMs: number; holdS: number };
  emergencyDelayRangeS: [number, number];
  motorStopHoldS: number;
  /** READY_LAND中の「降下開始」とみなす下降速度 [m/s]（宣言なし降下の検出用） */
  descentStartMs: number;
  /** 指示の名目発話時間 = 文字数 / speechCharsPerS（最短 speechMinS）。発話開始起点の決定的スケジューリング用 */
  speechCharsPerS: number;
  speechMinS: number;
}

export interface DeductionsConfig {
  pass: { startPoints: number; passPoints: number };
  points: Record<DeductCode, number>;
  immediate: readonly FailCode[];
  thresholds: DeductionThresholds;
  fsm: FsmDefaults;
}

const DEDUCT_CODES: readonly DeductCode[] = [
  'ZONE_DEV',
  'WRONG_OP',
  'LAND_BAD',
  'SAFETY',
  'WOBBLE',
  'ROUGH',
  'HEADING',
];

const FAIL_CODES: readonly FailCode[] = ['CRASH', 'SPEED', 'ZONE_FAIL', 'CENTER_MISS', 'TIMEOUT'];

function fail(msg: string): never {
  throw new Error(`deductions.json: ${msg}`);
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} が数値でない`);
  return v;
}

function pos(v: unknown, name: string): number {
  const n = num(v, name);
  if (n <= 0) fail(`${name} は正であること`);
  return n;
}

export function parseDeductionsConfig(raw: unknown): DeductionsConfig {
  if (typeof raw !== 'object' || raw === null) fail('JSONがオブジェクトでない');
  const r = raw as Record<string, unknown>;

  const passRaw = r.pass as Record<string, unknown>;
  const pass = {
    startPoints: pos(passRaw?.startPoints, 'pass.startPoints'),
    passPoints: pos(passRaw?.passPoints, 'pass.passPoints'),
  };
  if (pass.passPoints > pass.startPoints) fail('pass.passPoints ≤ startPoints であること');

  const pointsRaw = r.points as Record<string, unknown>;
  if (typeof pointsRaw !== 'object' || pointsRaw === null) fail('points がない');
  const points = {} as Record<DeductCode, number>;
  for (const code of DEDUCT_CODES) points[code] = pos(pointsRaw[code], `points.${code}`);

  if (!Array.isArray(r.immediate)) fail('immediate が配列でない');
  for (const code of FAIL_CODES) {
    if (!r.immediate.includes(code)) fail(`immediate に ${code} がない`);
  }

  const t = r.thresholds as Record<string, unknown>;
  if (typeof t !== 'object' || t === null) fail('thresholds がない');
  const thresholds: DeductionThresholds = {
    dangerSpeedMs: pos(t.dangerSpeedMs, 'thresholds.dangerSpeedMs'),
    dangerSpeedHoldS: pos(t.dangerSpeedHoldS, 'thresholds.dangerSpeedHoldS'),
    crashDescentMs: pos(t.crashDescentMs, 'thresholds.crashDescentMs'),
    crashTiltDeg: pos(t.crashTiltDeg, 'thresholds.crashTiltDeg'),
    landBadDescentMs: pos(t.landBadDescentMs, 'thresholds.landBadDescentMs'),
    zoneDevRecoveryS: pos(t.zoneDevRecoveryS, 'thresholds.zoneDevRecoveryS'),
    headingErrDeg: pos(t.headingErrDeg, 'thresholds.headingErrDeg'),
    headingHoldS: pos(t.headingHoldS, 'thresholds.headingHoldS'),
    headingGraceS: pos(t.headingGraceS, 'thresholds.headingGraceS'),
    wrongOpAltErrM: pos(t.wrongOpAltErrM, 'thresholds.wrongOpAltErrM'),
    wrongOpAltHoldS: pos(t.wrongOpAltHoldS, 'thresholds.wrongOpAltHoldS'),
    wrongOpHeadingHoldS: pos(t.wrongOpHeadingHoldS, 'thresholds.wrongOpHeadingHoldS'),
    sameCodeRateLimitS: pos(t.sameCodeRateLimitS, 'thresholds.sameCodeRateLimitS'),
    gustGraceS: pos(t.gustGraceS, 'thresholds.gustGraceS'),
    wobbleLatSpeedMs: pos(t.wobbleLatSpeedMs, 'thresholds.wobbleLatSpeedMs'),
    wobbleFlipCount: pos(t.wobbleFlipCount, 'thresholds.wobbleFlipCount'),
    wobbleWindowS: pos(t.wobbleWindowS, 'thresholds.wobbleWindowS'),
    wobbleLandSlideMs: pos(t.wobbleLandSlideMs, 'thresholds.wobbleLandSlideMs'),
    roughAccelMs2: pos(t.roughAccelMs2, 'thresholds.roughAccelMs2'),
    roughHoldS: pos(t.roughHoldS, 'thresholds.roughHoldS'),
  };
  if (thresholds.landBadDescentMs >= thresholds.crashDescentMs) {
    fail('landBadDescentMs < crashDescentMs であること（超過分はCRASHへ昇格）');
  }

  const f = r.fsm as Record<string, unknown>;
  if (typeof f !== 'object' || f === null) fail('fsm がない');
  const hover = f.hover as Record<string, unknown>;
  const eHover = f.emergencyHover as Record<string, unknown>;
  const delay = f.emergencyDelayRangeS;
  if (!Array.isArray(delay) || delay.length !== 2) fail('fsm.emergencyDelayRangeS は [min,max]');
  const fsm: FsmDefaults = {
    takeoffAltM: pos(f.takeoffAltM, 'fsm.takeoffAltM'),
    touchdownAltM: pos(f.touchdownAltM, 'fsm.touchdownAltM'),
    legReachM: pos(f.legReachM, 'fsm.legReachM'),
    hover: {
      radiusM: pos(hover?.radiusM, 'fsm.hover.radiusM'),
      altTolM: pos(hover?.altTolM, 'fsm.hover.altTolM'),
      speedMs: pos(hover?.speedMs, 'fsm.hover.speedMs'),
      holdS: pos(hover?.holdS, 'fsm.hover.holdS'),
    },
    emergencyHover: {
      speedMs: pos(eHover?.speedMs, 'fsm.emergencyHover.speedMs'),
      holdS: pos(eHover?.holdS, 'fsm.emergencyHover.holdS'),
    },
    emergencyDelayRangeS: [
      pos(delay[0], 'fsm.emergencyDelayRangeS[0]'),
      pos(delay[1], 'fsm.emergencyDelayRangeS[1]'),
    ],
    motorStopHoldS: pos(f.motorStopHoldS, 'fsm.motorStopHoldS'),
    descentStartMs: pos(f.descentStartMs, 'fsm.descentStartMs'),
    speechCharsPerS: pos(f.speechCharsPerS, 'fsm.speechCharsPerS'),
    speechMinS: pos(f.speechMinS, 'fsm.speechMinS'),
  };
  if (fsm.emergencyDelayRangeS[0] > fsm.emergencyDelayRangeS[1]) {
    fail('fsm.emergencyDelayRangeS は min ≤ max');
  }
  if (fsm.touchdownAltM >= fsm.takeoffAltM) fail('touchdownAltM < takeoffAltM であること');

  return { pass, points, immediate: FAIL_CODES, thresholds, fsm };
}

/** バンドル済みの既定設定 */
export const DEDUCTIONS: DeductionsConfig = parseDeductionsConfig(rawDeductions);
