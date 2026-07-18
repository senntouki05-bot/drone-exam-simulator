/**
 * sim/FlightModel.ts — sim層の共通型（DOM・Three.js非依存）。
 *
 * M2でカスケード制御（GPS/ATTI）・風・機体プロファイル（data/machines/*.json）を持つ
 * FlightDynamics が本実装。render/やmain.tsはこのインターフェースだけに依存する。
 *
 * 座標系（ワールド）: y=上。操縦者はz+側に立ち、機体の初期機首方向は-z（奥）。
 * ※ 試験コースの座標系（原点=A・x右・z奥）とのマッピングはM3のコース定義側で行う。
 *
 * 姿勢の表現: yaw/pitch/roll のオイラー角（YXZ相当）を一次表現とし、
 * クォータニオン q はそこから毎ステップ合成する（M4のexam APIが {p, v, q, mode} を受けるため）。
 * - yawRad: y軸まわり（three.jsの右手系。右旋回=負方向）
 * - pitchRad: 機首下げ（前方=-zへ加速する向き）が正
 * - rollRad: 右バンク（右=+x側へ加速する向き）が正
 * 描画側は rotation.order='YXZ' で rotation.y=yaw / rotation.x=-pitch / rotation.z=-roll を設定する。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** スティック4軸の正規化入力（各 -1〜+1） */
export interface ControlInput {
  /** エルロン: 右スティック左右（+で右移動） */
  aileron: number;
  /** エレベーター: 右スティック上下（+で前進） */
  elevator: number;
  /** スロットル: 左スティック上下（+で上昇） */
  throttle: number;
  /** ラダー: 左スティック左右（+で右旋回） */
  rudder: number;
}

/** 位置安定機能: GPS=位置/速度ループON、ATTI=傾斜角指令のみ（4-3で使用） */
export type FlightMode = 'gps' | 'atti';

export interface DroneState {
  /** 機体基準点（脚底）の位置 [m] */
  p: Vec3;
  /** 速度 [m/s] */
  v: Vec3;
  /** ヨー角 [rad] */
  yawRad: number;
  /** ピッチ（機首下げ正） [rad] */
  pitchRad: number;
  /** ロール（右バンク正） [rad] */
  rollRad: number;
  /** 姿勢クォータニオン（yaw/pitch/rollからYXZ合成・毎ステップ更新） */
  q: Quat;
  /**
   * 近似角速度 [rad/s]（オイラー角レートの有限差分。x=pitchレート・y=yawレート・z=rollレート）。
   * 厳密な機体座標角速度ベクトルではない（採点・描画はq/pのみを使う想定の参考値）。
   */
  omega: Vec3;
  /** 描画用プロペラ位相 [rad]（物理には無関係） */
  rotorSpin: number;
}

export interface FlightModel {
  readonly state: Readonly<DroneState>;
  /** 固定Δtで1ステップ進める（GameLoopのupdateから呼ぶ） */
  step(dt: number, input: ControlInput): void;
  /** 初期位置・静止状態へ戻す */
  reset(): void;
}

export const NEUTRAL_INPUT: Readonly<ControlInput> = Object.freeze({
  aileron: 0,
  elevator: 0,
  throttle: 0,
  rudder: 0,
});

/** 補間用スナップショット（描画側でprev/currの2つを保持する） */
export interface DroneSnapshot {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  pitchRad: number;
  rollRad: number;
  rotorSpin: number;
}

export function takeSnapshot(state: Readonly<DroneState>, out: DroneSnapshot): void {
  out.x = state.p.x;
  out.y = state.p.y;
  out.z = state.p.z;
  out.yawRad = state.yawRad;
  out.pitchRad = state.pitchRad;
  out.rollRad = state.rollRad;
  out.rotorSpin = state.rotorSpin;
}

export function horizontalSpeed(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.z);
}
