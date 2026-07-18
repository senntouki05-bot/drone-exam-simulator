/**
 * sim/FlightDynamics.ts — M2本実装: PX4型簡略カスケード制御＋セミインプリシットEuler積分（240Hz想定）。
 * DOM・Three.js非依存（Vitest node環境で軌道を機械検証する）。
 *
 * 制御カスケード（PX4の Position→Velocity→Attitude カスケードの簡略版）:
 *
 *   GPSモード:  スティック → 水平速度指令(±maxSpeedMs) ┐
 *               中立     → ブレーキング(brakeDecelMs2) ├→ 速度ループ(PI) → 傾斜角指令 ┐
 *               停止後   → 位置ホールド(P)＋hoverNoise ┘                            ├→ 傾斜1次遅れ → 水平加速度
 *   ATTIモード: スティック → 傾斜角指令(±maxTiltDeg) ────────────────────────────────┘
 *
 *   垂直（両モード共通の簡略）: スロットル→垂直速度指令、中立で高度ホールド
 *     （GPS=強め／ATTI=気圧計相当のゆっくり）。推力は「垂直加速度を直接充当する」近似で、
 *     重力は推力が常時打ち消しているとみなす（傾斜による揚力損失はM2では扱わない）。
 *   ヨー（両モード共通）: ラダー→ヨーレート指令（±yawRateDps）。
 *
 * 物理:
 *   水平加速度 = g·tan(傾斜角)（推力の水平成分・小傾斜近似の標準形） + 抗力/質量
 *   抗力 F = ½·ρ·Cd·A·|v_air|·v_air, v_air = v - wind（相対風）
 *   → ATTIは中立で傾斜0＝加速ゼロになるだけで、速度は抗力でしか減らず、風があれば
 *     相対風の抗力で風下へドリフトする（当て舵=風上へ傾けて釣り合わせるのが4-3の練習の核）。
 *   → GPSは速度ループの積分項が定常風の抗力を打ち消す＝姿勢の傾きとして見える。
 *
 * 積分はセミインプリシットEuler: v += a·dt → p += v·dt（vを先に更新）。
 *
 * 機体パラメータの正本は data/machines/*.json（MachineProfile経由・実装原則2）。
 * このファイルの定数は「制御実装のチューニング値」（試験仕様の数値ではない）。
 */

import type {
  ControlInput,
  DroneState,
  FlightMode,
  FlightModel,
  Vec3,
} from './FlightModel';
import type { MachineProfile } from './MachineProfile';
import { mulberry32, noise1D } from './noise';

/** 重力加速度 [m/s^2] */
const G = 9.81;
/** 空気密度 [kg/m^3]（海面標準） */
const RHO = 1.225;

// --- 制御ゲイン（実装のチューニング値。試験仕様の数値ではないのでコード定数でよい） ---
/** 速度ループP [1/s] */
const VEL_KP = 2.2;
/** 速度ループI [1/s^2]（定常風の抗力を打ち消す） */
const VEL_KI = 0.6;
/** 速度ループ積分項の加速度換算上限 [m/s^2]（アンチワインドアップ） */
const VEL_I_LIMIT = 4.0;
/** 位置ホールドP [1/s] */
const HOLD_POS_KP = 1.2;
/** 位置ホールド時の速度指令上限 [m/s] */
const HOLD_SPEED_MAX = 2.0;
/** ブレーキング→ホールドへ移る水平速度閾値 [m/s] */
const HOLD_LATCH_SPEED = 0.3;
/** 垂直速度ループP [1/s] */
const VERT_KV = 3.0;
/** 垂直加速度の上限 [m/s^2] */
const VERT_ACC_MAX = 4.0;
/** 高度ホールドP（GPS: きびきび） [1/s] */
const ALT_HOLD_KP_GPS = 1.5;
/** 高度ホールドP（ATTI: 気圧計相当のゆっくり） [1/s] */
const ALT_HOLD_KP_ATTI = 0.35;
/** hoverNoise（値ノイズ）の周波数 [Hz] */
const HOVER_NOISE_FREQ = 0.4;
/** スティック「中立」判定の閾値（入力層のデッドゾーン通過後の値に対して） */
const STICK_EPS = 1e-3;
/** 接地判定の高度epsilon [m] */
const GROUND_EPS = 1e-4;

