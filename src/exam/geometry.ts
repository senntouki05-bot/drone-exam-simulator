/**
 * exam/geometry.ts — M3: 純幾何関数（FSM非依存・DOM/WebGL/Audio非依存＝実装原則3）。
 *
 * ここには「座標と寸法だけで決まる判定」のみを置く。フェーズによる判定のON/OFF
 * （区画判定のフェーズゲーティング表）や減点への変換はM4のFSM/ScoringEngineが行う。
 *
 * 座標系: 試験コース座標（原点=A・x右・z奥[受験者から見て]）の水平2D。
 * ワールド座標（three.js）との変換は exam/Course.ts の courseToWorld/worldToCourse。
 * 角度: atan2(z, x)。コース平面図（x右・z奥を上に描く）で反時計回りが正。
 *
 * 区画の「機体の半分以上の進入」＝機体中心が境界線を越えた時点とみなす
 * （円形フットプリント近似では中心通過=進入面積がちょうど半分になるため等価）。
 * よって区画判定はすべて機体中心の点で行い、機体半径 radiusM は
 * パイロン等の衝突判定（pylonCollisionIndex）専用とする。
 */

/** コース水平座標 [m] */
export interface Vec2 {
  x: number;
  z: number;
}

/** id付きの経路点（A/B/C…） */
export interface NamedPoint extends Vec2 {
  id: string;
}

/**
 * 離着陸地点Hの半径 [m]（細則: 直径2mの円）。
 * H円の半径定数はこの1つだけにする（径違いのH円を複数作らない・本プロンプト共通ルール）。
 */
export const H_PAD_RADIUS = 1.0;

// ---------------------------------------------------------------------------
// 経路プリミティブ（data/courses/*.json から構築。コードは汎用の幾何判定に徹する）
// ---------------------------------------------------------------------------

/** 閉多角形の周回経路（4-1 スクエア: A→B→C→D→E→A） */
export interface PolygonPath {
  kind: 'polygon';
  points: NamedPoint[];
}

export interface CircleDef {
  id: string;
  center: Vec2;
  radiusM: number;
}

/** 複数円の経路（4-2 8の字: 左右の円） */
export interface CirclesPath {
  kind: 'circles';
  circles: CircleDef[];
}

/**
 * 直線往復の経路（4-3: E–A–B）。区画は細則の図に合わせ**矩形バンド**
 * （境界矩形18m×5m）: 距離 = max(端点方向のはみ出し, 側方距離) のチェビシェフ型。
 * ユークリッド距離だと端が丸くなり矩形にならないため使わない。
 */
export interface CorridorPath {
  kind: 'corridor';
  from: NamedPoint;
  to: NamedPoint;
}

export type CoursePath = PolygonPath | CirclesPath | CorridorPath;

// ---------------------------------------------------------------------------
// ゾーン所属（自由飛行帯 / 減点区画 / 不合格区画）
// ---------------------------------------------------------------------------

/** 経路からの距離帯 [m]（細則: 1.5m以内=自由・1.5超〜2.5=減点・2.5超=不合格） */
export interface ZoneBands {
  freeM: number;
  deductM: number;
}

export type ZoneKind = 'free' | 'deduct' | 'fail';

export interface ZoneResult {
  zone: ZoneKind;
  /**
   * ゾーン識別（減点のゾーン別カウント用）:
   * polygon → 'outer' | 'inner' ／ circles → 'outer' | 'inner-<円id>' ／ corridor → 'outer'
   */
  zoneId: string;
  /** 経路からの水平距離 [m]（corridorは矩形距離） */
  distM: number;
  /** 最寄りレグ（polygon: 'A-B'等の辺 / circles: 円id / corridor: 'E-B'） */
  legId: string;
}

/** 毎フレーム呼び出し用の使い回しZoneResultを作る（アロケーション回避） */
export function createZoneResult(): ZoneResult {
  return { zone: 'free', zoneId: 'outer', distM: 0, legId: '' };
}

/** 点(px,pz)から線分ab（各座標指定）への最短距離 */
export function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}

/** 距離→ゾーン種別（境界値は内側扱い: d≤free=自由・d≤deduct=減点・それ以外=不合格） */
function classify(distM: number, bands: ZoneBands): ZoneKind {
  if (distM <= bands.freeM) return 'free';
  if (distM <= bands.deductM) return 'deduct';
  return 'fail';
}

