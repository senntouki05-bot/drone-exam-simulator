/**
 * render/MiniMap.ts — M5: 練習モードのミニマップ（コース上面図・画面左下）。
 *
 * コース座標そのまま（x右・z上=奥）の上面図。経路白線・H円・パイロン・区画帯の
 * 簡易表現（経路まわりの半透明帯。判定の正は exam/geometry.evalZone であり
 * ここは目安表示）を setCourse 時にオフスクリーンへ事前描画し、毎フレームの
 * update では背景の drawImage＋機体マーカー（進行方位つき三角形）だけを描く
 * （毎フレームのアロケーション・再ラスタライズをしない＝60fps優先）。
 *
 * 射影は ui/ExamPanel.drawTopView と同じ流儀（bbox＋マージン→等方スケール→中央寄せ）で、
 * 純関数 minimapLayout に切り出してユニットテスト対象にする（クラス本体はDOM依存＝目視受入）。
 * スタイルはインラインstyleで自己完結（style.cssは触らない）。表示切替は setVisible。
 */

import type { Course } from '../exam/Course';
import { H_PAD_RADIUS, type CoursePath } from '../exam/geometry';
import { computeCourseBBox, type CourseBBox } from './CourseMarkers';

// ---------------------------------------------------------------------------
// 射影（純関数・DOM非依存＝MiniMap.test.tsの対象）
// ---------------------------------------------------------------------------

/**
 * コース座標→キャンバス内部ピクセルの線形射影。
 *   xPx = offsetXPx + scale * courseX
 *   yPx = offsetYPx - scale * courseZ  （z奥=大ほど画面上=行小。ExamPanelの上面図と同じ向き）
 */
export interface MiniMapLayout {
  /** 等方スケール [内部px / m] */
  scale: number;
  offsetXPx: number;
  offsetYPx: number;
}

/** bboxをキャンバスに等方スケールで収め、中央に寄せる（drawTopViewと同じ流儀） */
export function minimapLayout(bbox: CourseBBox, wPx: number, hPx: number): MiniMapLayout {
  const sx = wPx / (bbox.maxX - bbox.minX);
  const sy = hPx / (bbox.maxZ - bbox.minZ);
  const scale = Math.min(sx, sy);
  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerZ = (bbox.minZ + bbox.maxZ) / 2;
  return {
    scale,
    offsetXPx: wPx / 2 - scale * centerX,
    offsetYPx: hPx / 2 + scale * centerZ,
  };
}

/** コースx→内部ピクセルx */
export function layoutPxX(l: MiniMapLayout, courseX: number): number {
  return l.offsetXPx + l.scale * courseX;
}

/** コースz→内部ピクセルy（z奥ほど上） */
export function layoutPxY(l: MiniMapLayout, courseZ: number): number {
  return l.offsetYPx - l.scale * courseZ;
}

// ---------------------------------------------------------------------------
// 定数（updateで文字列を生成しないよう色はモジュール定数にする）
// ---------------------------------------------------------------------------

/** CSS上の表示サイズ [px] */
const CSS_WIDTH = 190;
const CSS_HEIGHT = 150;
/** bboxの余白 = zoneBands.deductM + この値 [m]（帯の外側に少し地を見せる） */
const MARGIN_BEYOND_DEDUCT_M = 1.5;
/** 機体マーカーの大きさ [CSS px] */
const MARKER_SIZE_CSS_PX = 6;
/** 軌跡（トレイル）の保持サンプル数（60fpsで約4秒ぶん） */
const TRAIL_CAPACITY = 240;
const COLOR_TRAIL = '#5da9ff';

const COLOR_BAND = 'rgba(255, 196, 40, 0.28)'; // 減点帯の簡易表現（CourseMarkersの帯色に合わせる）
const COLOR_PATH = 'rgba(245, 242, 232, 0.85)';
const COLOR_H = 'rgba(245, 242, 232, 0.95)';
const COLOR_PYLON = '#ff5a1f';
const COLOR_GROUND_MARKER = 'rgba(245, 242, 232, 0.7)';
const MARKER_FILL = '#5da9ff'; // 軌跡表示（ExamPanel）と同じ青
const MARKER_STROKE = 'rgba(10, 12, 18, 0.9)';

// ---------------------------------------------------------------------------
// 本体（DOM依存・テストは目視受入）
// ---------------------------------------------------------------------------

