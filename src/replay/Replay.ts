/**
 * replay/Replay.ts — リプレイの記録・シリアライズ・再生（DOM・WebGL・Audio非依存）。
 *
 * 何を: シム軌道（t, p, q, mode）を20Hzへダウンサンプルしてメモリ記録し、減点イベントと
 * まとめて {version, machineId, courseId, samples, events} としてJSONエクスポート/インポート、
 * および任意時刻の補間再生（ReplayPlayer）を提供する。
 *
 * なぜ: 練習モードのリプレイ機能（CLAUDE-CODE-PROMPT.md「描画・UI」節）。物理は240Hzだが
 * 再生・保存には20Hzで十分であり、10秒あたり200サンプルに抑えてメモリとJSONサイズを節約する。
 * 再生側は位置=線形補間・姿勢=nlerp（符号合わせ付き正規化線形補間）で滑らかに復元する。
 *
 * 設計メモ:
 * - record() は p/q を**コピーして**格納する（呼び出し側の使い回しオブジェクトに依存しない）。
 * - parseReplay() は外部入力（インポートJSON）を信用せず、version不一致・欠損・非有限数値を
 *   日本語メッセージのErrorで拒否し、検証済みの値だけで新しいオブジェクトを組み立てる。
 * - ReplayPlayer.sampleAt() は毎フレーム呼ばれる想定のためアロケーションなし（outへ書き込み）。
 */

import type { FlightMode, Quat, Vec3 } from '../sim/FlightModel';
import type { DeductionEvent } from '../exam/ScoringEngine';

export interface ReplaySample {
  /** シム時間 [s] */
  t: number;
  /** 位置（ワールド座標） */
  p: Vec3;
  /** 姿勢クォータニオン */
  q: Quat;
  /** 飛行モード（GPS/ATTI） */
  mode: FlightMode;
}

export interface ReplayRecording {
  version: 1;
  machineId: string;
  courseId: string;
  samples: ReplaySample[];
  events: DeductionEvent[];
}

/** 記録サンプリング周波数 [Hz]（物理240Hzからの間引き先） */
export const REPLAY_HZ = 20;

/** 間引き間隔 [s] */
const SAMPLE_INTERVAL_S = 1 / REPLAY_HZ;

/** 浮動小数の累積誤差で「ちょうど0.05s刻み」を取りこぼさないための許容誤差 [s] */
const INTERVAL_EPS_S = 1e-9;

/**
 * リプレイ記録器。シム時間tの単調増加を前提に、20Hz間隔を満たしたサンプルのみ保持する。
 * 先頭サンプル（最初のrecord呼び出し）は必ず記録する。
 */
export class ReplayRecorder {
  private readonly machineId: string;
  private readonly courseId: string;
  private readonly samples: ReplaySample[] = [];
  private readonly events: DeductionEvent[] = [];
  /** 最後に採用したサンプルのt（未記録なら-Infinityで先頭を必ず通す） */
  private lastKeptT = -Infinity;

  constructor(machineId: string, courseId: string) {
    this.machineId = machineId;
    this.courseId = courseId;
  }

  /** シム時間tのサンプル（20Hzへ間引き。t単調増加前提。p/qはコピーして格納） */
  record(t: number, p: Readonly<Vec3>, q: Readonly<Quat>, mode: FlightMode): void {
    if (t - this.lastKeptT < SAMPLE_INTERVAL_S - INTERVAL_EPS_S) return;
    this.lastKeptT = t;
    this.samples.push({
      t,
      p: { x: p.x, y: p.y, z: p.z },
      q: { x: q.x, y: q.y, z: q.z, w: q.w },
      mode,
    });
  }

  /** 減点イベントを追加（間引きせず全件保持） */
  addEvent(d: DeductionEvent): void {
    this.events.push(d);
  }

