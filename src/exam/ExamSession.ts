/**
 * exam/ExamSession.ts — 受験セッション（課目FSM×採点×試験員指示のヘッドレス統合）。
 *
 * 実装原則3: DOM・WebGL・Audio系APIを一切importしない純粋モジュール。
 * 公開APIは step(tSim, {p, v, q, mode}, events)。発話・警告音・乱数・タイミングは
 * コンストラクタ注入し、UIへはコールバック（onInstruction等）で通知する。
 *
 * 実装原則4: 試験員指示は**シム時間における発話開始時刻**に有効化する。FSM遷移・判定窓・
 * 制限時間の起点はすべて発話開始時刻で、TTSの完了は待たない。連鎖指示（after_instruction）の
 * 開始時刻は「前指示の発話開始 + 名目発話時間(文字数/speechCharsPerS)」で決定的に決まるため、
 * テストスタブと本番で判定タイミングが一致する。
 *
 * フェーズ遷移は採点より先に適用する（例: H円進入でh_aboveへ切り替わった同一サンプルは
 * 新フェーズのゲーティングで判定＝「正しい進入は不合格判定に当たらない」を成立させる）。
 */

import type { FlightMode, Quat, Vec3 } from '../sim/FlightModel';
import type { Course, CourseInstruction } from './Course';
import { worldToCourse } from './Course';
import {
  H_PAD_RADIUS,
  WindingTracker,
  createZoneResult,
  evalZone,
  inHCircle,
  pylonCollisionIndex,
  type CircleDef,
  type Vec2,
} from './geometry';
import { DEDUCTIONS, type DeductionsConfig, type FailCode } from './DeductionsConfig';
import { gatingFor, type PhaseId } from './phases';
import {
  ScoringEngine,
  type DeductionEvent,
  type ExamWarning,
  type StepContext,
} from './ScoringEngine';
import { angleDiff, headingFromQuat, tiltFromQuat } from './attitude';

export interface ExamSample {
  p: Readonly<Vec3>;
  v: Readonly<Vec3>;
  q: Readonly<Quat>;
  mode: FlightMode;
}

export type ExamEventType = 'declare' | 'gust_start' | 'gust_end';

export interface ExamEvent {
  /** シム時間（step()のtSimと同じ時間軸） */
  t: number;
  type: ExamEventType;
  payload?: unknown;
}

/** UIへ通知する指示（tは課目開始からの相対秒=発話開始時刻） */
export interface ActiveInstruction {
  id: string;
  text: string;
  t: number;
}

/** 周回方向: standard=4-1反時計/4-2左円反時計・右円時計/4-3先にE側 */
export type ExamDirection = 'standard' | 'reverse' | 'random';

export type EndReason = 'completed' | 'immediate_fail' | 'points_exhausted' | 'aborted';

export interface ExamResult {
  courseId: string;
  courseName: string;
  passed: boolean;
  points: number;
  failCode: FailCode | null;
  endReason: EndReason;
  deductions: DeductionEvent[];
  /** 離陸指示（発話開始）→接地の実測秒 */
  elapsedS: number;
  timeLimitS: number;
  direction: 'standard' | 'reverse';
  /** 上面図レポート用の軌跡（コース座標・約10Hz） */
  track: Array<{ t: number; x: number; z: number; alt: number }>;
}

export interface ExamSessionOptions {
  course: Course;
  /** 機体半径 [m]（パイロン衝突判定用・MachineProfile.radiusM） */
  machineRadiusM: number;
  config?: DeductionsConfig;
  /** 注入乱数 [0,1)（緊急事態タイミング・方向random用）。省略時は固定0.5=決定的 */
  random?: () => number;
  direction?: ExamDirection;
  /** 試験モード通しの持ち点持ち越し（省略時はconfig.pass.startPoints=100） */
  startPoints?: number;
  onInstruction?: (i: ActiveInstruction) => void;
  onWarning?: (w: ExamWarning) => void;
  onDeduction?: (d: DeductionEvent) => void;
  onFinished?: (r: ExamResult) => void;
}

