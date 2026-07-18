/**
 * exam/trajectoryHelpers.ts — 受験テスト用の合成軌道ジェネレータ（テスト専用・物理は通さない）。
 *
 * コース座標で解析的に軌道を組み立て、ワールド座標のExamSample列＋イベント列を生成する。
 * 位置・高度・角度はsmoothstep補間（速度が連続・|a|max=6d/T²）にして、理想軌道が
 * ROUGH（急加減速）を誤検出しないようにする。機首はヨーのみ（ピッチ/ロール=0）。
 *
 * 時間軸: ビルダーのtをそのままstep()のtSimに使う（セッションは初回stepをt0にする）。
 */

import type { FlightMode, Quat } from '../sim/FlightModel';
import type { Course } from './Course';
import type { DeductionsConfig } from './DeductionsConfig';
import type { ExamEvent, ExamResult, ExamSample, ExamSession } from './ExamSession';

/** 指示の名目発話時間（ExamSessionのafter_instructionスケジューリングと同じ式） */
export function nominalSpeechS(text: string, cfg: DeductionsConfig): number {
  return Math.max(cfg.fsm.speechMinS, text.length / cfg.fsm.speechCharsPerS);
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}

/** smoothstepの微分（du基準）: 6u(1-u) */
function smoothD(u: number): number {
  return 6 * u * (1 - u);
}

function wrapPi(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

interface TimedSample {
  t: number;
  sample: ExamSample;
}

export class TrajectoryBuilder {
  readonly samples: TimedSample[] = [];
  readonly events: ExamEvent[] = [];
  t = 0;

  private x: number;
  private z: number;
  private alt = 0;
  private heading = 0;
  private readonly dt: number;
  private readonly mode: FlightMode;

  constructor(course: Course, opts?: { dt?: number }) {
    this.x = course.h.x;
    this.z = course.h.z;
    this.dt = opts?.dt ?? 0.02;
    this.mode = course.flightMode;
    this.push(0, 0, 0);
  }

  /** 現時刻で安全確認の宣言イベントを積む */
  declare(): this {
    this.events.push({ t: this.t, type: 'declare' });
    return this;
  }

  wait(dur: number): this {
    return this.op(dur, () => ({ vx: 0, vz: 0, vy: 0 }));
  }

  ascendTo(target: number, dur: number): this {
    const from = this.alt;
    const d = target - from;
    return this.op(dur, (u) => {
      this.alt = from + d * smooth(u);
      return { vx: 0, vz: 0, vy: (d * smoothD(u)) / dur };
    });
  }

  descendTo(target: number, dur: number): this {
    return this.ascendTo(target, dur);
  }

  /** その場でヨー旋回（最短経路） */
  turnTo(target: number, dur: number): this {
    const from = this.heading;
    const d = wrapPi(target - from);
    return this.op(dur, (u) => {
      this.heading = from + d * smooth(u);
      return { vx: 0, vz: 0, vy: 0 };
    });
  }

  /** 水平移動（機首・高度は維持） */
  moveTo(tx: number, tz: number, dur: number): this {
    const fx = this.x;
    const fz = this.z;
    const dx = tx - fx;
    const dz = tz - fz;
    return this.op(dur, (u) => {
      this.x = fx + dx * smooth(u);
      this.z = fz + dz * smooth(u);
      const k = smoothD(u) / dur;
      return { vx: dx * k, vz: dz * k, vy: 0 };
    });
  }

  /** 円弧移動（8の字用）。機首=接線方向（進行方向）・高度維持 */
  arc(cx: number, cz: number, r: number, fromRad: number, toRad: number, dur: number): this {
    const dTheta = toRad - fromRad;
    const sgn = Math.sign(dTheta);
    return this.op(dur, (u) => {
      const theta = fromRad + dTheta * smooth(u);
      this.x = cx + r * Math.cos(theta);
      this.z = cz + r * Math.sin(theta);
      this.heading = Math.atan2(-Math.sin(theta) * sgn, Math.cos(theta) * sgn);
      const omega = (dTheta * smoothD(u)) / dur;
      return { vx: -Math.sin(theta) * r * omega, vz: Math.cos(theta) * r * omega, vy: 0 };
    });
  }

  /** 全サンプルをセッションへ流す（イベントは発生時刻のステップで渡す） */
  run(session: ExamSession): ExamResult | null {
    let ei = 0;
    const buf: ExamEvent[] = [];
    for (const { t, sample } of this.samples) {
      buf.length = 0;
      while (ei < this.events.length && this.events[ei].t <= t) buf.push(this.events[ei++]);
      session.step(t, sample, buf);
      if (session.finished) break;
    }
    return session.result;
  }

  // --- 内部 ---

  private op(
    dur: number,
    fn: (u: number) => { vx: number; vz: number; vy: number },
  ): this {
    const steps = Math.max(1, Math.round(dur / this.dt));
    const stepDt = dur / steps;
    for (let i = 1; i <= steps; i++) {
      const v = fn(i / steps);
      this.t += stepDt;
      this.push(v.vx, v.vz, v.vy);
    }
    return this;
  }

  private push(vx: number, vz: number, vy: number): void {
    const yaw = -this.heading; // コース方位→ワールドヨー
    const q: Quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    this.samples.push({
      t: this.t,
      sample: {
        p: { x: this.x, y: this.alt, z: -this.z },
        v: { x: vx, y: vy, z: -vz },
        q,
        mode: this.mode,
      },
    });
  }
}