/** 体育館の仮飛行範囲 [m]（壁抜け防止。M3でコース定義・衝突判定に置換） */
const BOUNDS = { x: 14, z: 10, yMax: 7.0 } as const;

const DEG2RAD = Math.PI / 180;

/** 風の供給元（WindModelが実装。テストでは固定ベクトルの偽物を注入できる） */
export interface WindSource {
  readonly current: Readonly<Vec3>;
}

export interface FlightDynamicsOptions {
  profile: MachineProfile;
  /** 風の供給元（null=無風）。update順は「wind.update() → drone.step()」を呼び出し側が保証する */
  wind?: WindSource | null;
  /** hoverNoise用のシード（省略時は固定値=決定的） */
  seed?: number;
  mode?: FlightMode;
  initial?: { p?: Partial<Vec3>; yawRad?: number };
}

/** GPSモードの水平サブ状態 */
type GpsPhase = 'fly' | 'brake' | 'hold';

export class FlightDynamics implements FlightModel {
  private readonly s: DroneState;
  private prof: MachineProfile;
  private wind: WindSource | null;
  private modeInternal: FlightMode;

  private readonly initP: Vec3;
  private readonly initYaw: number;

  // GPS水平サブ状態
  private gpsPhase: GpsPhase = 'hold';
  private readonly holdPos = { x: 0, z: 0 };
  private holdLatched = false;
  // 速度ループ積分項（ワールドx/z・加速度換算 [m/s^2]）
  private integX = 0;
  private integZ = 0;

  // 高度ホールド
  private altHoldTarget: number | null = null;

  // hoverNoise（決定的な値ノイズ）
  private readonly noiseSeedX: number;
  private readonly noiseSeedZ: number;
  private tInternal = 0;

  constructor(opts: FlightDynamicsOptions) {
    this.prof = opts.profile;
    this.wind = opts.wind ?? null;
    this.modeInternal = opts.mode ?? 'gps';
    const seed = (opts.seed ?? 0x5eed) >>> 0;
    // シード派生の独立ストリーム（mulberry32は初期値の相関を切るために1回転させて捨てる）
    const derive = mulberry32(seed);
    this.noiseSeedX = Math.floor(derive() * 0xffffffff) >>> 0;
    this.noiseSeedZ = Math.floor(derive() * 0xffffffff) >>> 0;
    this.initP = { x: 0, y: 0, z: 0, ...opts.initial?.p };
    this.initYaw = opts.initial?.yawRad ?? 0;
    this.s = {
      p: { ...this.initP },
      v: { x: 0, y: 0, z: 0 },
      yawRad: this.initYaw,
      pitchRad: 0,
      rollRad: 0,
      q: { x: 0, y: 0, z: 0, w: 1 },
      omega: { x: 0, y: 0, z: 0 },
      rotorSpin: 0,
    };
    this.syncQuat();
  }

  get state(): Readonly<DroneState> {
    return this.s;
  }

  get mode(): FlightMode {
    return this.modeInternal;
  }

  get profile(): Readonly<MachineProfile> {
    return this.prof;
  }

  /** GPS⇔ATTI切替。制御器の内部状態（積分・ホールド目標）はリセットする */
  setMode(mode: FlightMode): void {
    if (mode === this.modeInternal) return;
    this.modeInternal = mode;
    this.resetControllers();
  }

  /** 機体プロファイルの差し替え（練習モードの機体選択用）。物理状態は保持する */
  setProfile(profile: MachineProfile): void {
    this.prof = profile;
    this.resetControllers();
  }

