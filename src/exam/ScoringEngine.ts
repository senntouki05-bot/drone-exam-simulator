/**
 * exam/ScoringEngine.ts — 採点エンジン（DOM非依存・ExamSessionが内部駆動する）。
 *
 * 毎サンプルの連続判定（区画・H円逸脱・速度超過・機首・高度・ふらつき・不円滑）を担当し、
 * 離散イベント判定（接地・安全宣言・巻き数・タイムアウト等）はExamSessionが
 * deduct()/failNow() を直接呼ぶ。
 *
 * 主要な規則（正本=data/deductions.json＋CLAUDE-CODE-PROMPT.md減点表）:
 * - ZONE_DEV初回免除は「移動レグ×ゾーン」ごと: レグ内初回進入は警告のみ（onWarning=ビープ+HUD）、
 *   発火から zoneDevRecoveryS 以内に復帰すれば減点なし。滞留超過・同レグ同ゾーン2回目以降は−5。
 * - H円逸脱（hCircleゲート中にH円外）はZONE_DEVと同じ−5・同じ初回免除機構（zoneId='h'）。
 *   フェーズ表上、減点区画ゲートとH円ゲートが同時にONになることはない。
 * - 機首不一致: 30°超の連続区間が headingHoldS 以上で HEADING(−1)。ただし区間が
 *   wrongOpHeadingHoldS まで継続したら WRONG_OP(−5) に昇格し、その区間のHEADINGは
 *   計上しない（−5に吸収）→ HEADINGは**区間終了時**に確定する遅延評価。
 * - 突風猶予: gustSuppressed中は WOBBLE/ROUGH を数えない（操縦者が修正中とみなす）。
 * - 同一コードの減点はレート制限（sameCodeRateLimitS。ZONE_DEVはゾーン別にカウント）。
 */

import type { DeductCode, DeductionCode, DeductionsConfig, FailCode } from './DeductionsConfig';
import type { PhaseGating, PhaseId } from './phases';
import type { ZoneResult } from './geometry';

export interface DeductionEvent {
  /** 課目開始からの相対秒 */
  t: number;
  code: DeductionCode;
  /** 減点（即不合格は0でimmediate=true） */
  points: number;
  immediate: boolean;
  reason: string;
  /** コース座標での発生位置 */
  pos: { x: number; z: number };
  phase: PhaseId;
  zoneId?: string;
}

export interface ExamWarning {
  t: number;
  message: string;
  zoneId: string;
}

export interface ScoringCallbacks {
  onDeduction?: (d: DeductionEvent) => void;
  onWarning?: (w: ExamWarning) => void;
}

/** ExamSessionが毎サンプル渡す判定コンテキスト（使い回し可） */
export interface StepContext {
  /** 課目開始からの相対秒 */
  t: number;
  dt: number;
  phase: PhaseId;
  gating: PhaseGating;
  /** ZONE_DEV初回免除のリセット単位（指示単位の移動レグ） */
  legKey: string;
  zone: ZoneResult;
  inH: boolean;
  posX: number;
  posZ: number;
  altM: number;
  speed3dMs: number;
  /** 機首方位（コース座標・rad） */
  headingRad: number;
  /** 目標方位（null=任意） */
  headingTargetRad: number | null;
  /** 目標方位が最後に切り替わった相対時刻（旋回グレース窓の起点） */
  headingChangedAt: number;
  /** 指示高度（null=判定なし） */
  altTargetM: number | null;
  /** 進行方向に対する横方向速度成分 [m/s]（WOBBLE用。目標方位が無ければ0でよい） */
  latSpeedMs: number;
  /** 3D加速度の大きさ [m/s^2]（ROUGH用・呼び出し側で有限差分） */
  accelMs2: number;
  /** 突風猶予窓の中か（WOBBLE/ROUGHを数えない） */
  gustSuppressed: boolean;
}

export class ScoringEngine {
  private readonly cfg: DeductionsConfig;
  private readonly cb: ScoringCallbacks;

