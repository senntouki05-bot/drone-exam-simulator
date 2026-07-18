/**
 * render/MiniMap.test.ts — ミニマップ射影（純関数 minimapLayout）の検証。
 * 「コース座標そのまま（x右・z上=奥）・等方スケール・中央寄せ」が崩れると
 * 上面図の向きや位置が3Dシーンと食い違うため、ここを機械検証で固定する。
 * （MiniMapクラス本体はdocument依存のためnode環境ではテストしない＝目視受入）
 */

import { describe, expect, it } from 'vitest';
import { COURSES } from '../exam/Course';
import { computeCourseBBox } from './CourseMarkers';
import { layoutPxX, layoutPxY, minimapLayout } from './MiniMap';

describe('minimapLayout', () => {
  it('横長bbox（4-1相当）は幅で律速し、等方スケールになる', () => {
    // 4-1: 経路13m×5m＋余白4m → 21m×13m
    const bbox = computeCourseBBox(COURSES[0].path, 4);
    const l = minimapLayout(bbox, 380, 300);
    expect(l.scale).toBeCloseTo(380 / 21);
    // 律速軸（x）はキャンバス幅いっぱいに写る
    expect(layoutPxX(l, bbox.minX)).toBeCloseTo(0);
    expect(layoutPxX(l, bbox.maxX)).toBeCloseTo(380);
  });

  it('bboxの中心はキャンバスの中心へ写る', () => {
    const bbox = computeCourseBBox(COURSES[0].path, 4);
    const l = minimapLayout(bbox, 380, 300);
    expect(layoutPxX(l, (bbox.minX + bbox.maxX) / 2)).toBeCloseTo(190);
    expect(layoutPxY(l, (bbox.minZ + bbox.maxZ) / 2)).toBeCloseTo(150);
  });

  it('z奥（大）ほど画面上（yPx小）に写る＝上面図の向き', () => {
    const bbox = computeCourseBBox(COURSES[0].path, 4);
    const l = minimapLayout(bbox, 380, 300);
    expect(layoutPxY(l, 5)).toBeLessThan(layoutPxY(l, 0));
    // x右はそのまま右
    expect(layoutPxX(l, 6.5)).toBeGreaterThan(layoutPxX(l, 0));
  });

  it('縦長bboxは高さで律速する', () => {
    const l = minimapLayout({ minX: -1, maxX: 1, minZ: -5, maxZ: 5 }, 100, 100);
    expect(l.scale).toBeCloseTo(10);
    expect(layoutPxY(l, 5)).toBeCloseTo(0); // z最大=上端
    expect(layoutPxY(l, -5)).toBeCloseTo(100); // z最小=下端
    expect(layoutPxX(l, 0)).toBeCloseTo(50); // 非律速軸は中央寄せ
  });

  it('全課目でbboxの四隅がキャンバス内に収まる', () => {
    const EPS = 1e-9;
    for (const course of COURSES) {
      const bbox = computeCourseBBox(course.path, course.zoneBands.deductM + 1.5);
      const l = minimapLayout(bbox, 380, 300);
      for (const x of [bbox.minX, bbox.maxX]) {
        expect(layoutPxX(l, x)).toBeGreaterThanOrEqual(-EPS);
        expect(layoutPxX(l, x)).toBeLessThanOrEqual(380 + EPS);
      }
      for (const z of [bbox.minZ, bbox.maxZ]) {
        expect(layoutPxY(l, z)).toBeGreaterThanOrEqual(-EPS);
        expect(layoutPxY(l, z)).toBeLessThanOrEqual(300 + EPS);
      }
    }
  });

  it('射影は線形: 1m移動がscale[px]の移動になる', () => {
    const l = minimapLayout({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 200, 200);
    expect(layoutPxX(l, 3) - layoutPxX(l, 2)).toBeCloseTo(l.scale);
    expect(layoutPxY(l, 2) - layoutPxY(l, 3)).toBeCloseTo(l.scale);
  });
});
