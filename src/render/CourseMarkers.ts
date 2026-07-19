/**
 * render/CourseMarkers.ts — M3: コースの見た目（データ駆動）。
 *
 * data/courses/*.json（Course）から パイロン・H白円・経路ガイド線・地上マーカー・
 * 区画の半透明帯 を組み立てる。区画帯は exam/geometry.evalZone をそのまま
 * ラスタライズしたCanvasテクスチャ1枚（=判定と描画が同じ関数なのでズレようがない）。
 *
 * 区画帯（zoneGroup）は setZonesVisible で切替（練習モードのみ表示可・試験モードは非表示。
 * モードの正式UIはM5、M3では開発キーZでトグル）。
 * パイロン・H円・ガイド線は実試験でも見えるコース設置物なので常時表示。
 */

import * as THREE from 'three';
import type { Course } from '../exam/Course';
import { courseToWorld } from '../exam/Course';
import {
  H_PAD_RADIUS,
  createZoneResult,
  evalZone,
  type CoursePath,
  type NamedPoint,
} from '../exam/geometry';

/** コース座標系でのバウンディングボックス [m] */
export interface CourseBBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 経路の外接矩形＋余白（区画帯ラスタの描画範囲） */
export function computeCourseBBox(path: CoursePath, marginM: number): CourseBBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const eat = (x: number, z: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  if (path.kind === 'polygon') {
    for (const p of path.points) eat(p.x, p.z);
  } else if (path.kind === 'circles') {
    for (const c of path.circles) {
      eat(c.center.x - c.radiusM, c.center.z - c.radiusM);
      eat(c.center.x + c.radiusM, c.center.z + c.radiusM);
    }
  } else {
    eat(path.from.x, path.from.z);
    eat(path.to.x, path.to.z);
  }
  return {
    minX: minX - marginM,
    maxX: maxX + marginM,
    minZ: minZ - marginM,
    maxZ: maxZ + marginM,
  };
}

/**
 * ラスタのピクセル⇔コース座標の対応。
 * キャンバスの行0（画像の上端・テクスチャv=1）がコースz最大（奥）に対応する:
 * 平面はrotation.x=-π/2で床置きされ、ローカル+y（uv v=1側）はワールド-z=コース+zになる。
 */
export interface ZoneRasterLayout {
  widthPx: number;
  heightPx: number;
  /** キャンバス寸法から逆算した実カバー範囲 [m]（ceil誤差を吸収） */
  widthM: number;
  heightM: number;
  minX: number;
  maxZ: number;
  colToCourseX(col: number): number;
  rowToCourseZ(row: number): number;
}

export function zoneRasterLayout(bbox: CourseBBox, pxPerM: number): ZoneRasterLayout {
  const widthPx = Math.ceil((bbox.maxX - bbox.minX) * pxPerM);
  const heightPx = Math.ceil((bbox.maxZ - bbox.minZ) * pxPerM);
  const widthM = widthPx / pxPerM;
  const heightM = heightPx / pxPerM;
  const minX = bbox.minX;
  const maxZ = bbox.minZ + heightM;
  return {
    widthPx,
    heightPx,
    widthM,
    heightM,
    minX,
    maxZ,
    colToCourseX: (col) => minX + (col + 0.5) / pxPerM,
    rowToCourseZ: (row) => maxZ - (row + 0.5) / pxPerM,
  };
}

/** 区画帯ラスタの解像度 [px/m]（生成は課目切替時の1回だけ） */
const ZONE_PX_PER_M = 16;
/** ラスタの余白: 不合格帯の外側にこの幅だけ赤帯を見せる [m] */
const ZONE_MARGIN_BEYOND_FAIL_M = 1.5;

const COLOR_DEDUCT = { r: 255, g: 196, b: 40, a: 64 } as const;
const COLOR_FAIL = { r: 255, g: 70, b: 70, a: 52 } as const;