export class MiniMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** 内部解像度の倍率（devicePixelRatio対応・上限2はレンダラと同じ方針） */
  private readonly dpr: number;
  private layout: MiniMapLayout | null = null;
  /** setCourseで事前描画した背景（毎フレームはdrawImageするだけ） */
  private bg: HTMLCanvasElement | null = null;

  /** 飛行軌跡のリングバッファ（コース座標・アロケーション回避のため固定長） */
  private readonly trailX = new Float32Array(TRAIL_CAPACITY);
  private readonly trailZ = new Float32Array(TRAIL_CAPACITY);
  private trailHead = 0; // 次に書き込む位置
  private trailLen = 0; // 有効サンプル数（≤TRAIL_CAPACITY）

  constructor(app: HTMLElement) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.canvas.width = Math.round(CSS_WIDTH * this.dpr);
    this.canvas.height = Math.round(CSS_HEIGHT * this.dpr);
    // 左下固定（?input=debugのデバッグ枠と重なるのは許容・仕様どおり）
    this.canvas.style.cssText =
      `position:absolute;left:12px;bottom:12px;width:${CSS_WIDTH}px;height:${CSS_HEIGHT}px;` +
      'background:rgba(20,20,24,0.55);border:1px solid rgba(245,242,232,0.22);' +
      'border-radius:10px;pointer-events:none;display:block;';
    app.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** 課目切替時に1回だけ呼ぶ: 射影を決め、背景（帯・経路・H円・パイロン）を事前描画 */
  setCourse(course: Course): void {
    const bbox = computeCourseBBox(course.path, course.zoneBands.deductM + MARGIN_BEYOND_DEDUCT_M);
    // H円が経路bboxの外へはみ出す課目定義でも欠けないよう包含を保証（4-3はHが経路外）
    const hPad = H_PAD_RADIUS + 0.5;
    if (course.h.x - hPad < bbox.minX) bbox.minX = course.h.x - hPad;
    if (course.h.x + hPad > bbox.maxX) bbox.maxX = course.h.x + hPad;
    if (course.h.z - hPad < bbox.minZ) bbox.minZ = course.h.z - hPad;
    if (course.h.z + hPad > bbox.maxZ) bbox.maxZ = course.h.z + hPad;

    this.layout = minimapLayout(bbox, this.canvas.width, this.canvas.height);
    this.bg = this.buildBackground(course, this.layout);
    this.resetTrail();
    // updateが来る前でも背景が見えるよう1回描いておく
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.bg, 0, 0);
  }

  /** 軌跡をクリアする（機体テレポート＝リセット/課目切替/リプレイ切替で呼ぶ） */
  resetTrail(): void {
    this.trailHead = 0;
    this.trailLen = 0;
  }

  /** 毎フレーム: 背景drawImage＋飛行軌跡＋機体マーカー（アロケーションなし） */
  update(courseX: number, courseZ: number, headingRad: number): void {
    const layout = this.layout;
    const bg = this.bg;
    if (layout === null || bg === null) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(bg, 0, 0);

    // 軌跡を1サンプル記録（リングバッファ）
    this.trailX[this.trailHead] = courseX;
    this.trailZ[this.trailHead] = courseZ;
    this.trailHead = (this.trailHead + 1) % TRAIL_CAPACITY;
    if (this.trailLen < TRAIL_CAPACITY) this.trailLen++;

    // 軌跡（古い側=最古サンプルから現在へ・単一パスの薄い線）
    if (this.trailLen > 1) {
      const start = (this.trailHead - this.trailLen + TRAIL_CAPACITY) % TRAIL_CAPACITY;
      ctx.beginPath();
      for (let i = 0; i < this.trailLen; i++) {
        const idx = (start + i) % TRAIL_CAPACITY;
        const px = layoutPxX(layout, this.trailX[idx]);
        const py = layoutPxY(layout, this.trailZ[idx]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = COLOR_TRAIL;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 機体マーカー: 進行方位つき三角形。headingRadはコース方位（0=奥=画面上・+x側が正）。
    // 画面はy下向きなので、+x（右）へ向く回転=時計回り=ctx.rotateの正方向と一致する。
    const s = MARKER_SIZE_CSS_PX * this.dpr;
    ctx.save();
    ctx.translate(layoutPxX(layout, courseX), layoutPxY(layout, courseZ));
    ctx.rotate(headingRad);
    ctx.beginPath();
    ctx.moveTo(0, -s); // 先端=進行方向
    ctx.lineTo(s * 0.62, s * 0.8);
    ctx.lineTo(0, s * 0.45); // 尾をへこませて向きを判読しやすく
    ctx.lineTo(-s * 0.62, s * 0.8);
    ctx.closePath();
    ctx.fillStyle = MARKER_FILL;
    ctx.fill();
    ctx.strokeStyle = MARKER_STROKE;
    ctx.lineWidth = this.dpr;
    ctx.stroke();
    ctx.restore();
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  dispose(): void {
    this.canvas.remove();
    this.bg = null;
    this.layout = null;
  }

  // --- 内部: 背景の事前描画（課目切替時のみ実行・毎フレームは走らない） ---

  private buildBackground(course: Course, layout: MiniMapLayout): HTMLCanvasElement {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const bg = document.createElement('canvas');
    bg.width = w;
    bg.height = h;
    const ctx = bg.getContext('2d')!;

    // 区画帯の簡易表現: 経路を減点帯外縁の太さで塗り、自由飛行帯の太さでくり抜いてリング状に。
    // （evalZoneのラスタは使わない=簡易。正確な帯は3Dシーン側のCourseMarkersが担当）
    const band = document.createElement('canvas');
    band.width = w;
    band.height = h;
    const bctx = band.getContext('2d')!;
    bctx.lineJoin = 'round';
    bctx.lineCap = 'butt'; // corridorの帯端は矩形近似（丸端にしない）
    bctx.strokeStyle = COLOR_BAND;
    bctx.lineWidth = 2 * course.zoneBands.deductM * layout.scale;
    this.tracePath(bctx, course.path, layout);
    bctx.stroke();
    bctx.globalCompositeOperation = 'destination-out';
    bctx.lineWidth = 2 * course.zoneBands.freeM * layout.scale;
    this.tracePath(bctx, course.path, layout);
    bctx.stroke();
    bctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(band, 0, 0);

    // 経路の白線
    ctx.strokeStyle = COLOR_PATH;
    ctx.lineWidth = Math.max(1, 0.8 * this.dpr);
    ctx.lineJoin = 'round';
    this.tracePath(ctx, course.path, layout);
    ctx.stroke();

    // H円
    ctx.strokeStyle = COLOR_H;
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.beginPath();
    ctx.arc(
      layoutPxX(layout, course.h.x),
      layoutPxY(layout, course.h.z),
      H_PAD_RADIUS * layout.scale,
      0,
      Math.PI * 2,
    );
    ctx.stroke();

    // パイロン（点。実半径0.2mはスケールすると小さすぎるため下限を持つ）
    ctx.fillStyle = COLOR_PYLON;
    const pr = Math.max(course.pylons.radiusM * layout.scale, 2 * this.dpr);
    for (const p of course.pylons.positions) {
      ctx.beginPath();
      ctx.arc(layoutPxX(layout, p.x), layoutPxY(layout, p.z), pr, 0, Math.PI * 2);
      ctx.fill();
    }

    // 地上マーカー（4-3のE/A/B等・小さめの白点）
    ctx.fillStyle = COLOR_GROUND_MARKER;
    for (const m of course.groundMarkers) {
      ctx.beginPath();
      ctx.arc(layoutPxX(layout, m.x), layoutPxY(layout, m.z), 1.5 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    return bg;
  }

  /** 経路をctxのパスとして構築（帯・白線の両方から使う） */
  private tracePath(
    ctx: CanvasRenderingContext2D,
    path: CoursePath,
    layout: MiniMapLayout,
  ): void {
    ctx.beginPath();
    if (path.kind === 'polygon') {
      for (let i = 0; i < path.points.length; i++) {
        const p = path.points[i];
        if (i === 0) ctx.moveTo(layoutPxX(layout, p.x), layoutPxY(layout, p.z));
        else ctx.lineTo(layoutPxX(layout, p.x), layoutPxY(layout, p.z));
      }
      ctx.closePath();
    } else if (path.kind === 'circles') {
      for (const c of path.circles) {
        ctx.moveTo(layoutPxX(layout, c.center.x + c.radiusM), layoutPxY(layout, c.center.z));
        ctx.arc(
          layoutPxX(layout, c.center.x),
          layoutPxY(layout, c.center.z),
          c.radiusM * layout.scale,
          0,
          Math.PI * 2,
        );
      }
    } else {
      ctx.moveTo(layoutPxX(layout, path.from.x), layoutPxY(layout, path.from.z));
      ctx.lineTo(layoutPxX(layout, path.to.x), layoutPxY(layout, path.to.z));
    }
  }
}