  /** スナップショットを返す（配列はコピー。以後の記録は返り値へ影響しない） */
  finish(): ReplayRecording {
    return {
      version: 1,
      machineId: this.machineId,
      courseId: this.courseId,
      samples: this.samples.slice(),
      events: this.events.slice(),
    };
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

/** リプレイをJSON文字列へシリアライズ（エクスポート用） */
export function serializeReplay(r: ReplayRecording): string {
  return JSON.stringify(r);
}

/** 有限数値でなければthrow（NaN/Infinity/型違いを拒否） */
function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`リプレイデータが不正です: ${label} が有限の数値ではありません`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`リプレイデータが不正です: ${label} が文字列ではありません`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`リプレイデータが不正です: ${label} がオブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`リプレイデータが不正です: ${label} が配列ではありません（欠損の可能性）`);
  }
  return value;
}

function parseMode(value: unknown, label: string): FlightMode {
  if (value !== 'gps' && value !== 'atti') {
    throw new Error(`リプレイデータが不正です: ${label} は 'gps' か 'atti' である必要があります`);
  }
  return value;
}

function parseSample(raw: unknown, index: number): ReplaySample {
  const s = requireRecord(raw, `samples[${index}]`);
  const p = requireRecord(s.p, `samples[${index}].p`);
  const q = requireRecord(s.q, `samples[${index}].q`);
  return {
    t: requireFinite(s.t, `samples[${index}].t`),
    p: {
      x: requireFinite(p.x, `samples[${index}].p.x`),
      y: requireFinite(p.y, `samples[${index}].p.y`),
      z: requireFinite(p.z, `samples[${index}].p.z`),
    },
    q: {
      x: requireFinite(q.x, `samples[${index}].q.x`),
      y: requireFinite(q.y, `samples[${index}].q.y`),
      z: requireFinite(q.z, `samples[${index}].q.z`),
      w: requireFinite(q.w, `samples[${index}].q.w`),
    },
    mode: parseMode(s.mode, `samples[${index}].mode`),
  };
}

function parseEvent(raw: unknown, index: number): DeductionEvent {
  const e = requireRecord(raw, `events[${index}]`);
  const pos = requireRecord(e.pos, `events[${index}].pos`);
  if (typeof e.immediate !== 'boolean') {
    throw new Error(`リプレイデータが不正です: events[${index}].immediate が真偽値ではありません`);
  }
  const ev: DeductionEvent = {
    t: requireFinite(e.t, `events[${index}].t`),
    // コード・フェーズの列挙値までは検証しない（減点表・フェーズ定義の増減にリプレイ形式を追従させない）
    code: requireString(e.code, `events[${index}].code`) as DeductionEvent['code'],
    points: requireFinite(e.points, `events[${index}].points`),
    immediate: e.immediate,
    reason: requireString(e.reason, `events[${index}].reason`),
    pos: {
      x: requireFinite(pos.x, `events[${index}].pos.x`),
      z: requireFinite(pos.z, `events[${index}].pos.z`),
    },
    phase: requireString(e.phase, `events[${index}].phase`) as DeductionEvent['phase'],
  };
  if (e.zoneId !== undefined) {
    ev.zoneId = requireString(e.zoneId, `events[${index}].zoneId`);
  }
  return ev;
}

/** 不正データは日本語メッセージのErrorをthrow（version不一致・欠損・非有限数値） */
export function parseReplay(json: string): ReplayRecording {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('リプレイデータが不正です: JSONとして解釈できません');
  }
  const root = requireRecord(raw, 'ルート');
  if (root.version !== 1) {
    throw new Error(`リプレイデータのversionが不正です（対応: 1・入力: ${String(root.version)}）`);
  }
  return {
    version: 1,
    machineId: requireString(root.machineId, 'machineId'),
    courseId: requireString(root.courseId, 'courseId'),
    samples: requireArray(root.samples, 'samples').map(parseSample),
    events: requireArray(root.events, 'events').map(parseEvent),
  };
}

/**
 * リプレイ再生器。sampleAt()で任意の再生時刻の状態を補間復元する。
 * - 位置: 線形補間
 * - 姿勢: nlerp（正規化線形補間。qと-qは同一回転のため、内積が負なら片方を反転して最短経路にする）
 * - mode: 直近過去サンプルの値（補間しない）
 */
export class ReplayPlayer {
  private readonly samples: readonly ReplaySample[];

  constructor(rec: ReplayRecording) {
    if (rec.samples.length === 0) {
      throw new Error('リプレイを再生できません: サンプルが空です');
    }
    this.samples = rec.samples;
  }

  /** 先頭サンプルのシム時間 [s] */
  get startT(): number {
    return this.samples[0].t;
  }

  /** 記録の長さ [s]（先頭〜末尾サンプル間） */
  get durationS(): number {
    return this.samples[this.samples.length - 1].t - this.samples[0].t;
  }

  /**
   * 再生時刻t（startT基準の絶対t）のサンプルを補間してoutへ書く（アロケーションなし）。
   * 範囲外（先頭より前・末尾より後）は端のサンプルへクランプする。
   */
  sampleAt(t: number, out: { p: Vec3; q: Quat; mode: FlightMode }): void {
    const samples = this.samples;
    const n = samples.length;
    if (t <= samples[0].t) {
      copySample(samples[0], out);
      return;
    }
    if (t >= samples[n - 1].t) {
      copySample(samples[n - 1], out);
      return;
    }
    // 二分探索: samples[lo].t <= t < samples[lo+1].t となるloを求める
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[lo + 1];
    const span = b.t - a.t;
    // 同時刻の重複サンプルは後勝ち（span=0での0除算を避ける）
    const f = span > 0 ? (t - a.t) / span : 1;

    // 位置: 線形補間
    out.p.x = a.p.x + (b.p.x - a.p.x) * f;
    out.p.y = a.p.y + (b.p.y - a.p.y) * f;
    out.p.z = a.p.z + (b.p.z - a.p.z) * f;

    // 姿勢: nlerp（内積が負なら片方を反転して最短経路で補間）
    const dot = a.q.x * b.q.x + a.q.y * b.q.y + a.q.z * b.q.z + a.q.w * b.q.w;
    const sign = dot < 0 ? -1 : 1;
    let qx = a.q.x + (sign * b.q.x - a.q.x) * f;
    let qy = a.q.y + (sign * b.q.y - a.q.y) * f;
    let qz = a.q.z + (sign * b.q.z - a.q.z) * f;
    let qw = a.q.w + (sign * b.q.w - a.q.w) * f;
    const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (len > 1e-9) {
      const inv = 1 / len;
      qx *= inv;
      qy *= inv;
      qz *= inv;
      qw *= inv;
    } else {
      // ほぼ反対称の異常ケース（正規記録では起こらない）: 過去サンプル側の姿勢を採用
      qx = a.q.x;
      qy = a.q.y;
      qz = a.q.z;
      qw = a.q.w;
    }
    out.q.x = qx;
    out.q.y = qy;
    out.q.z = qz;
    out.q.w = qw;

    // mode: 直近過去サンプル（区間の始点側）
    out.mode = a.mode;
  }
}

/** サンプルの値をoutへコピー（アロケーションなし） */
function copySample(s: ReplaySample, out: { p: Vec3; q: Quat; mode: FlightMode }): void {
  out.p.x = s.p.x;
  out.p.y = s.p.y;
  out.p.z = s.p.z;
  out.q.x = s.q.x;
  out.q.y = s.q.y;
  out.q.z = s.q.z;
  out.q.w = s.q.w;
  out.mode = s.mode;
}