  setWind(wind: WindSource | null): void {
    this.wind = wind;
  }

  reset(): void {
    const s = this.s;
    s.p.x = this.initP.x;
    s.p.y = this.initP.y;
    s.p.z = this.initP.z;
    s.v.x = 0;
    s.v.y = 0;
    s.v.z = 0;
    s.yawRad = this.initYaw;
    s.pitchRad = 0;
    s.rollRad = 0;
    s.omega.x = 0;
    s.omega.y = 0;
    s.omega.z = 0;
    s.rotorSpin = 0;
    this.tInternal = 0;
    this.resetControllers();
    this.syncQuat();
  }

  step(dt: number, input: ControlInput): void {
    const s = this.s;
    const prof = this.prof;
    this.tInternal += dt;

    const grounded = s.p.y <= GROUND_EPS && s.v.y <= 0;

    // --- 接地アイドル: スロットルを上げるまで動かない（滑走しない） ---
    if (grounded && input.throttle <= 0) {
      s.v.x = 0;
      s.v.y = 0;
      s.v.z = 0;
      const kIdle = 1 - Math.exp(-dt / prof.tiltTimeConstS);
      this.applyTilt(s.pitchRad * (1 - kIdle), s.rollRad * (1 - kIdle), dt);
      s.omega.y = 0;
      this.resetControllers();
      s.rotorSpin += 15 * dt; // アイドル回転（描画用）
      this.syncQuat();
      return;
    }

    // --- スティック整形（expo）。スロットルはリニアのまま ---
    const ail = applyExpo(input.aileron, prof.expo);
    const ele = applyExpo(input.elevator, prof.expo);
    const rud = applyExpo(input.rudder, prof.expo);

    // --- ヨー: レート指令（右旋回=yaw負方向・three.js右手系） ---
    const yawRate = -rud * prof.yawRateDps * DEG2RAD;
    s.yawRad += yawRate * dt;
    s.omega.y = yawRate;

    // 機首基準の単位ベクトル（前方=-z基準）
    const sinY = Math.sin(s.yawRad);
    const cosY = Math.cos(s.yawRad);
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    // --- 風・相対風 ---
    const w = this.wind?.current;
    const wx = w?.x ?? 0;
    const wz = w?.z ?? 0;

    // --- 水平制御 → 傾斜角指令（前方・右の2成分） ---
    const maxTiltRad = prof.maxTiltDeg * DEG2RAD;
    let tiltFwdCmd: number;
    let tiltRightCmd: number;

    if (this.modeInternal === 'atti') {
      // ATTI: スティック→傾斜角指令のみ（外側ループなし）。中立=水平姿勢に戻るだけ。
      tiltFwdCmd = ele * maxTiltRad;
      tiltRightCmd = ail * maxTiltRad;
      this.holdLatched = false;
      this.gpsPhase = 'fly';
      this.integX = 0;
      this.integZ = 0;
    } else {
      // GPS: スティック→速度指令。中立→ブレーキング→位置ホールド。
      const stickActive = Math.abs(ail) > STICK_EPS || Math.abs(ele) > STICK_EPS;
      if (stickActive) {
        this.gpsPhase = 'fly';
        this.holdLatched = false;
      } else if (this.gpsPhase === 'fly') {
        this.gpsPhase = 'brake';
      }

      let vCmdX = 0;
      let vCmdZ = 0;
      if (this.gpsPhase === 'fly') {
        const vFwd = ele * prof.maxSpeedMs;
        const vRight = ail * prof.maxSpeedMs;
        vCmdX = fwdX * vFwd + rightX * vRight;
        vCmdZ = fwdZ * vFwd + rightZ * vRight;
      } else if (this.gpsPhase === 'brake') {
        // 指令0のままブレーキ減速し、十分遅くなったらその場をホールド目標に固定
        if (Math.hypot(s.v.x, s.v.z) < HOLD_LATCH_SPEED) {
          this.gpsPhase = 'hold';
          this.holdPos.x = s.p.x;
          this.holdPos.z = s.p.z;
          this.holdLatched = true;
          // ブレーキ中に積んだ積分項を捨ててホールドをきれいに始める
          this.integX = 0;
          this.integZ = 0;
        }
      }
      if (this.gpsPhase === 'hold') {
        if (!this.holdLatched) {
          this.holdPos.x = s.p.x;
          this.holdPos.z = s.p.z;
          this.holdLatched = true;
          this.integX = 0;
          this.integZ = 0;
        }
        // hoverNoise: ホールド目標を決定的な値ノイズで微小に揺らす
        const amp = prof.hoverNoise;
        const phase = this.tInternal * HOVER_NOISE_FREQ;
        const tx = this.holdPos.x + amp * noise1D(this.noiseSeedX, phase);
        const tz = this.holdPos.z + amp * noise1D(this.noiseSeedZ, phase);
        vCmdX = clamp(HOLD_POS_KP * (tx - s.p.x), -HOLD_SPEED_MAX, HOLD_SPEED_MAX);
        vCmdZ = clamp(HOLD_POS_KP * (tz - s.p.z), -HOLD_SPEED_MAX, HOLD_SPEED_MAX);
      }

      // 速度ループ（PI）→ 水平加速度指令
      const errX = vCmdX - s.v.x;
      const errZ = vCmdZ - s.v.z;
      let aCmdX = VEL_KP * errX + this.integX;
      let aCmdZ = VEL_KP * errZ + this.integZ;

      // 加速度の大きさ制限: ブレーキング中はbrakeDecelMs2、それ以外は最大傾斜相当
      const aLimit =
        this.gpsPhase === 'brake' ? prof.brakeDecelMs2 : G * Math.tan(maxTiltRad);
      const aMag = Math.hypot(aCmdX, aCmdZ);
      if (aMag > aLimit && aMag > 0) {
        const k = aLimit / aMag;
        aCmdX *= k;
        aCmdZ *= k;
        // 飽和中は積分しない（アンチワインドアップ=条件付き積分。速度オーバーシュート防止）
      } else {
        this.integX = clamp(this.integX + VEL_KI * errX * dt, -VEL_I_LIMIT, VEL_I_LIMIT);
        this.integZ = clamp(this.integZ + VEL_KI * errZ * dt, -VEL_I_LIMIT, VEL_I_LIMIT);
      }

      // 加速度指令 → 傾斜角指令（機首基準の前方・右成分に分解）
      tiltFwdCmd = clamp(Math.atan((aCmdX * fwdX + aCmdZ * fwdZ) / G), -maxTiltRad, maxTiltRad);
      tiltRightCmd = clamp(
        Math.atan((aCmdX * rightX + aCmdZ * rightZ) / G),
        -maxTiltRad,
        maxTiltRad,
      );
    }

    // --- 傾斜の1次遅れ（姿勢内側ループの近似） ---
    const kTilt = 1 - Math.exp(-dt / prof.tiltTimeConstS);
    this.applyTilt(
      s.pitchRad + (tiltFwdCmd - s.pitchRad) * kTilt,
      s.rollRad + (tiltRightCmd - s.rollRad) * kTilt,
      dt,
    );

    // --- 垂直制御: スロットル→垂直速度指令／中立→高度ホールド ---
    let vyCmd: number;
    if (Math.abs(input.throttle) > STICK_EPS) {
      vyCmd =
        input.throttle > 0
          ? input.throttle * prof.maxAscendMs
          : input.throttle * prof.maxDescendMs;
      this.altHoldTarget = null;
    } else {
      if (this.altHoldTarget === null) this.altHoldTarget = s.p.y;
      const kAlt = this.modeInternal === 'gps' ? ALT_HOLD_KP_GPS : ALT_HOLD_KP_ATTI;
      vyCmd = clamp(
        kAlt * (this.altHoldTarget - s.p.y),
        -prof.maxDescendMs,
        prof.maxAscendMs,
      );
    }
    const aVert = clamp(VERT_KV * (vyCmd - s.v.y), -VERT_ACC_MAX, VERT_ACC_MAX);

    // --- 力の合成 ---
    // 推力の水平成分: a = g·tan(傾斜)（前方・右成分をワールドへ）
    const aThrustFwd = G * Math.tan(s.pitchRad);
    const aThrustRight = G * Math.tan(s.rollRad);
    let ax = fwdX * aThrustFwd + rightX * aThrustRight;
    let az = fwdZ * aThrustFwd + rightZ * aThrustRight;
    let ay = aVert;

    // 抗力: F = ½·ρ·CdA·|v_air|·v_air（相対風・3D）
    const vAirX = s.v.x - wx;
    const vAirY = s.v.y; // 風の鉛直成分はM2では0
    const vAirZ = s.v.z - wz;
    const vAirMag = Math.sqrt(vAirX * vAirX + vAirY * vAirY + vAirZ * vAirZ);
    const dragK = (0.5 * RHO * prof.dragCdA * vAirMag) / prof.massKg;
    ax -= dragK * vAirX;
    ay -= dragK * vAirY;
    az -= dragK * vAirZ;

    // --- セミインプリシットEuler: vを先に更新→更新後のvでpを積分 ---
    s.v.x += ax * dt;
    s.v.y += ay * dt;
    s.v.z += az * dt;
    s.p.x += s.v.x * dt;
    s.p.y += s.v.y * dt;
    s.p.z += s.v.z * dt;

    // --- 地面・壁の簡易クランプ（M3でコース衝突判定に置換） ---
    if (s.p.y <= 0) {
      s.p.y = 0;
      if (s.v.y < 0) s.v.y = 0;
      // 接地したらスキッドの摩擦で水平にも滑らない
      s.v.x = 0;
      s.v.z = 0;
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

    this.syncQuat();
  }

  // --- 内部 ---

  private resetControllers(): void {
    this.gpsPhase = 'hold';
    this.holdLatched = false;
    this.integX = 0;
    this.integZ = 0;
    this.altHoldTarget = null;
  }

  /** 傾斜を更新しomega（有限差分の近似角速度）も更新する */
  private applyTilt(newPitch: number, newRoll: number, dt: number): void {
    const s = this.s;
    s.omega.x = (newPitch - s.pitchRad) / dt;
    s.omega.z = (newRoll - s.rollRad) / dt;
    s.pitchRad = newPitch;
    s.rollRad = newRoll;
  }

  /**
   * yaw/pitch/roll → クォータニオン（three.jsのEuler 'YXZ' と同じ合成: q = qY·qX·qZ。
   * 描画側の対応は rotation.x=-pitch / rotation.z=-roll なので符号を合わせる）
   */
  private syncQuat(): void {
    const s = this.s;
    const hy = s.yawRad * 0.5;
    const hx = -s.pitchRad * 0.5;
    const hz = -s.rollRad * 0.5;
    const cy = Math.cos(hy);
    const sy = Math.sin(hy);
    const cx = Math.cos(hx);
    const sx = Math.sin(hx);
    const cz = Math.cos(hz);
    const sz = Math.sin(hz);
    // q = qY(yaw) ⊗ qX(hx) ⊗ qZ(hz)
    s.q.w = cy * cx * cz + sy * sx * sz;
    s.q.x = cy * sx * cz + sy * cx * sz;
    s.q.y = sy * cx * cz - cy * sx * sz;
    s.q.z = cy * cx * sz - sy * sx * cz;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** EXPOカーブ: out = (1-e)·x + e·x^3（端点±1は維持・中央感度が下がる） */
function applyExpo(x: number, expo: number): number {
  return (1 - expo) * x + expo * x * x * x;
}