const TRACK_INTERVAL_S = 0.1;

export class ExamSession {
  private readonly course: Course;
  private readonly cfg: DeductionsConfig;
  private readonly machineRadiusM: number;
  private readonly rng: () => number;
  private readonly opts: ExamSessionOptions;
  private readonly engine: ScoringEngine;
  readonly direction: 'standard' | 'reverse';

  private t0: number | null = null;
  private prevRel = 0;
  private readonly prevV = { x: 0, y: 0, z: 0 };
  private prevAlt = 0;
  private started = false;

  phase: PhaseId = 'preflight';
  private legKey = 'preflight';

  // 指示
  private readonly activatedIds = new Set<string>();
  private readonly scheduled: Array<{ at: number; instr: CourseInstruction }> = [];
  private takeoffInstrRel: number | null = null;
  private examStartRel: number | null = null;

  // 宣言・突風
  private lastDeclareRel = -Infinity;
  private gustActive = false;
  private gustGraceUntil = -Infinity;

  // ホバ・接地・モーター停止
  private hoverHoldT = 0;
  private touchedDownRel: number | null = null;
  private groundHoldT = 0;
  private hAboveEntryRel = 0;
  private safetyLandChecked = false;

  // 機首目標
  private headingTargetRad: number | null = null;
  private headingChangedAt = 0;
  private travelDirRad = 0; // transit/lap用の固定進行方位

  // 4-1 周回
  private lapSeq: Array<{ id: string; x: number; z: number }> = [];
  private lapIdx = 0;

  // 4-2 巻き数
  private tracker: WindingTracker | null = null;
  private segIndex = 0;
  private segDone = 0;
  private lapDone = false;
  private readonly expectedSign = new Map<string, number>();

  // 4-3 往復・緊急
  private shuttleTarget: { id: string; x: number; z: number } | null = null;
  private shuttleLeg = 0;
  private shuttleTouches = 0;
  private emergencyAtRel: number | null = null;

  // 使い回しバッファ
  private readonly zoneScratch = createZoneResult();
  private readonly courseXZ = { x: 0, z: 0 };
  private readonly ctx: StepContext;

  private readonly track: ExamResult['track'] = [];
  private lastTrackRel = -Infinity;

  finished = false;
  result: ExamResult | null = null;

  constructor(opts: ExamSessionOptions) {
    this.course = opts.course;
    this.cfg = opts.config ?? DEDUCTIONS;
    this.machineRadiusM = opts.machineRadiusM;
    this.rng = opts.random ?? (() => 0.5);
    this.opts = opts;
    const dir = opts.direction ?? 'random';
    this.direction = dir === 'random' ? (this.rng() < 0.5 ? 'standard' : 'reverse') : dir;
    this.engine = new ScoringEngine(this.cfg, opts.startPoints ?? this.cfg.pass.startPoints, {
      onDeduction: (d) => opts.onDeduction?.(d),
      onWarning: (w) => opts.onWarning?.(w),
    });
    if (this.course.winding) {
      this.tracker = new WindingTracker(this.course.winding);
      // 基準: 左円(中心xがHより小)=反時計(+)・右円=時計(−)。reverseは反転
      for (const c of this.course.winding.circles) {
        const isLeft = c.center.x < this.course.h.x;
        const sign = isLeft === (this.direction === 'standard') ? 1 : -1;
        this.expectedSign.set(c.id, sign);
      }
    }
    this.ctx = {
      t: 0,
      dt: 0,
      phase: 'preflight',
      gating: gatingFor(this.course.path.kind, 'preflight'),
      legKey: 'preflight',
      zone: this.zoneScratch,
      inH: true,
      posX: 0,
      posZ: 0,
      altM: 0,
      speed3dMs: 0,
      headingRad: 0,
      headingTargetRad: null,
      headingChangedAt: 0,
      altTargetM: null,
      latSpeedMs: 0,
      accelMs2: 0,
      gustSuppressed: false,
    };
  }

  get points(): number {
    return this.engine.points;
  }

