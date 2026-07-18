/**
 * sim/SimpleDrone.ts — M0の仮機体（GPSモード風の速度制御の超簡略版）。
 *
 * スティック→速度指令→1次遅れ→積分だけの簡易モデル。中立でブレーキング減速して
 * 実質ホールドする（GPSモードの雰囲気のみ）。姿勢はヨーのみ・風なし。
 *
 * ⚠️ ここの定数はM0専用の仮値で正本ではない。M2で FlightModel 実装ごと
 *    カスケード制御＋機体プロファイル（data/machines/*.json）に差し替える。
 */

import type { ControlInput, DroneState, FlightModel, Vec3 } from './FlightModel';

/** M0仮パラメータ（M2で data/machines/*.json へ移行） */
const PARAMS = {
  /** 最大水平速度 [m/s]（危険速度5m/s未満に収める） */
  maxSpeedMs: 3.0,
  /** 最大上昇速度 [m/s] */
  maxAscendMs: 2.0,
  /** 最大下降速度 [m/s] */
  maxDescendMs: 1.5,
  /** 最大ヨーレート [deg/s] */
  yawRateDps: 120,
  /** 水平速度指令への1次遅れ時定数 [s]（キーボードのデジタル入力の平滑も兼ねる） */
  horizLagS: 0.35,
  /** 垂直速度指令への1次遅れ時定数 [s] */
  vertLagS: 0.25,
} as const;

/** 体育館の仮飛行範囲 [m]（壁抜け防止。M3でコース定義・衝突判定に置換） */
const BOUNDS = {
  x: 14,
  z: 10,
  yMax: 7.0,
} as const;

const DEG2RAD = Math.PI / 180;

/** 接地判定の高度epsilon [m] */
const GROUND_EPS = 1e-4;

export class SimpleDrone implements FlightModel {
  private readonly s: DroneState;

  constructor(initial?: Partial<Pick<DroneState, 'p' | 'yawRad'>>) {
    this.s = {
      p: { x: 0, y: 0, z: 0, ...initial?.p },
      v: { x: 0, y: 0, z: 0 },
      yawRad: initial?.yawRad ?? 0,
      rotorSpin: 0,
    };
  }

  get state(): Readonly<DroneState> {
    return this.s;
  }

  reset(): void {
    this.s.p.x = 0;
    this.s.p.y = 0;
    this.s.p.z = 0;
    this.s.v.x = 0;
    this.s.v.y = 0;
    this.s.v.z = 0;
    this.s.yawRad = 0;
    this.s.rotorSpin = 0;
  }

  step(dt: number, input: ControlInput): void {
    const s = this.s;
    const grounded = s.p.y <= GROUND_EPS;

    // 接地中はスロットルを上げるまで動かない（滑走しない）
    if (grounded && input.throttle <= 0) {
      s.v.x = 0;
      s.v.y = 0;
      s.v.z = 0;
      s.rotorSpin += 15 * dt; // アイドル回転（描画用）
      return;
    }

    // --- ヨー ---
    // 前方=-z の座標系では「右旋回」はy軸まわりの負回転（three.jsの右手系に合わせる）
    s.yawRad -= input.rudder * PARAMS.yawRateDps * DEG2RAD * dt;

    // --- 水平: 機体座標の速度指令をワールドへ回転 ---
    const sinY = Math.sin(s.yawRad);
    const cosY = Math.cos(s.yawRad);
    // 前方(-z基準): forward=(-sinY, 0, -cosY) / 右: right=(cosY, 0, -sinY)
    const cmdFwd = input.elevator * PARAMS.maxSpeedMs;
    const cmdRight = input.aileron * PARAMS.maxSpeedMs;
    const targetVx = -sinY * cmdFwd + cosY * cmdRight;
    const targetVz = -cosY * cmdFwd - sinY * cmdRight;

    // --- 垂直 ---
    const targetVy =
      input.throttle >= 0
        ? input.throttle * PARAMS.maxAscendMs
        : input.throttle * PARAMS.maxDescendMs;

    // --- 1次遅れで速度を指令に追従（中立なら指令0へ減速＝簡易ブレーキング→ホールド） ---
    const kH = 1 - Math.exp(-dt / PARAMS.horizLagS);
    const kV = 1 - Math.exp(-dt / PARAMS.vertLagS);
    s.v.x += (targetVx - s.v.x) * kH;
    s.v.z += (targetVz - s.v.z) * kH;
    s.v.y += (targetVy - s.v.y) * kV;

    // --- 積分 ---
    s.p.x += s.v.x * dt;
    s.p.y += s.v.y * dt;
    s.p.z += s.v.z * dt;

    // --- 地面・壁の簡易クランプ（M3で衝突判定に置換） ---
    if (s.p.y <= 0) {
      s.p.y = 0;
      if (s.v.y < 0) s.v.y = 0;
    }
    if (s.p.y > BOUNDS.yMax) {
      s.p.y = BOUNDS.yMax;
      if (s.v.y > 0) s.v.y = 0;
    }
    if (Math.abs(s.p.x) > BOUNDS.x) {
      s.p.x = Math.sign(s.p.x) * BOUNDS.x;
      s.v.x = 0;
    }
    if (Math.abs(s.p.z) > BOUNDS.z) {
      s.p.z = Math.sign(s.p.z) * BOUNDS.z;
      s.v.z = 0;
    }

    // --- プロペラ位相（描画用） ---
    s.rotorSpin += (40 + 40 * Math.abs(input.throttle)) * dt;
  }
}

/** 補間用スナップショット（描画側でprev/currの2つを保持する） */
export interface DroneSnapshot {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  rotorSpin: number;
}

export function takeSnapshot(state: Readonly<DroneState>, out: DroneSnapshot): void {
  out.x = state.p.x;
  out.y = state.p.y;
  out.z = state.p.z;
  out.yawRad = state.yawRad;
  out.rotorSpin = state.rotorSpin;
}

export function horizontalSpeed(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.z);
}