export class CourseMarkers {
  readonly group = new THREE.Group();
  private readonly zoneGroup = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(course: Course) {
    this.buildZonePlane(course);
    this.buildHRing(course);
    this.buildGuideLines(course);
    this.buildPylons(course);
    this.buildGroundMarkers(course);
    this.buildLabels(course);
    this.group.add(this.zoneGroup);
  }

  /** 区画帯の表示切替（練習モードのみ表示可） */
  setZonesVisible(visible: boolean): void {
    this.zoneGroup.visible = visible;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // --- 内部: 組み立て ---

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private buildZonePlane(course: Course): void {
    const bbox = computeCourseBBox(course.path, course.zoneBands.deductM + ZONE_MARGIN_BEYOND_FAIL_M);
    const layout = zoneRasterLayout(bbox, ZONE_PX_PER_M);

    const canvas = document.createElement('canvas');
    canvas.width = layout.widthPx;
    canvas.height = layout.heightPx;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(layout.widthPx, layout.heightPx);
    const zr = createZoneResult();
    let o = 0;
    for (let row = 0; row < layout.heightPx; row++) {
      const cz = layout.rowToCourseZ(row);
      for (let col = 0; col < layout.widthPx; col++) {
        evalZone(course.path, course.zoneBands, layout.colToCourseX(col), cz, zr);
        if (zr.zone === 'deduct') {
          img.data[o] = COLOR_DEDUCT.r;
          img.data[o + 1] = COLOR_DEDUCT.g;
          img.data[o + 2] = COLOR_DEDUCT.b;
          img.data[o + 3] = COLOR_DEDUCT.a;
        } else if (zr.zone === 'fail') {
          img.data[o] = COLOR_FAIL.r;
          img.data[o + 1] = COLOR_FAIL.g;
          img.data[o + 2] = COLOR_FAIL.b;
          img.data[o + 3] = COLOR_FAIL.a;
        }
        o += 4;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;

    const geo = this.track(new THREE.PlaneGeometry(layout.widthM, layout.heightM));
    const mat = this.track(
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    // コース座標の中心をワールドへ（world.x=course.x / world.z=-course.z）
    const ccx = layout.minX + layout.widthM / 2;
    const ccz = layout.maxZ - layout.heightM / 2;
    const w = { x: 0, z: 0 };
    courseToWorld(ccx, ccz, w);
    plane.position.set(w.x, 0.01, w.z);
    this.zoneGroup.add(plane);
  }

  private buildHRing(course: Course): void {
    const geo = this.track(new THREE.RingGeometry(H_PAD_RADIUS - 0.05, H_PAD_RADIUS + 0.05, 64));
    const mat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xf5f2e8,
        roughness: 0.2,
        metalness: 0.1,
        emissive: 0xf5f2e8,
        emissiveIntensity: 0.2,
        side: THREE.DoubleSide,
      }),
    );
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    const w = { x: 0, z: 0 };
    courseToWorld(course.h.x, course.h.z, w);
    ring.position.set(w.x, 0.012, w.z);
    this.group.add(ring);
  }

  /** 経路の中心線ガイド（白の細線。コース白線相当） */
  private buildGuideLines(course: Course): void {
    const mat = this.track(
      new THREE.LineBasicMaterial({ color: 0xf5f2e8, transparent: true, opacity: 0.65 }),
    );
    const w = { x: 0, z: 0 };
    const addLine = (courseXZ: Array<[number, number]>, loop: boolean): void => {
      const positions = new Float32Array(courseXZ.length * 3);
      for (let i = 0; i < courseXZ.length; i++) {
        courseToWorld(courseXZ[i][0], courseXZ[i][1], w);
        positions[i * 3] = w.x;
        positions[i * 3 + 1] = 0.014;
        positions[i * 3 + 2] = w.z;
      }
      const geo = this.track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this.group.add(loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat));
    };

    const path = course.path;
    if (path.kind === 'polygon') {
      addLine(
        path.points.map((p) => [p.x, p.z]),
        true,
      );
    } else if (path.kind === 'circles') {
      for (const c of path.circles) {
        const pts: Array<[number, number]> = [];
        const SEG = 72;
        for (let i = 0; i < SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          pts.push([c.center.x + c.radiusM * Math.cos(a), c.center.z + c.radiusM * Math.sin(a)]);
        }
        addLine(pts, true);
      }
    } else {
      addLine(
        [
          [path.from.x, path.from.z],
          [path.to.x, path.to.z],
        ],
        false,
      );
    }
  }