  /** 制限時間の経過秒（離陸指示の発話開始→現在。開始前はnull・接地後は確定値）。HUD表示用 */
  get examElapsedS(): number | null {
    if (this.examStartRel === null) return null;
    return (this.touchedDownRel ?? this.prevRel) - this.examStartRel;
  }

  /** 課目の制限時間 [s]（HUD表示用） */
  get timeLimitS(): number {
    return this.course.timeLimitS;
  }

  /** UIの中止操作（結果は不合格・aborted扱い） */
  abort(): void {
    if (!this.finished) this.finish('aborted');
  }

  step(tSim: number, sample: ExamSample, events: readonly ExamEvent[]): void {
    if (this.finished) return;

    if (this.t0 === null) {
      this.t0 = tSim;
      this.activate('session_start');
    }
    const rel = tSim - this.t0;
    const dt = rel - this.prevRel;

    // --- イベント処理（宣言・突風） ---
    for (const ev of events) {
      const evRel = ev.t - this.t0;
      if (ev.type === 'declare') {
        this.lastDeclareRel = evRel;
      } else if (ev.type === 'gust_start') {
        this.gustActive = true;
      } else if (ev.type === 'gust_end') {
        this.gustActive = false;
        this.gustGraceUntil = evRel + this.cfg.thresholds.gustGraceS;
      }
    }

    // --- スケジュール済み指示（after_instruction連鎖）の発話開始 ---
    while (this.scheduled.length > 0 && this.scheduled[0].at <= rel) {
      const next = this.scheduled.shift()!;
      this.fire(next.instr, next.at);
    }

    // --- サンプル変換 ---
    worldToCourse(sample.p.x, sample.p.z, this.courseXZ);
    const cx = this.courseXZ.x;
    const cz = this.courseXZ.z;
    const alt = sample.p.y;
    const vy = sample.v.y;
    const speed3d = Math.hypot(sample.v.x, sample.v.y, sample.v.z);
    const heading = headingFromQuat(sample.q);
    const inH = inHCircle(cx, cz, this.course.h);
    evalZone(this.course.path, this.course.zoneBands, cx, cz, this.zoneScratch);

    if (!this.started) {
      // 初回サンプル: 基準を記録するだけ（dt=0で判定しない）
      this.started = true;
      this.prevRel = rel;
      this.prevV.x = sample.v.x;
      this.prevV.y = sample.v.y;
      this.prevV.z = sample.v.z;
      this.prevAlt = alt;
      this.recordTrack(rel, cx, cz, alt);
      return;
    }
    if (dt <= 0) return;

    const accel =
      Math.hypot(sample.v.x - this.prevV.x, sample.v.y - this.prevV.y, sample.v.z - this.prevV.z) /
      dt;
    // 接地判定用: 直前サンプル（最後の空中サンプル）の下降・水平速度（接地後は物理側で0になるため）
    const prevDescent = Math.max(0, -this.prevV.y);
    const prevHoriz = Math.hypot(this.prevV.x, this.prevV.z);
    const prevAlt = this.prevAlt;
    this.prevRel = rel;
    this.prevV.x = sample.v.x;
    this.prevV.y = sample.v.y;
    this.prevV.z = sample.v.z;
    this.prevAlt = alt;

    // --- パイロン衝突（CRASH・全フェーズ共通） ---
    const pylonIdx = pylonCollisionIndex(cx, cz, alt, this.machineRadiusM, this.course.pylons);
    if (pylonIdx >= 0) {
      this.engine.failNow('CRASH', rel, `パイロンに衝突（#${pylonIdx + 1}）`, {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
      this.finish('immediate_fail');
      return;
    }

    // --- 制限時間（離陸指示の発話開始→接地） ---
    if (
      this.examStartRel !== null &&
      this.touchedDownRel === null &&
      rel - this.examStartRel > this.course.timeLimitS
    ) {
      this.engine.failNow('TIMEOUT', rel, '制限時間超過', { posX: cx, posZ: cz, phase: this.phase });
      this.finish('immediate_fail');
      return;
    }

    // --- 接地検出（フェーズ別の離散判定） ---
    const touchdown =
      prevAlt > this.cfg.fsm.touchdownAltM && alt <= this.cfg.fsm.touchdownAltM && vy <= 0;
    if (touchdown && this.phase !== 'preflight' && this.phase !== 'ground') {
      this.handleTouchdown(rel, cx, cz, inH, prevDescent, prevHoriz, sample.q);
      if (this.finished) return;
    }

    // --- フェーズ遷移（採点より先に適用） ---
    this.fsmStep(rel, dt, cx, cz, alt, vy, speed3d, inH);
    if (this.finished) return;

    // --- 採点 ---
    const gating = gatingFor(this.course.path.kind, this.phase);
    let target = this.headingTargetRad;
    if (gating.heading === 'travel' && this.phase === 'work' && this.course.path.kind === 'circles') {
      target = this.tangentHeading(cx, cz);
    }
    let latSpeed = 0;
    if (target !== null) {
      const dirX = Math.sin(target);
      const dirZ = Math.cos(target);
      const vxC = sample.v.x;
      const vzC = -sample.v.z;
      latSpeed = dirX * vzC - dirZ * vxC;
    }
    const c = this.ctx;
    c.t = rel;
    c.dt = dt;
    c.phase = this.phase;
    c.gating = gating;
    c.legKey = this.legKey;
    c.inH = inH;
    c.posX = cx;
    c.posZ = cz;
    c.altM = alt;
    c.speed3dMs = speed3d;
    c.headingRad = heading;
    c.headingTargetRad = target;
    c.headingChangedAt = this.headingChangedAt;
    c.altTargetM = gating.altitude ? this.course.altitudeM : null;
    c.latSpeedMs = latSpeed;
    c.accelMs2 = accel;
    c.gustSuppressed = this.gustActive || rel < this.gustGraceUntil;
    this.engine.step(c);

    if (this.engine.failed) {
      this.finish('immediate_fail');
      return;
    }
    if (this.engine.points < this.cfg.pass.passPoints) {
      this.finish('points_exhausted');
      return;
    }

    this.recordTrack(rel, cx, cz, alt);
  }

  // ------------------------------------------------------------------
  // FSM
  // ------------------------------------------------------------------

  private fsmStep(
    rel: number,
    dt: number,
    cx: number,
    cz: number,
    alt: number,
    vy: number,
    speed3d: number,
    inH: boolean,
  ): void {
    const fsm = this.cfg.fsm;
    const kind = this.course.path.kind;

    switch (this.phase) {
      case 'preflight': {
        if (alt > fsm.takeoffAltM && vy > 0) {
          // 離陸検出
          if (this.takeoffInstrRel === null) {
            // 指示前の移動（離陸指示の発話開始前に離陸）
            this.engine.deduct('WRONG_OP', rel, '指示前の離陸', {
              posX: cx,
              posZ: cz,
              phase: this.phase,
            });
            this.forceActivateTakeoff(rel);
          }
          if (this.lastDeclareRel < (this.takeoffInstrRel ?? 0)) {
            this.engine.deduct('SAFETY', rel, '安全確認の宣言なしに離陸', {
              posX: cx,
              posZ: cz,
              phase: this.phase,
            });
          }
          this.activate('takeoff_detected');
          this.setPhase('takeoff', rel, 'takeoff');
        }
        break;
      }
      case 'takeoff': {
        if (Math.abs(alt - this.course.altitudeM) <= fsm.hover.altTolM) {
          this.activate('at_target_altitude');
          this.setPhase('hover', rel, 'hover');
          this.hoverHoldT = 0;
        }
        break;
      }
      case 'hover': {
        const distH = Math.hypot(cx - this.course.h.x, cz - this.course.h.z);
        const ok =
          distH <= fsm.hover.radiusM &&
          Math.abs(alt - this.course.altitudeM) <= fsm.hover.altTolM &&
          speed3d <= fsm.hover.speedMs;
        this.hoverHoldT = ok ? this.hoverHoldT + dt : 0;
        if (this.hoverHoldT >= fsm.hover.holdS) {
          this.activate('hover_done');
          if (kind === 'circles') {
            this.setPhase('work', rel, `circle:${this.segIndex}`);
          } else {
            const a = this.pointA();
            this.travelDirRad = Math.atan2(a.x - this.course.h.x, a.z - this.course.h.z);
            this.setPhase('transit', rel, 'transit');
          }
        }
        break;
      }
      case 'transit': {
        const a = this.pointA();
        if (Math.hypot(cx - a.x, cz - a.z) <= fsm.legReachM) {
          this.activate('leg_reached', 'A');
          if (kind === 'polygon') {
            this.initLap();
            this.setPhase('work', rel, this.lapLegKey());
            this.travelDirRad = this.lapLegDir();
          } else {
            this.initShuttle();
            this.setPhase('work', rel, `shuttle:${this.shuttleLeg}`);
          }
        }
        break;
      }
      case 'work': {
        if (kind === 'polygon') this.stepLap(rel, cx, cz);
        else if (kind === 'circles') this.stepFigure8(rel, cx, cz, inH);
        else this.stepShuttle(rel, cx, cz);
        break;
      }
      case 'emergency_hover': {
        const ok = speed3d <= fsm.emergencyHover.speedMs;
        this.hoverHoldT = ok ? this.hoverHoldT + dt : 0;
        if (this.hoverHoldT >= fsm.emergencyHover.holdS) {
          this.activate('emergency_hover_done');
          this.setPhase('return', rel, 'return');
        }
        break;
      }
      case 'return': {
        if (inH) {
          this.activate('h_entered');
          this.enterHAbove(rel);
        }
        break;
      }
      case 'h_above': {
        if (!this.safetyLandChecked && vy < -this.cfg.fsm.descentStartMs) {
          this.safetyLandChecked = true;
          if (this.lastDeclareRel < this.hAboveEntryRel) {
            this.engine.deduct('SAFETY', rel, '安全確認の宣言なしに降下開始', {
              posX: cx,
              posZ: cz,
              phase: this.phase,
            });
          }
        }
        break;
      }
      case 'ground': {
        if (alt <= this.cfg.fsm.touchdownAltM) {
          this.groundHoldT += dt;
          if (this.groundHoldT >= fsm.motorStopHoldS) {
            this.activate('motor_stopped');
            this.finish('completed');
          }
        } else {
          this.groundHoldT = 0;
        }
        break;
      }
      case 'done':
        break;
    }
  }

  /** 4-1: 周回の順序（standard=反時計 A→B→C→D→E→A） */
  private initLap(): void {
    if (this.course.path.kind !== 'polygon') return;
    const pts = this.course.path.points;
    const ids = pts.map((p) => p.id);
    const startIdx = ids.indexOf('A');
    const seq: Array<{ id: string; x: number; z: number }> = [];
    const n = pts.length;
    for (let i = 1; i <= n; i++) {
      const idx =
        this.direction === 'standard' ? (startIdx + i) % n : (startIdx - i + n * 2) % n;
      seq.push(pts[idx]);
    }
    this.lapSeq = seq; // 最後の要素はA（1周して戻る）
    this.lapIdx = 0;
  }

  private lapLegKey(): string {
    const from = this.lapIdx === 0 ? 'A' : this.lapSeq[this.lapIdx - 1].id;
    return `leg:${from}-${this.lapSeq[this.lapIdx].id}`;
  }

  private lapLegDir(): number {
    const from = this.lapIdx === 0 ? this.pointA() : this.lapSeq[this.lapIdx - 1];
    const to = this.lapSeq[this.lapIdx];
    return Math.atan2(to.x - from.x, to.z - from.z);
  }

  private stepLap(rel: number, cx: number, cz: number): void {
    const target = this.lapSeq[this.lapIdx];
    if (Math.hypot(cx - target.x, cz - target.z) <= this.cfg.fsm.legReachM) {
      this.lapIdx++;
      if (this.lapIdx >= this.lapSeq.length) {
        this.activate('lap_done');
        this.setPhase('return', rel, 'return');
      } else {
        this.legKey = this.lapLegKey();
        this.travelDirRad = this.lapLegDir();
        this.headingChangedAt = rel; // 旋回グレース窓の起点
        this.updateHeadingTarget();
      }
    }
  }

  /** 4-2: 巻き数セグメントの進行と最終セグメントのH進入判定 */
  private stepFigure8(rel: number, cx: number, cz: number, inH: boolean): void {
    if (this.lapDone) {
      if (inH) {
        this.activate('h_entered');
        this.enterHAbove(rel);
      }
      return;
    }
    const tracker = this.tracker!;
    const ended = tracker.update(cx, cz);
    if (ended) {
      if (!ended.fullTurn) {
        this.engine.failNow('CENTER_MISS', rel, '円の中心を含まずに周回（8の字）', {
          posX: cx,
          posZ: cz,
          phase: this.phase,
        });
        this.finish('immediate_fail');
        return;
      }
      this.noteSegmentDone(rel, cx, cz, ended.circleId, Math.sign(ended.accumRad));
      if (this.finished || this.lapDone) return;
      this.segIndex++;
      this.legKey = `circle:${this.segIndex}`;
    }
    // 最終セグメント: 3本完了済みなら、H進入手前の弧の分を許容して±2π到達を判定する
    const totalSegs = this.course.windingLaps * 2;
    if (this.segDone === totalSegs - 1 && tracker.activeCircleId !== null) {
      const circle = this.circleById(tracker.activeCircleId);
      const hChord = 2 * Math.asin(Math.min(1, H_PAD_RADIUS / (2 * circle.radiusM)));
      const tol = this.course.winding!.fullTurnToleranceRad + hChord;
      if (Math.abs(tracker.accumRad) >= Math.PI * 2 - tol) {
        this.noteSegmentDone(rel, cx, cz, circle.id, Math.sign(tracker.accumRad));
      }
    }
  }

  private noteSegmentDone(rel: number, cx: number, cz: number, circleId: string, sign: number): void {
    const expected = this.expectedSign.get(circleId) ?? 0;
    if (sign !== expected) {
      this.engine.deduct('WRONG_OP', rel, '規定と逆の周回方向（8の字）', {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
    }
    this.segDone++;
    if (this.segDone >= this.course.windingLaps * 2) {
      this.lapDone = true;
      this.activate('lap_done');
    }
  }

  private circleById(id: string): CircleDef {
    const circles = (this.course.path as { circles: CircleDef[] }).circles;
    return circles.find((c) => c.id === id)!;
  }

  /** 4-2 work中の目標方位=アクティブ円の接線（期待回転方向） */
  private tangentHeading(cx: number, cz: number): number | null {
    const active = this.tracker?.activeCircleId;
    if (!active || this.lapDone) return null;
    const circle = this.circleById(active);
    const rx = cx - circle.center.x;
    const rz = cz - circle.center.z;
    const r = Math.hypot(rx, rz);
    if (r < 0.2) return null;
    const sign = this.expectedSign.get(active) ?? 1;
    // 反時計(+)の接線 = 半径ベクトルを+90°回転（course平面: x右・z奥）
    const tx = -rz * sign;
    const tz = rx * sign;
    return Math.atan2(tx, tz);
  }

  /** 4-3: 往復と緊急事態 */
  private initShuttle(): void {
    if (this.course.path.kind !== 'corridor') return;
    const { from, to } = this.course.path;
    const first = this.direction === 'standard' ? from : to; // standard=先にE側（from=E）
    this.shuttleTarget = first;
    this.shuttleLeg = 0;
    this.shuttleTouches = 0;
  }

  private stepShuttle(rel: number, cx: number, cz: number): void {
    const path = this.course.path as { from: { id: string; x: number; z: number }; to: { id: string; x: number; z: number } };
    const target = this.shuttleTarget!;
    if (Math.hypot(cx - target.x, cz - target.z) <= this.cfg.fsm.legReachM) {
      this.shuttleTouches++;
      this.shuttleTarget = target.id === path.from.id ? path.to : path.from;
      this.shuttleLeg++;
      this.legKey = `shuttle:${this.shuttleLeg}`;
      if (this.shuttleTouches >= 2 && this.emergencyAtRel === null) {
        // 1往復完了 → 注入乱数で緊急事態のタイミングを決める（一様5〜20秒）
        const [lo, hi] = this.cfg.fsm.emergencyDelayRangeS;
        this.emergencyAtRel = rel + lo + this.rng() * (hi - lo);
      }
    }
    if (this.emergencyAtRel !== null && rel >= this.emergencyAtRel) {
      this.activate('emergency_declared');
      this.setPhase('emergency_hover', rel, 'emergency');
      this.hoverHoldT = 0;
    }
  }

  private enterHAbove(rel: number): void {
    this.setPhase('h_above', rel, 'h_above');
    this.hAboveEntryRel = rel;
    this.safetyLandChecked = false;
  }

  private handleTouchdown(
    rel: number,
    cx: number,
    cz: number,
    inH: boolean,
    descentMs: number,
    horizMs: number,
    q: Readonly<Quat>,
  ): void {
    const th = this.cfg.thresholds;
    if (this.phase !== 'h_above') {
      this.engine.failNow('CRASH', rel, '墜落（着陸フェーズ外での接地）', {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
      this.finish('immediate_fail');
      return;
    }
    const tiltDeg = (tiltFromQuat(q) * 180) / Math.PI;
    if (descentMs > th.crashDescentMs) {
      this.engine.failNow('CRASH', rel, `激しい接地（下降${descentMs.toFixed(1)}m/s）`, {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
      this.finish('immediate_fail');
      return;
    }
    if (tiltDeg > th.crashTiltDeg) {
      this.engine.failNow('CRASH', rel, `接地時の転倒（傾斜${tiltDeg.toFixed(0)}°）`, {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
      this.finish('immediate_fail');
      return;
    }
    if (descentMs > th.landBadDescentMs) {
      this.engine.deduct('LAND_BAD', rel, `強い接地衝撃（下降${descentMs.toFixed(1)}m/s）`, {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
    }
    if (horizMs > th.wobbleLandSlideMs) {
      this.engine.deduct('WOBBLE', rel, '滑り接地（接地時の水平速度が大きい）', {
        posX: cx,
        posZ: cz,
        phase: this.phase,
      });
    }
    if (!inH) {
      this.engine.deduct('ZONE_DEV', rel, '接地位置がH円の外', {
        posX: cx,
        posZ: cz,
        phase: this.phase,
        zoneId: 'h-touchdown',
      });
    }
    this.touchedDownRel = rel;
    this.activate('touchdown');
    this.setPhase('ground', rel, 'ground');
    this.groundHoldT = 0;
  }

  // ------------------------------------------------------------------
  // 指示（データ駆動・発話開始時刻ベース）
  // ------------------------------------------------------------------

  /** trigger.type（と必要ならpoint）に一致する未発話の指示を今の時刻で発話開始する */
  private activate(triggerType: string, point?: string): void {
    const rel = this.t0 === null ? 0 : this.prevRel;
    for (const instr of this.course.instructions) {
      if (instr.trigger.type !== triggerType) continue;
      if (point !== undefined && instr.trigger.point !== undefined && instr.trigger.point !== point)
        continue;
      this.fire(instr, rel);
    }
  }

  private fire(instr: CourseInstruction, at: number): void {
    if (this.activatedIds.has(instr.id)) return;
    this.activatedIds.add(instr.id);
    if (instr.id === 'takeoff') {
      // 制限時間・READY_TAKEOFFの起点（発話開始時刻）
      this.takeoffInstrRel = at;
      this.examStartRel = at;
    }
    this.opts.onInstruction?.({ id: instr.id, text: this.fillPlaceholders(instr.text), t: at });
    // 連鎖（after_instruction）: 次の発話開始 = この発話開始 + 名目発話時間
    const nominal = Math.max(
      this.cfg.fsm.speechMinS,
      instr.text.length / this.cfg.fsm.speechCharsPerS,
    );
    for (const next of this.course.instructions) {
      if (next.trigger.type === 'after_instruction' && next.trigger.ref === instr.id) {
        this.scheduled.push({ at: at + nominal, instr: next });
        this.scheduled.sort((a, b) => a.at - b.at);
      }
    }
  }

  /** 離陸指示より先に離陸してしまった場合: スケジュールを破棄して今すぐ有効化 */
  private forceActivateTakeoff(rel: number): void {
    const idx = this.scheduled.findIndex((s) => s.instr.id === 'takeoff');
    if (idx >= 0) this.scheduled.splice(idx, 1);
    const instr = this.course.instructions.find((i) => i.id === 'takeoff');
    if (instr) this.fire(instr, rel);
  }

  private fillPlaceholders(text: string): string {
    const std = this.direction === 'standard';
    const kind = this.course.path.kind;
    let direction: string;
    let lapOrder = '';
    if (kind === 'polygon') {
      direction = std ? '反時計回り' : '時計回り';
      const seq = ['A', ...this.lapSeqIds()];
      lapOrder = seq.join('、');
    } else if (kind === 'circles') {
      direction = std ? '左の円・反時計回り' : '左の円・時計回り';
    } else {
      direction = std ? 'E側' : 'B側';
    }
    return text.split('{direction}').join(direction).split('{lapOrder}').join(lapOrder);
  }

  private lapSeqIds(): string[] {
    if (this.course.path.kind !== 'polygon') return [];
    if (this.lapSeq.length === 0) this.initLap();
    return this.lapSeq.map((p) => p.id);
  }

  // ------------------------------------------------------------------
  // 共通ヘルパ
  // ------------------------------------------------------------------

  private setPhase(phase: PhaseId, rel: number, legKey: string): void {
    this.phase = phase;
    this.legKey = legKey;
    this.headingChangedAt = rel;
    this.engine.onPhaseChange(rel);
    this.updateHeadingTarget();
  }

  private updateHeadingTarget(): void {
    const gating = gatingFor(this.course.path.kind, this.phase);
    if (gating.heading === 'forward') this.headingTargetRad = 0;
    else if (gating.heading === 'travel') this.headingTargetRad = this.travelDirRad;
    else this.headingTargetRad = null;
    // 4-2のwork中は接線を毎サンプル計算するため、ここでは基準値のみ（step側で上書き）
  }

  /** A地点（4-1=経路点A／4-3=地上マーカーA） */
  private pointA(): Vec2 & { id: string } {
    if (this.course.path.kind === 'polygon') {
      const a = this.course.path.points.find((p) => p.id === 'A');
      if (a) return a;
    }
    const m = this.course.groundMarkers.find((p) => p.id === 'A');
    if (m) return m;
    throw new Error(`コース${this.course.id}: A地点が定義されていない（経路点/地上マーカー）`);
  }

  private recordTrack(rel: number, x: number, z: number, alt: number): void {
    if (rel - this.lastTrackRel < TRACK_INTERVAL_S) return;
    this.lastTrackRel = rel;
    this.track.push({ t: rel, x, z, alt });
  }

  private finish(endReason: EndReason): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'done';
    const points = this.engine.points;
    const passed =
      endReason === 'completed' &&
      this.engine.failedCode === null &&
      points >= this.cfg.pass.passPoints;
    const endRel = this.prevRel;
    this.result = {
      courseId: this.course.id,
      courseName: this.course.name,
      passed,
      points,
      failCode: this.engine.failedCode,
      endReason,
      deductions: this.engine.deductions.slice(),
      elapsedS:
        this.examStartRel === null ? 0 : (this.touchedDownRel ?? endRel) - this.examStartRel,
      timeLimitS: this.course.timeLimitS,
      direction: this.direction,
      track: this.track.slice(),
    };
    this.opts.onFinished?.(this.result);
  }
}

/** angleDiffの再輸出（テスト・UIの利便用） */
export { angleDiff };