  points: number;
  readonly deductions: DeductionEvent[] = [];
  failedCode: FailCode | null = null;

  // ゾーン状態（減点区画＋H円逸脱を統合。keyは `${legKey}|${zoneId}`）
  private zoneCurrentKey: string | null = null;
  private zonePending: { key: string; zoneId: string; startT: number } | null = null;
  private readonly zoneFirstUsed = new Set<string>();

  // レート制限（key=code または ZONE_DEVはcode|zoneId）
  private readonly lastFireT = new Map<string, number>();

  // SPEED
  private speedHoldT = 0;

  // 機首不一致の連続区間（遅延評価）
  private headingStretchStart: number | null = null;
  private headingWrongOpFired = false;

  // WRONG_OP高度
  private altHoldT = 0;

  // WOBBLE（横速度の符号反転検出）
  private wobbleLastSign = 0;
  private wobblePeak = 0;
  private wobbleFlips: number[] = [];

  // ROUGH
  private roughHoldT = 0;

  constructor(cfg: DeductionsConfig, startPoints: number, cb: ScoringCallbacks) {
    this.cfg = cfg;
    this.points = startPoints;
    this.cb = cb;
  }

  get failed(): boolean {
    return this.failedCode !== null;
  }

  /** 減点を適用する（レート制限つき）。適用したらtrue */
  deduct(
    code: DeductCode,
    t: number,
    reason: string,
    at: { posX: number; posZ: number; phase: PhaseId; zoneId?: string },
  ): boolean {
    if (this.failedCode !== null) return false;
    const rateKey = code + (at.zoneId ? `|${at.zoneId}` : '');
    const last = this.lastFireT.get(rateKey);
    if (last !== undefined && t - last < this.cfg.thresholds.sameCodeRateLimitS) return false;
    this.lastFireT.set(rateKey, t);
    const points = this.cfg.points[code];
    this.points -= points;
    const ev: DeductionEvent = {
      t,
      code,
      points,
      immediate: false,
      reason,
      pos: { x: at.posX, z: at.posZ },
      phase: at.phase,
      zoneId: at.zoneId,
    };
    this.deductions.push(ev);
    this.cb.onDeduction?.(ev);
    return true;
  }

  /** 即不合格を確定する */
  failNow(
    code: FailCode,
    t: number,
    reason: string,
    at: { posX: number; posZ: number; phase: PhaseId; zoneId?: string },
  ): void {
    if (this.failedCode !== null) return;
    this.failedCode = code;
    const ev: DeductionEvent = {
      t,
      code,
      points: 0,
      immediate: true,
      reason,
      pos: { x: at.posX, z: at.posZ },
      phase: at.phase,
      zoneId: at.zoneId,
    };
    this.deductions.push(ev);
    this.cb.onDeduction?.(ev);
  }

  /** フェーズ切替時に呼ぶ（ゾーンの滞在状態・機首区間をリセット。初回免除の消費履歴は保持） */
  onPhaseChange(t: number): void {
    this.zoneCurrentKey = null;
    this.zonePending = null;
    this.closeHeadingStretch(t);
    this.altHoldT = 0;
    this.speedHoldT = 0;
    this.resetWobble();
  }

