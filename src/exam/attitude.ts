/**
 * exam/attitude.ts — クォータニオンから採点に必要な姿勢量を取り出す純関数（DOM非依存）。
 *
 * 機首方位はオイラー角の分解でなく「機体前方ベクトルを回して水平投影」で求める
 * （回転順序の取り違えに対して頑健。simのq合成はFlightDynamics.syncQuat=YXZ相当）。
 *
 * 方位の規約（コース座標）: 前方=コース+z（奥・受験者から見て前）を0とし、
 * atan2(dx, dz) で+x（右）方向が正。ワールドとコースはz反転の関係
 * （world.z = -course.z）なので、ワールドの前方ベクトル(-z)はコース+zに一致する。
 */

import type { Quat } from '../sim/FlightModel';

/** q で v=(0,0,-1)（機体前方・ワールド）を回した結果のワールドx/z成分 */
function rotateForward(q: Quat): { x: number; z: number } {
  // v' = q ⊗ v ⊗ q⁻¹ を v=(0,0,-1) に展開した閉形式
  const { x, y, z, w } = q;
  const vx = -(2 * (x * z + w * y));
  const vz = -(1 - 2 * (x * x + y * y));
  return { x: vx, z: vz };
}

/**
 * 機首方位（コース座標系・rad）。0=前方（奥）・+x側が正。
 * 機体が真上/真下を向く特異姿勢（水平成分≈0）は実試験の姿勢では起こらないため考慮しない。
 */
export function headingFromQuat(q: Quat): number {
  const f = rotateForward(q);
  // ワールド→コース: dx_c = f.x / dz_c = -f.z
  return Math.atan2(f.x, -f.z);
}

/** 機体の傾斜角 [rad]（機体上向きベクトルと鉛直のなす角。転倒判定用） */
export function tiltFromQuat(q: Quat): number {
  // up' = q ⊗ (0,1,0) ⊗ q⁻¹ の y成分
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return Math.acos(Math.min(1, Math.max(-1, upY)));
}

/** 角度差を (−π, π] へ正規化 */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** ワールドヨー角（three.js右手系・FlightDynamics規約）→ コース方位。course heading = -yaw */
export function headingFromWorldYaw(yawRad: number): number {
  return -yawRad;
}
