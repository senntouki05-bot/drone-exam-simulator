/**
 * exam/Course.ts — コース定義の型・検証・読込（DOM/WebGL/Audio非依存＝実装原則3）。
 *
 * 数値の正本は data/courses/*.json（区画・経路・パイロン・指示列はデータとして定義し、
 * コードは汎用の幾何判定に徹する）。JSONはビルド時にバンドルされる（外部fetchなし）。
 *
 * 座標系マッピング（FlightModel.tsの注記どおりここで行う）:
 *   コース座標: 原点=A・x右・z奥（受験者から見て）
 *   ワールド座標(three.js): y上・受験者はz+側・機体の初期機首方向は-z（奥）
 *   → world.x = course.x ／ world.z = -course.z（x軸は共通・奥行きが反転）
 */

import type { FlightMode } from '../sim/FlightModel';
import type {
  CircleDef,
  CoursePath,
  NamedPoint,
  PylonSet,
  Vec2,
  WindingConfig,
  ZoneBands,
} from './geometry';

import raw41 from '../../data/courses/course-4-1.json';
import raw42 from '../../data/courses/course-4-2.json';
import raw43 from '../../data/courses/course-4-3.json';

/** 試験員指示（M3ではデータとして保持のみ。発話・トリガ駆動はM4のInstructor） */
export interface CourseInstruction {
  id: string;
  /** 表示・発話テキスト（{direction}等のプレースホルダ可） */
  text: string;
  /** 発火条件（typeの解釈はM4のFSM。M3では形だけ検証する） */
  trigger: { type: string } & Record<string, unknown>;
}

export interface Course {
  /** ファイル名由来のID（例: "4-1"） */
  id: string;
  name: string;
  /** 課目の指定モード（4-3のみATTI） */
  flightMode: FlightMode;
  /** 指示高度 [m] */
  altitudeM: number;
  /** 制限時間 [s]（離陸指示の発話開始→接地） */
  timeLimitS: number;
  /** 受験者立ち位置（コース座標）と目線高 */
  pilot: { x: number; z: number; eyeHeightM: number };
  /** 離着陸地点Hの中心（コース座標。半径は geometry.H_PAD_RADIUS の1定数のみ） */
  h: Vec2;
  zoneBands: ZoneBands;
  path: CoursePath;
  pylons: PylonSet;
  /** 地上マーカー（描画用。4-3のE/A/B等・衝突判定なし） */
  groundMarkers: NamedPoint[];
  /** 巻き数判定の設定（4-2のみ・他はnull） */
  winding: WindingConfig | null;
  /** 8の字の必要周回数（4-2=2） */
  windingLaps: number;
  instructions: CourseInstruction[];
}

// ---------------------------------------------------------------------------
// 座標マッピング
// ---------------------------------------------------------------------------

/** コース座標→ワールド座標（結果はoutへ書く: 毎フレーム呼び出しでのアロケーション回避） */
export function courseToWorld(cx: number, cz: number, out: { x: number; z: number }): void {
  out.x = cx;
  out.z = -cz;
}

/** ワールド座標→コース座標（結果はoutへ書く） */
export function worldToCourse(wx: number, wz: number, out: { x: number; z: number }): void {
  out.x = wx;
  out.z = -wz;
}

// ---------------------------------------------------------------------------
// パース・検証（壊れたコース定義は起動時に即座に失敗させる）
// ---------------------------------------------------------------------------

function fail(id: string, msg: string): never {
  throw new Error(`コース定義 ${id}: ${msg}`);
}

function asNumber(id: string, v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(id, `${name} が数値でない`);
  return v;
}

function asVec2(id: string, v: unknown, name: string): Vec2 {
  const r = v as Record<string, unknown>;
  if (typeof r !== 'object' || r === null) fail(id, `${name} がオブジェクトでない`);
  return { x: asNumber(id, r.x, `${name}.x`), z: asNumber(id, r.z, `${name}.z`) };
}