  /** 毎サンプルの連続判定 */
  step(ctx: StepContext): void {
    if (this.failedCode !== null) return;
    const th = this.cfg.thresholds;

    // --- 不合格区画 ---
    if (ctx.gating.failZone && ctx.zone.zone === 'fail') {
      this.failNow('ZONE_FAIL', ctx.t, `不合格区画へ進入（経路から${ctx.zone.distM.toFixed(1)}m）`, {
        posX: ctx.posX,
        posZ: ctx.posZ,
        phase: ctx.phase,
        zoneId: ctx.zone.zoneId,
      });
      return;
    }

    // --- 減点区画／H円逸脱（統合ゾーン判定・初回免除つき） ---
    let inDeductZone = false;
    let zoneId = '';
    if (ctx.gating.deductZone && ctx.zone.zone === 'deduct') {
      inDeductZone = true;
      zoneId = ctx.zone.zoneId;
    } else if (ctx.gating.hCircle && !ctx.inH) {
      inDeductZone = true;
      zoneId = 'h';
    }
    this.stepZone(ctx, inDeductZone, zoneId);

    // --- 危険な速度（3D合成・連続時間つき） ---
    if (ctx.speed3dMs > th.dangerSpeedMs) {
      this.speedHoldT += ctx.dt;
      if (this.speedHoldT >= th.dangerSpeedHoldS) {
        this.failNow('SPEED', ctx.t, `危険な速度（${ctx.speed3dMs.toFixed(1)}m/s）`, {
          posX: ctx.posX,
          posZ: ctx.posZ,
          phase: ctx.phase,
        });
        return;
      }
    } else {
      this.speedHoldT = 0;
    }

    // --- 機首方位（HEADING −1／WRONG_OPへの昇格吸収） ---
    this.stepHeading(ctx);

    // --- 指示高度（WRONG_OP −5） ---
    if (ctx.gating.altitude && ctx.altTargetM !== null) {
      if (Math.abs(ctx.altM - ctx.altTargetM) > th.wrongOpAltErrM) {
        this.altHoldT += ctx.dt;
        if (this.altHoldT >= th.wrongOpAltHoldS) {
          this.deduct(
            'WRONG_OP',
            ctx.t,
            `指示高度と明らかに異なる高度（${ctx.altM.toFixed(1)}m／指示${ctx.altTargetM.toFixed(1)}m）`,
            { posX: ctx.posX, posZ: ctx.posZ, phase: ctx.phase },
          );
          this.altHoldT = 0;
        }
      } else {
        this.altHoldT = 0;
      }
    } else {
      this.altHoldT = 0;
    }

    // --- ふらつき（WOBBLE −1）・不円滑（ROUGH −1）: 突風猶予中は数えない ---
    if (ctx.gustSuppressed) {
      this.resetWobble();
      this.roughHoldT = 0;
    } else {
      this.stepWobble(ctx);
      if (ctx.accelMs2 > th.roughAccelMs2) {
        this.roughHoldT += ctx.dt;
        if (this.roughHoldT >= th.roughHoldS) {
          this.deduct('ROUGH', ctx.t, `急加減速（${ctx.accelMs2.toFixed(1)}m/s²）`, {
            posX: ctx.posX,
            posZ: ctx.posZ,
            phase: ctx.phase,
          });
          this.roughHoldT = 0;
        }
      } else {
        this.roughHoldT = 0;
      }
    }
  }

  // --- 内部 ---

  private stepZone(ctx: StepContext, inZone: boolean, zoneId: string): void {
    const th = this.cfg.thresholds;
    if (inZone) {
      const key = `${ctx.legKey}|${zoneId}`;
      if (this.zoneCurrentKey !== key) {
        // 進入エッジ（レグ切替で滞在中にkeyが変わった場合も新規進入として扱う）
        this.zoneCurrentKey = key;
        if (this.zoneFirstUsed.has(key)) {
          this.deduct(
            'ZONE_DEV',
            ctx.t,
            zoneId === 'h' ? 'H円から逸脱（同フェーズ2回目以降）' : '減点区画へ進入（同レグ2回目以降）',
            { posX: ctx.posX, posZ: ctx.posZ, phase: ctx.phase, zoneId },
          );
        } else {
          this.zoneFirstUsed.add(key);
          this.zonePending = { key, zoneId, startT: ctx.t };
          this.cb.onWarning?.({
            t: ctx.t,
            message:
              zoneId === 'h'
                ? `H円逸脱: ${th.zoneDevRecoveryS}秒以内に戻ってください`
                : `減点区画: ${th.zoneDevRecoveryS}秒以内に復帰してください`,
            zoneId,
          });
        }
      } else if (this.zonePending?.key === key && ctx.t - this.zonePending.startT > th.zoneDevRecoveryS) {
        // 復帰窓を超えて滞留 → 減点確定
        this.zonePending = null;
        this.deduct(
          'ZONE_DEV',
          ctx.t,
          zoneId === 'h' ? 'H円逸脱から復帰できず' : '減点区画から復帰できず',
          { posX: ctx.posX, posZ: ctx.posZ, phase: ctx.phase, zoneId },
        );
      }
    } else {
      this.zoneCurrentKey = null;
      // 窓内に復帰できていれば免除（何もしない）。窓超過分は滞留中に減点済み
      this.zonePending = null;
    }
  }

