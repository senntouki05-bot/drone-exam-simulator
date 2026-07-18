/**
 * sim/FlightModel.ts — sim層の共通型（DOM・Three.js非依存）。
 *
 * M2でカスケード制御（GPS/ATTI）・風・機体プロファイル（data/machines/*.json）を持つ
 * 本物理に差し替えるための境界。render/やmain.tsはこのインターフェースだけに依存する。
 *
 * 座標系（M0の暫定・ワールド）: y=上。操縦者はz+側に立ち、機体の初期機首方向は-z（奥）。
 * ※ 試験コースの座標系（原点=A・x右・z奥）とのマッピングはM3のコース定義側で行う。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
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

export interface DroneState {
  /** 機体基準点（脚底）の位置 [m] */
  p: Vec3;
  /** 速度 [m/s] */
  v: Vec3;
  /** ヨー角 [rad]（M2でクォータニオンqへ拡張予定。M0の仮機体はロール/ピッチを持たない） */
  yawRad: number;
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