  private buildPylons(course: Course): void {
    const { heightM, radiusM, positions } = course.pylons;
    if (positions.length === 0) return;

    // ジオメトリ・マテリアルは全パイロンで共有（生成は課目切替時のみ）
    const coneGeo = this.track(new THREE.ConeGeometry(radiusM, heightM, 20));
    const baseGeo = this.track(new THREE.BoxGeometry(radiusM * 1.7, 0.02, radiusM * 1.7));
    // 白帯: コーン中腹の半径に合わせた円錐台リング
    const bandGeo = this.track(
      new THREE.CylinderGeometry(radiusM * 0.5, radiusM * 0.68, heightM * 0.17, 20, 1, true),
    );
    const orangeMat = this.track(
      new THREE.MeshPhysicalMaterial({
        color: 0xff5a1f,
        roughness: 0.3,
        metalness: 0.1,
        clearcoat: 0.4,
        clearcoatRoughness: 0.2,
      }),
    );
    const whiteMat = this.track(
      new THREE.MeshPhysicalMaterial({
        color: 0xf5f5f0,
        roughness: 0.2,
        metalness: 0.05,
        clearcoat: 0.3,
        side: THREE.DoubleSide,
      }),
    );

    const w = { x: 0, z: 0 };
    for (const pos of positions) {
      const pylon = new THREE.Group();
      const cone = new THREE.Mesh(coneGeo, orangeMat);
      cone.position.y = heightM / 2;
      cone.castShadow = true;
      const base = new THREE.Mesh(baseGeo, orangeMat);
      base.position.y = 0.01;
      const band = new THREE.Mesh(bandGeo, whiteMat);
      band.position.y = heightM * 0.47;
      pylon.add(cone, base, band);
      courseToWorld(pos.x, pos.z, w);
      pylon.position.set(w.x, 0, w.z);
      this.group.add(pylon);
    }
  }

  private buildGroundMarkers(course: Course): void {
    if (course.groundMarkers.length === 0) return;
    const geo = this.track(new THREE.CircleGeometry(0.15, 24));
    const mat = this.track(new THREE.MeshBasicMaterial({ color: 0xf5f2e8 }));
    const w = { x: 0, z: 0 };
    for (const m of course.groundMarkers) {
      const disc = new THREE.Mesh(geo, mat);
      disc.rotation.x = -Math.PI / 2;
      courseToWorld(m.x, m.z, w);
      disc.position.set(w.x, 0.011, w.z);
      this.group.add(disc);
    }
  }

  /** 経路の名前付き点（A/B/…）のラベルスプライト（idで重複排除） */
  private buildLabels(course: Course): void {
    const points = new Map<string, NamedPoint>();
    if (course.path.kind === 'polygon') {
      for (const p of course.path.points) points.set(p.id, p);
    } else if (course.path.kind === 'corridor') {
      points.set(course.path.from.id, course.path.from);
      points.set(course.path.to.id, course.path.to);
    }
    for (const m of course.groundMarkers) points.set(m.id, m);
    if (points.size === 0) return;

    const hasPylonAt = (p: NamedPoint): boolean =>
      course.pylons.positions.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1e-6);

    const w = { x: 0, z: 0 };
    for (const p of points.values()) {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext('2d')!;
      ctx.font = 'bold 72px "Hiragino Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(20, 20, 24, 0.9)';
      ctx.strokeText(p.id, 48, 52);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.id, 48, 52);
      const tex = this.track(new THREE.CanvasTexture(canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = this.track(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
      );
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.5, 0.5, 1);
      courseToWorld(p.x, p.z, w);
      sprite.position.set(w.x, hasPylonAt(p) ? course.pylons.heightM + 0.35 : 0.4, w.z);
      this.group.add(sprite);
    }
  }
}