/** 閉多角形の内外判定（偶奇則レイキャスティング） */
function insidePolygon(px: number, pz: number, points: NamedPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 機体中心(px,pz)のゾーン所属を判定する。
 * 4-1の内側は最大でも距離2.5m（矩形の半幅）にしかならないため、不合格(>2.5)は
 * 幾何的に発生しない＝「内側の不合格区画は実装しない」が自然に成立する。
 */
export function evalZone(
  path: CoursePath,
  bands: ZoneBands,
  px: number,
  pz: number,
  out: ZoneResult,
): ZoneResult {
  if (path.kind === 'polygon') {
    const pts = path.points;
    let best = Infinity;
    let bestI = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = distanceToSegment(px, pz, a.x, a.z, b.x, b.z);
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    out.distM = best;
    out.zone = classify(best, bands);
    out.zoneId = insidePolygon(px, pz, pts) ? 'inner' : 'outer';
    out.legId = `${pts[bestI].id}-${pts[(bestI + 1) % pts.length].id}`;
    return out;
  }

  if (path.kind === 'circles') {
    // 経路=円周の集合。距離は「最寄り円周までの距離」。内側減点区画
    // （4-2: 各円中心の半径1m円）は d = r − 中心距離 > 1.5m ⇔ 中心から1m以内 で同値になる。
    let best = Infinity;
    let bestId = '';
    let containingId = '';
    let containingDepth = -Infinity;
    for (const c of path.circles) {
      const dCenter = Math.hypot(px - c.center.x, pz - c.center.z);
      const signed = dCenter - c.radiusM; // 負=円の内側
      const d = Math.abs(signed);
      if (d < best) {
        best = d;
        bestId = c.id;
      }
      if (signed < 0 && -signed > containingDepth) {
        containingDepth = -signed;
        containingId = c.id;
      }
    }
    out.distM = best;
    out.zone = classify(best, bands);
    out.zoneId = containingId !== '' ? `inner-${containingId}` : 'outer';
    out.legId = containingId !== '' ? containingId : bestId;
    return out;
  }

  // corridor: 矩形バンド距離（端点方向のはみ出しと側方距離のチェビシェフ合成）
  const a = path.from;
  const b = path.to;
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len = Math.hypot(abx, abz);
  const ux = abx / len;
  const uz = abz / len;
  const relx = px - a.x;
  const relz = pz - a.z;
  const proj = relx * ux + relz * uz;
  const over = Math.max(0, -proj, proj - len);
  const lat = Math.abs(relx * uz - relz * ux);
  const d = Math.max(over, lat);
  out.distM = d;
  out.zone = classify(d, bands);
  out.zoneId = 'outer';
  out.legId = `${a.id}-${b.id}`;
  return out;
}

// ---------------------------------------------------------------------------
// H円（離着陸地点）
// ---------------------------------------------------------------------------

/**
 * 機体中心がH円内（中心から水平 H_PAD_RADIUS=1.0m 以内・境界含む）か。
 * 「H上空」フェーズへの切替（=H円進入）と、ホバ・着陸時のH円逸脱判定の両方に使う。
 */
export function inHCircle(px: number, pz: number, h: Vec2): boolean {
  return Math.hypot(px - h.x, pz - h.z) <= H_PAD_RADIUS;
}

// ---------------------------------------------------------------------------
// パイロン衝突
// ---------------------------------------------------------------------------

/** パイロン群（寸法は data/courses/*.json・細則に明文なしの仮置き値） */
export interface PylonSet {
  heightM: number;
  radiusM: number;
  positions: Vec2[];
}

/**
 * パイロン円柱との衝突判定。接触しているパイロンのindexを返す（なければ-1）。
 * 機体下端（bottomAltM=脚底の高度）がパイロン高さ**未満**のときのみ評価する:
 * 経路はパイロン直上を通るため、無限高の円柱にすると正規の周回が全部CRASHになる。
 * machineRadiusM は機体プロファイルの radiusM（衝突判定専用）。
 */
export function pylonCollisionIndex(
  px: number,
  pz: number,
  bottomAltM: number,
  machineRadiusM: number,
  pylons: PylonSet,
): number {
  if (bottomAltM >= pylons.heightM) return -1;
  const hitDist = machineRadiusM + pylons.radiusM;
  for (let i = 0; i < pylons.positions.length; i++) {
    const q = pylons.positions[i];
    if (Math.hypot(px - q.x, pz - q.z) < hitDist) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 巻き数アキュムレータ（4-2 8の字の周回判定）
// ---------------------------------------------------------------------------

export interface WindingConfig {
  /** 左右の円（ちょうど2つ・H中心を挟んでx符号が異なること） */
  circles: CircleDef[];
  /** H（円の接点）の位置 */
  hCenter: Vec2;
  /** 円中心からこの距離未満のサンプルは角度更新をスキップ（atan2の飛び対策） [m] */
  minSampleRadiusM: number;
  /** アクティブ円切替のヒステリシス: Hからこの距離以上離れて相手円側に入ったら切替 [m] */
  switchHysteresisM: number;
  /** ±2π到達判定の許容 [rad]（切替がH近傍で起こるため厳密な2πには僅かに届かない） */
  fullTurnToleranceRad: number;
}

/** 担当セグメント（片円）の終了報告。CENTER_MISS等への解釈はM4の採点側が行う */
export interface WindingSegmentEnd {
  circleId: string;
  /** 累積角 [rad]。符号=回転方向（コース平面図で反時計回りが正） */
  accumRad: number;
  /** |accumRad| ≥ 2π − fullTurnToleranceRad に達したか（=円の中心を含んで1周した） */
  fullTurn: boolean;
}

/**
 * 各円中心まわりの機体方位角を毎サンプル追跡し、1ステップの角度増分を
 * |Δθ|≤πに正規化（=最短経路）して累積する。
 * - アクティブ円の切替はヒステリシス付き: 機体中心がHから水平 switchHysteresisM 以上
 *   離れて相手円側（H中心に対するxの符号）に入った時点で切替。
 * - 切替時に新アクティブ円の累積角を0にリセットし、旧円のセグメント結果を返す。
 * - 中心から minSampleRadiusM 以内では角度更新をスキップし、離脱時に再シードする
 *   （スキップ区間をまたぐ見かけの大回転を累積しない）。
 */
export class WindingTracker {
  private readonly cfg: WindingConfig;
  private active: CircleDef | null = null;
  private accum = 0;
  private prevAngle = 0;
  private prevValid = false;

  constructor(cfg: WindingConfig) {
    if (cfg.circles.length !== 2) {
      throw new Error('WindingTracker: 円はちょうど2つ（左右）であること');
    }
    const s0 = Math.sign(cfg.circles[0].center.x - cfg.hCenter.x);
    const s1 = Math.sign(cfg.circles[1].center.x - cfg.hCenter.x);
    if (s0 === 0 || s1 === 0 || s0 === s1) {
      throw new Error('WindingTracker: 2円はHを挟んでx符号が異なる側にあること');
    }
    this.cfg = cfg;
  }

  /** 現在のアクティブ円id（初回はH近傍を離れてどちらかの側に入るまでnull） */
  get activeCircleId(): string | null {
    return this.active?.id ?? null;
  }

  /** 現在のアクティブ円の累積角 [rad]（HUD表示・デバッグ用） */
  get accumRad(): number {
    return this.accum;
  }

  /**
   * 機体中心の1サンプルを与える。アクティブ円が切り替わったフレームでは
   * 旧円のセグメント結果を返す（それ以外はnull）。初回のアクティブ円決定では返さない。
   */
  update(px: number, pz: number): WindingSegmentEnd | null {
    const cfg = this.cfg;
    let ended: WindingSegmentEnd | null = null;

    const dH = Math.hypot(px - cfg.hCenter.x, pz - cfg.hCenter.z);
    if (dH >= cfg.switchHysteresisM) {
      const side = Math.sign(px - cfg.hCenter.x);
      if (side !== 0) {
        const target =
          Math.sign(cfg.circles[0].center.x - cfg.hCenter.x) === side
            ? cfg.circles[0]
            : cfg.circles[1];
        if (target !== this.active) {
          if (this.active !== null) ended = this.endSegment();
          this.active = target;
          this.accum = 0;
          this.prevValid = false;
        }
      }
    }

    const active = this.active;
    if (active !== null) {
      const dx = px - active.center.x;
      const dz = pz - active.center.z;
      if (Math.hypot(dx, dz) >= cfg.minSampleRadiusM) {
        const angle = Math.atan2(dz, dx);
        if (this.prevValid) this.accum += wrapPi(angle - this.prevAngle);
        this.prevAngle = angle;
        this.prevValid = true;
      } else {
        this.prevValid = false;
      }
    }

    return ended;
  }

  /** 課目終了時に呼ぶ: 最終セグメント（現アクティブ円）の判定を返す */
  finish(): WindingSegmentEnd | null {
    if (this.active === null) return null;
    const ended = this.endSegment();
    this.active = null;
    this.accum = 0;
    this.prevValid = false;
    return ended;
  }

  private endSegment(): WindingSegmentEnd {
    const abs = Math.abs(this.accum);
    return {
      circleId: this.active!.id,
      accumRad: this.accum,
      fullTurn: abs >= Math.PI * 2 - this.cfg.fullTurnToleranceRad,
    };
  }
}

/** 角度差を(−π, π]へ正規化（最短経路の増分） */
function wrapPi(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}