function asNamedPoint(id: string, v: unknown, name: string): NamedPoint {
  const r = v as Record<string, unknown>;
  const p = asVec2(id, v, name);
  if (typeof r.id !== 'string' || r.id.length === 0) fail(id, `${name}.id がない`);
  return { id: r.id, ...p };
}

function parsePath(id: string, raw: unknown): CoursePath {
  const r = raw as Record<string, unknown>;
  if (typeof r !== 'object' || r === null) fail(id, 'path がオブジェクトでない');
  if (r.kind === 'polygon') {
    const pts = r.points;
    if (!Array.isArray(pts) || pts.length < 3) fail(id, 'polygon は3点以上であること');
    return {
      kind: 'polygon',
      points: pts.map((p, i) => asNamedPoint(id, p, `path.points[${i}]`)),
    };
  }
  if (r.kind === 'circles') {
    const cs = r.circles;
    if (!Array.isArray(cs) || cs.length === 0) fail(id, 'circles が空');
    const circles: CircleDef[] = cs.map((c, i) => {
      const cr = c as Record<string, unknown>;
      if (typeof cr.id !== 'string' || cr.id.length === 0) fail(id, `circles[${i}].id がない`);
      const radiusM = asNumber(id, cr.radiusM, `circles[${i}].radiusM`);
      if (radiusM <= 0) fail(id, `circles[${i}].radiusM は正であること`);
      return { id: cr.id, center: asVec2(id, cr.center, `circles[${i}].center`), radiusM };
    });
    return { kind: 'circles', circles };
  }
  if (r.kind === 'corridor') {
    const from = asNamedPoint(id, r.from, 'path.from');
    const to = asNamedPoint(id, r.to, 'path.to');
    if (Math.hypot(to.x - from.x, to.z - from.z) === 0) fail(id, 'corridor の from と to が同一点');
    return { kind: 'corridor', from, to };
  }
  return fail(id, `path.kind が不明: ${String(r.kind)}`);
}