  private stepHeading(ctx: StepContext): void {
    const th = this.cfg.thresholds;
    if (ctx.headingTargetRad === null) {
      this.closeHeadingStretch(ctx.t);
      return;
    }
    // 旋回グレース窓（目標切替直後は機首判定を停止＝スクエア四隅の正規ヨー旋回を減点しない）
    if (ctx.t - ctx.headingChangedAt < th.headingGraceS) {
      this.closeHeadingStretch(ctx.t);
      return;
    }
    const err = Math.abs(wrapPi(ctx.headingRad - ctx.headingTargetRad));
    if (err > (th.headingErrDeg * Math.PI) / 180) {
      if (this.headingStretchStart === null) {
        this.headingStretchStart = ctx.t;
        this.headingWrongOpFired = false;
      }
      const dur = ctx.t - this.headingStretchStart;
      if (!this.headingWrongOpFired && dur >= th.wrongOpHeadingHoldS) {
        // 継続的不一致 → WRONG_OPへ昇格（この区間のHEADINGは計上しない）
        this.headingWrongOpFired = true;
        this.deduct('WRONG_OP', ctx.t, '機首方向の継続的不一致', {
          posX: ctx.posX,
          posZ: ctx.posZ,
          phase: ctx.phase,
        });
      }
    } else {
      this.closeHeadingStretch(ctx.t, { posX: ctx.posX, posZ: ctx.posZ, phase: ctx.phase });
    }
  }

  /** 機首不一致区間の終端処理: [headingHoldS, wrongOpHoldS) の区間はHEADING(−1)を確定 */
  private closeHeadingStretch(
    t: number,
    at?: { posX: number; posZ: number; phase: PhaseId },
  ): void {
    if (this.headingStretchStart === null) return;
    const dur = t - this.headingStretchStart;
    const th = this.cfg.thresholds;
    if (!this.headingWrongOpFired && dur >= th.headingHoldS && at) {
      this.deduct('HEADING', t, `機首方向の不一致（${dur.toFixed(1)}秒）`, at);
    }
    this.headingStretchStart = null;
    this.headingWrongOpFired = false;
  }

  private stepWobble(ctx: StepContext): void {
    const th = this.cfg.thresholds;
    if (ctx.headingTargetRad === null) {
      this.resetWobble();
      return;
    }
    const v = ctx.latSpeedMs;
    const sign = v > 0.05 ? 1 : v < -0.05 ? -1 : 0;
    this.wobblePeak = Math.max(this.wobblePeak, Math.abs(v));
    if (sign !== 0 && this.wobbleLastSign !== 0 && sign !== this.wobbleLastSign) {
      if (this.wobblePeak > th.wobbleLatSpeedMs) this.wobbleFlips.push(ctx.t);
      this.wobblePeak = 0;
    }
    if (sign !== 0) this.wobbleLastSign = sign;
    // 窓外の反転を捨てる
    while (this.wobbleFlips.length > 0 && ctx.t - this.wobbleFlips[0] > th.wobbleWindowS) {
      this.wobbleFlips.shift();
    }
    if (this.wobbleFlips.length >= th.wobbleFlipCount) {
      this.deduct('WOBBLE', ctx.t, '経路の大きなふらつき（横方向の振動）', {
        posX: ctx.posX,
        posZ: ctx.posZ,
        phase: ctx.phase,
      });
      this.resetWobble();
    }
  }

  private resetWobble(): void {
    this.wobbleLastSign = 0;
    this.wobblePeak = 0;
    this.wobbleFlips.length = 0;
  }
}

function wrapPi(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}
