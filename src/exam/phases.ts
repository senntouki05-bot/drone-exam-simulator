/**
 * exam/phases.ts — 課目フェーズと判定ゲーティング表（DOM非依存）。
 *
 * 「区画判定のフェーズゲーティング」表（CLAUDE-CODE-PROMPT.md・細則の公式フェーズ別適用表準拠）の
 * コード表現。**判定のON/OFFはフェーズだけで制御する**（H付近の空間ブランケット除外は作らない）。
 *
 * H(0,2.5)は4-1の内側減点区画・4-3の不合格境界上にあるが、離陸/ホバ/帰投/着陸の各フェーズで
 * 該当判定がOFFになるため正しい飛行では減点されない。逆に周回・往復中にHへ流されれば
 * 減点/不合格が正しく付く（この動きを崩さないこと）。
 */

export type PhaseId =
  | 'preflight' // 安全確認〜離陸前（READY_TAKEOFF含む）
  | 'takeoff' // 離陸上昇（〜指示高度）
  | 'hover' // 5秒ホバリング
  | 'transit' // H→A移動（4-1/4-3）
  | 'work' // 周回（4-1）／8の字（4-2）／往復E↔B（4-3）
  | 'emergency_hover' // 緊急事態宣言→緊急着陸指示のその場ホバ（4-3のみ）
  | 'return' // 帰投（4-1: A→H／4-3: 緊急着陸移動→H。高度維持）
  | 'h_above' // H上空→着陸（READY_LAND）
  | 'ground' // 接地後（モーター停止待ち）
  | 'done';

/** 機首方位の要求: forward=前方(コース+z・受験者から見て奥)／travel=進行方向／any=任意 */
export type HeadingRule = 'forward' | 'travel' | 'any';

export interface PhaseGating {
  /** 減点区画（外側帯・内側帯。4-2は左右内円も）の判定 */
  deductZone: boolean;
  /** 不合格区画の判定 */
  failZone: boolean;
  /** H円(r=1.0m)逸脱の判定（ホバ・着陸時） */
  hCircle: boolean;
  /** 指示高度の判定 */
  altitude: boolean;
  heading: HeadingRule;
}

type CourseKind = 'polygon' | 'circles' | 'corridor';

const OFF: PhaseGating = {
  deductZone: false,
  failZone: false,
  hCircle: false,
  altitude: false,
  heading: 'any',
};

/** ゲーティング表本体。行=フェーズ・列=課目種別（4-1=polygon / 4-2=circles / 4-3=corridor） */
const TABLE: Record<PhaseId, Record<CourseKind, PhaseGating>> = {
  preflight: { polygon: OFF, circles: OFF, corridor: OFF },
  takeoff: {
    polygon: { ...OFF, heading: 'forward' },
    circles: OFF, // 4-2: 離陸上昇=判定なし
    corridor: { ...OFF, heading: 'forward' },
  },
  hover: {
    polygon: { ...OFF, hCircle: true, altitude: true, heading: 'forward' },
    circles: { ...OFF, hCircle: true, altitude: true }, // 4-2: H円+高度のみ
    corridor: { ...OFF, hCircle: true, altitude: true, heading: 'forward' },
  },
  transit: {
    // H→A移動: 細則注記で減点区画のみ無効・不合格区画は有効
    polygon: { ...OFF, failZone: true, altitude: true, heading: 'travel' },
    circles: OFF, // 4-2にtransitフェーズはない（Hが経路上）
    corridor: { ...OFF, failZone: true, altitude: true, heading: 'forward' },
  },
  work: {
    polygon: { deductZone: true, failZone: true, hCircle: false, altitude: true, heading: 'travel' },
    circles: { deductZone: true, failZone: true, hCircle: false, altitude: true, heading: 'travel' },
    corridor: {
      deductZone: true,
      failZone: true,
      hCircle: false,
      altitude: true,
      heading: 'forward',
    },
  },
  emergency_hover: {
    polygon: OFF, // 4-3のみ
    circles: OFF,
    corridor: {
      deductZone: true,
      failZone: true,
      hCircle: false,
      altitude: true,
      heading: 'forward',
    },
  },
  return: {
    // 帰投: 減点無効・不合格有効・高度維持
    polygon: { ...OFF, failZone: true, altitude: true, heading: 'any' },
    circles: OFF,
    corridor: { ...OFF, failZone: true, altitude: true, heading: 'forward' },
  },
  h_above: {
    polygon: { ...OFF, hCircle: true },
    circles: { ...OFF, hCircle: true },
    corridor: { ...OFF, hCircle: true, heading: 'forward' },
  },
  ground: { polygon: OFF, circles: OFF, corridor: OFF },
  done: { polygon: OFF, circles: OFF, corridor: OFF },
};

export function gatingFor(kind: CourseKind, phase: PhaseId): PhaseGating {
  return TABLE[phase][kind];
}
