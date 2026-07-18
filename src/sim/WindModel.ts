/**
 * sim/WindModel.ts — 風モデル（定常＋1次遅れガスト＋Perlin乱流・DOM非依存）。
 *
 *   wind(t) = 定常ベクトル + ガスト（1次遅れフィルタでランダム目標に追従） + 値ノイズ乱流
 *
 * - 乱数はシード注入（mulberry32）＝同一シードで完全に再現可能（テストで機械検証する）。
 * - ガストの開始/終了は gust_start / gust_end イベントとして記録し、採点系（M4）が
 *   drainEvents() で受け取る。「突風起因のふらつきは速やかに修正すれば減点しない」猶予窓の起点になる。
 *   イベント時刻 t は呼び出し側から渡されるシム時間（実時計不使用・実装原則6）。
 * - ガストのタイムライン: idle →(interval経過)→ active（gust_start発行・目標=ピークベクトル）
 *   →(duration経過)→ idle（gust_end発行・目標=0）。現在値は1次遅れで目標を追う。
 * - 乱流・ガストは水平（x,z）のみ。鉛直成分はM2では扱わない（高度は制御則の保持対象のため）。
 * - 数値プリセットの正本は data/wind-presets.json（WindPresets.ts経由で読む）。
 */

import type { Vec3 } from './FlightModel';
import { fbm1D, mulberry32 } from './noise';

export interface WindGustConfig {
  enabled: boolean;
  /** 突風ピーク風速の追加分 [m/s]（一様乱数の範囲） */
  ampMinMs: number;
  ampMaxMs: number;
  /** ガスト間隔 [s]（前のガスト終了→次の開始） */
  intervalMinS: number;
  intervalMaxS: number;
  /** ガスト持続 [s] */
  durMinS: number;
  durMaxS: number;
  /** 1次遅れ時定数 [s] */
  tauS: number;
}

export interface WindTurbulenceConfig {
  /** 乱流変調の振幅 [m/s] */
  ampMs: number;
  /** 乱流の基本周波数 [Hz] */
  freqHz: number;
}

export interface WindConfig {
  /** 定常風速 [m/s] */
  steadyMs: number;
  /** 風が吹いていく方向 [deg]（0=+x, 90=+z） */
  steadyDirDeg: number;
  gust: WindGustConfig;
  turbulence: WindTurbulenceConfig;
}

export type WindEventType = 'gust_start' | 'gust_end';

export interface WindEvent {
  /** シム時間 [s]（update()に渡された tSim） */
  t: number;
  type: WindEventType;
  /** gust_start時のみ: ピーク風速の追加分 [m/s] */
  peakMs?: number;
}

/** 無風の設定（屋内既定） */
export const CALM_WIND: WindConfig = Object.freeze({
  steadyMs: 0,
  steadyDirDeg: 0,
  gust: Object.freeze({
    enabled: false,
    ampMinMs: 0,
    ampMaxMs: 0,
    intervalMinS: 5,
    intervalMaxS: 10,
    durMinS: 1,
    durMaxS: 2,
    tauS: 1,
  }),
  turbulence: Object.freeze({ ampMs: 0, freqHz: 0.5 }),
});

const DEG2RAD = Math.PI / 180;

/** ガスト方向の定常風向からの最大ずらし角 [rad]（仮置き・±45°） */
const GUST_DIR_SPREAD_RAD = Math.PI / 4;

export class WindModel {
  readonly config: Readonly<WindConfig>;

  private readonly rand: () => number;
  private readonly turbSeedX: number;
  private readonly turbSeedZ: number;

  /** 現在の合成風ベクトル [m/s]（毎updateで書き換える・アロケーションしない） */
  private readonly cur: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly steadyVec = { x: 0, z: 0 };

  // ガスト状態
  private gustActive = false;
  /** 次のガスト開始/終了までの残り時間 [s]（シード決定的にするため内部カウントダウンで管理） */
  private gustTimerS: number;
  private readonly gustTarget = { x: 0, z: 0 };
  private readonly gustCur = { x: 0, z: 0 };

  /** 乱流ノイズの位相時間 [s]（シム時間と等速で進む） */
  private tNoise = 0;

