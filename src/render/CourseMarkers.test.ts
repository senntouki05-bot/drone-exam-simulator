/**
 * render/CourseMarkers.test.ts — 区画帯ラスタの座標対応（純関数部分）の検証。
 * キャンバスの行0=コースz最大（奥）・列0=コースx最小、の対応が崩れると
 * 区画帯の表示が判定と食い違うため、ここを機械検証で固定する。
 * （CourseMarkers本体はdocument依存のためnode環境ではテストしない＝目視受入）
 */

import { describe, expect, it } from 'vitest';
import { COURSES } from '../exam/Course';
import { computeCourseBBox, zoneRasterLayout } from './CourseMarkers';

describe('computeCourseBBox', () => {
  it('4-1 スクエア: 経路13m×5m＋余白', () => {
    const b = computeCourseBBox(COURSES[0].path, 4);
    expect(b.minX).toBeCloseTo(-10.5);
    expect(b.maxX).toBeCloseTo(10.5);
    expect(b.minZ).toBeCloseTo(-4);
    expect(b.maxZ).toBeCloseTo(9);
  });
  it('4-2 8の字: 円の外接10m×5m＋余白', () => {
    const b = computeCourseBBox(COURSES[1].path, 4);
    expect(b.minX).toBeCloseTo(-9);
    expect(b.maxX).toBeCloseTo(9);
    expect(b.minZ).toBeCloseTo(-6.5);
    expect(b.maxZ).toBeCloseTo(6.5);
  });
  it('4-3 直線: 13m線分＋余白', () => {
    const b = computeCourseBBox(COURSES[2].path, 4);
    expect(b.minX).toBeCloseTo(-10.5);
    expect(b.maxX).toBeCloseTo(10.5);
    expect(b.minZ).toBeCloseTo(-4);
    expect(b.maxZ).toBeCloseTo(4);
  });
});

describe('zoneRasterLayout', () => {
  const layout = zoneRasterLayout({ minX: -2, maxX: 2, minZ: -1, maxZ: 3 }, 16);
  it('ピクセル寸法と実カバー範囲が一致する', () => {
    expect(layout.widthPx).toBe(64);
    expect(layout.heightPx).toBe(64);
    expect(layout.widthM).toBeCloseTo(4);
    expect(layout.heightM).toBeCloseTo(4);
  });
  it('行0（画像上端）=コースz最大（奥）・行末=z最小', () => {
    expect(layout.rowToCourseZ(0)).toBeCloseTo(3 - 0.5 / 16);
    expect(layout.rowToCourseZ(63)).toBeCloseTo(-1 + 0.5 / 16);
  });
  it('列0=コースx最小・列末=x最大', () => {
    expect(layout.colToCourseX(0)).toBeCloseTo(-2 + 0.5 / 16);
    expect(layout.colToCourseX(63)).toBeCloseTo(2 - 0.5 / 16);
  });
  it('ceilの端数はカバー範囲を広げる方向に吸収する', () => {
    const l2 = zoneRasterLayout({ minX: 0, maxX: 1.03, minZ: 0, maxZ: 1.03 }, 16);
    expect(l2.widthPx).toBe(17);
    expect(l2.widthM).toBeCloseTo(17 / 16);
    expect(l2.maxZ).toBeCloseTo(17 / 16);
  });
});