export function parseCourse(id: string, raw: unknown): Course {
  if (typeof raw !== 'object' || raw === null) fail(id, 'JSONがオブジェクトでない');
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== 'string' || r.name.length === 0) fail(id, 'name がない');
  if (r.flightMode !== 'gps' && r.flightMode !== 'atti') fail(id, 'flightMode は gps|atti');
  const altitudeM = asNumber(id, r.altitudeM, 'altitudeM');
  const timeLimitS = asNumber(id, r.timeLimitS, 'timeLimitS');
  if (altitudeM <= 0 || timeLimitS <= 0) fail(id, 'altitudeM/timeLimitS は正であること');

  const pilotRaw = r.pilot as Record<string, unknown>;
  const pilotV = asVec2(id, r.pilot, 'pilot');
  const eyeHeightM = asNumber(id, pilotRaw.eyeHeightM, 'pilot.eyeHeightM');
  if (eyeHeightM <= 0) fail(id, 'pilot.eyeHeightM は正であること');

  const h = asVec2(id, r.h, 'h');

  const bandsRaw = r.zoneBands as Record<string, unknown>;
  if (typeof bandsRaw !== 'object' || bandsRaw === null) fail(id, 'zoneBands がない');
  const zoneBands: ZoneBands = {
    freeM: asNumber(id, bandsRaw.freeM, 'zoneBands.freeM'),
    deductM: asNumber(id, bandsRaw.deductM, 'zoneBands.deductM'),
  };
  if (!(zoneBands.freeM > 0 && zoneBands.deductM > zoneBands.freeM)) {
    fail(id, 'zoneBands は 0 < freeM < deductM であること');
  }

  const path = parsePath(id, r.path);

  const pyRaw = r.pylons as Record<string, unknown>;
  if (typeof pyRaw !== 'object' || pyRaw === null) fail(id, 'pylons がない');
  if (!Array.isArray(pyRaw.positions)) fail(id, 'pylons.positions が配列でない');
  const pylons: PylonSet = {
    heightM: asNumber(id, pyRaw.heightM, 'pylons.heightM'),
    radiusM: asNumber(id, pyRaw.radiusM, 'pylons.radiusM'),
    positions: pyRaw.positions.map((p, i) => asVec2(id, p, `pylons.positions[${i}]`)),
  };
  if (pylons.heightM <= 0 || pylons.radiusM <= 0) {
    fail(id, 'pylons.heightM/radiusM は正であること');
  }

  const groundMarkers = Array.isArray(r.groundMarkers)
    ? r.groundMarkers.map((p, i) => asNamedPoint(id, p, `groundMarkers[${i}]`))
    : [];

  // winding（circles経路では必須・他の経路では持ってはいけない）
  let winding: WindingConfig | null = null;
  let windingLaps = 0;
  if (path.kind === 'circles') {
    const wRaw = r.winding as Record<string, unknown>;
    if (typeof wRaw !== 'object' || wRaw === null) fail(id, 'circles経路には winding が必須');
    winding = {
      circles: path.circles,
      hCenter: h,
      minSampleRadiusM: asNumber(id, wRaw.minSampleRadiusM, 'winding.minSampleRadiusM'),
      switchHysteresisM: asNumber(id, wRaw.switchHysteresisM, 'winding.switchHysteresisM'),
      fullTurnToleranceRad: asNumber(id, wRaw.fullTurnToleranceRad, 'winding.fullTurnToleranceRad'),
    };
    if (
      winding.minSampleRadiusM <= 0 ||
      winding.switchHysteresisM <= 0 ||
      winding.fullTurnToleranceRad < 0
    ) {
      fail(id, 'winding のパラメータが不正');
    }
    windingLaps = asNumber(id, wRaw.laps, 'winding.laps');
    if (!Number.isInteger(windingLaps) || windingLaps < 1) {
      fail(id, 'winding.laps は1以上の整数であること');
    }
  } else if (r.winding !== undefined) {
    fail(id, 'winding は circles 経路でのみ指定できる');
  }

  if (!Array.isArray(r.instructions) || r.instructions.length === 0) {
    fail(id, 'instructions が空');
  }
  const seenIds = new Set<string>();
  const instructions: CourseInstruction[] = r.instructions.map((v, i) => {
    const ir = v as Record<string, unknown>;
    if (typeof ir !== 'object' || ir === null) fail(id, `instructions[${i}] が不正`);
    if (typeof ir.id !== 'string' || ir.id.length === 0) fail(id, `instructions[${i}].id がない`);
    if (typeof ir.text !== 'string' || ir.text.length === 0) {
      fail(id, `instructions[${i}].text がない`);
    }
    const tr = ir.trigger as Record<string, unknown>;
    if (typeof tr !== 'object' || tr === null || typeof tr.type !== 'string') {
      fail(id, `instructions[${i}].trigger.type がない`);
    }
    if (seenIds.has(ir.id)) fail(id, `instructions のidが重複: ${ir.id}`);
    seenIds.add(ir.id);
    return { id: ir.id, text: ir.text, trigger: tr as CourseInstruction['trigger'] };
  });

  return {
    id,
    name: r.name,
    flightMode: r.flightMode,
    altitudeM,
    timeLimitS,
    pilot: { x: pilotV.x, z: pilotV.z, eyeHeightM },
    h,
    zoneBands,
    path,
    pylons,
    groundMarkers,
    winding,
    windingLaps,
    instructions,
  };
}

/** バンドル済みの全課目（試験モードの通し順=4-1→4-2→4-3） */
export const COURSES: readonly Course[] = [
  parseCourse('4-1', raw41),
  parseCourse('4-2', raw42),
  parseCourse('4-3', raw43),
];