  private readonly events: WindEvent[] = [];

  constructor(config: WindConfig, seed = 1) {
    this.config = config;
    this.rand = mulberry32(seed);
    // 乱流の2軸はシード派生の独立ストリーム
    this.turbSeedX = (seed ^ 0x1f123bb5) >>> 0;
    this.turbSeedZ = (seed ^ 0x6c62272e) >>> 0;
    const dir = config.steadyDirDeg * DEG2RAD;
    this.steadyVec.x = config.steadyMs * Math.cos(dir);
    this.steadyVec.z = config.steadyMs * Math.sin(dir);
    this.gustTimerS = this.sampleRange(config.gust.intervalMinS, config.gust.intervalMaxS);
    this.cur.x = this.steadyVec.x;
    this.cur.z = this.steadyVec.z;
  }

  /** 現在の合成風ベクトル [m/s]（update後に読む） */
  get current(): Readonly<Vec3> {
    return this.cur;
  }

  /**
   * 1物理ステップ分進める。tSimはイベント時刻の記録にのみ使用
   * （進行自体はdtの積算＝GameLoopのシム時間と一致する）。
   */
  update(dt: number, tSim: number): void {
    const cfg = this.config;
    this.tNoise += dt;

    // --- ガストの状態遷移（カウントダウン方式・シード決定的） ---
    if (cfg.gust.enabled) {
      this.gustTimerS -= dt;
      if (this.gustTimerS <= 0) {
        if (!this.gustActive) {
          // idle → active: ピークベクトルを抽選して目標に設定
          const amp = this.sampleRange(cfg.gust.ampMinMs, cfg.gust.ampMaxMs);
          const baseDir =
            cfg.steadyMs > 0
              ? Math.atan2(this.steadyVec.z, this.steadyVec.x)
              : this.rand() * Math.PI * 2;
          const dir = baseDir + (this.rand() * 2 - 1) * GUST_DIR_SPREAD_RAD;
          this.gustTarget.x = amp * Math.cos(dir);
          this.gustTarget.z = amp * Math.sin(dir);
          this.gustActive = true;
          this.gustTimerS = this.sampleRange(cfg.gust.durMinS, cfg.gust.durMaxS);
          this.events.push({ t: tSim, type: 'gust_start', peakMs: amp });
        } else {
          // active → idle: 目標を0へ（現在値は1次遅れで減衰する）
          this.gustTarget.x = 0;
          this.gustTarget.z = 0;
          this.gustActive = false;
          this.gustTimerS = this.sampleRange(cfg.gust.intervalMinS, cfg.gust.intervalMaxS);
          this.events.push({ t: tSim, type: 'gust_end' });
        }
      }
    }

    // --- ガスト現在値: 1次遅れで目標に追従 ---
    const k = 1 - Math.exp(-dt / Math.max(cfg.gust.tauS, 1e-3));
    this.gustCur.x += (this.gustTarget.x - this.gustCur.x) * k;
    this.gustCur.z += (this.gustTarget.z - this.gustCur.z) * k;

    // --- 乱流: 値ノイズ（決定的） ---
    const turb = cfg.turbulence;
    let turbX = 0;
    let turbZ = 0;
    if (turb.ampMs > 0) {
      const phase = this.tNoise * turb.freqHz;
      turbX = turb.ampMs * fbm1D(this.turbSeedX, phase);
      turbZ = turb.ampMs * fbm1D(this.turbSeedZ, phase);
    }

    this.cur.x = this.steadyVec.x + this.gustCur.x + turbX;
    this.cur.y = 0;
    this.cur.z = this.steadyVec.z + this.gustCur.z + turbZ;
  }

  /**
   * 溜まったガストイベントをoutへ移す（返り値=件数）。呼ぶまで内部に蓄積される。
   * M2では表示・破棄のみ、M4で採点系（ExamSession）のイベント列に流す。
   */
  drainEvents(out: WindEvent[]): number {
    const n = this.events.length;
    for (let i = 0; i < n; i++) out.push(this.events[i]);
    this.events.length = 0;
    return n;
  }

  private sampleRange(min: number, max: number): number {
    return min + (max - min) * this.rand();
  }
}
