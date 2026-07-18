/**
 * exam/Course.test.ts — コース定義（data/courses/*.json）の読込・寸法・座標マッピングの検証。
 * 寸法の正本は細則（CLAUDE-CODE-PROMPT.md「試験仕様」節）。
 */

import { describe, expect, it } from 'vitest';
import { COURSES, courseToWorld, parseCourse, worldToCourse } from './Course';
import raw41 from '../../data/courses/course-4-1.json';

describe('COURSES 読込', () => {
  it('3課目が通し順（4-1→4-2→4-3）で読み込まれる', () => {
    expect(COURSES.map((c) => c.id)).toEqual(['4-1', '4-2', '4-3']);
  });

  it('4-1: 13m×5mスクエア・GPS・3.5m・8分・パイロン5本・H=(0,2.5)', () => {
    const c = COURSES[0];
    expect(c.flightMode).toBe('gps');
    expect(c.altitudeM).toBe(3.5);
    expect(c.timeLimitS).toBe(480);
    expect(c.h).toEqual({ x: 0, z: 2.5 });
    expect(c.pilot).toEqual({ x: 0, z: -8.5, eyeHeightM: 1.6 });
    if (c.path.kind !== 'polygon') throw new Error('4-1はpolygon');
    expect(c.path.points.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(c.path.points[1]).toMatchObject({ x: 6.5, z: 0 });
    expect(c.path.points[3]).toMatchObject({ x: -6.5, z: 5 });
    expect(c.pylons.positions).toHaveLength(5);
    expect(c.pylons.heightM).toBe(0.7);
    expect(c.pylons.radiusM).toBe(0.2);
    expect(c.winding).toBeNull();
  });

  it('4-2: φ5m円×2がHで接する・GPS・1.5m・8分・巻き数設定あり・連続2周', () => {
    const c = COURSES[1];
    expect(c.flightMode).toBe('gps');
    expect(c.altitudeM).toBe(1.5);
    expect(c.timeLimitS).toBe(480);
    expect(c.h).toEqual({ x: 0, z: 0 });
    if (c.path.kind !== 'circles') throw new Error('4-2はcircles');
    expect(c.path.circles).toHaveLength(2);
    expect(c.path.circles[0]).toMatchObject({ id: 'left', radiusM: 2.5 });
    expect(c.path.circles[0].center).toEqual({ x: -2.5, z: 0 });
    expect(c.path.circles[1].center).toEqual({ x: 2.5, z: 0 });
    expect(c.winding).not.toBeNull();
    expect(c.winding!.minSampleRadiusM).toBe(0.3);
    expect(c.winding!.switchHysteresisM).toBe(0.5);
    expect(c.windingLaps).toBe(2);
    expect(c.pylons.positions).toHaveLength(2);
  });

  it('4-3: 13m直線E–B・ATTI・3.5m・6分・パイロンなし・地上マーカーE/A/B・H=(0,2.5)', () => {
    const c = COURSES[2];
    expect(c.flightMode).toBe('atti');
    expect(c.altitudeM).toBe(3.5);
    expect(c.timeLimitS).toBe(360);
    expect(c.h).toEqual({ x: 0, z: 2.5 });
    if (c.path.kind !== 'corridor') throw new Error('4-3はcorridor');
    expect(c.path.from).toMatchObject({ id: 'E', x: -6.5, z: 0 });
    expect(c.path.to).toMatchObject({ id: 'B', x: 6.5, z: 0 });
    expect(c.pylons.positions).toHaveLength(0);
    expect(c.groundMarkers.map((m) => m.id)).toEqual(['E', 'A', 'B']);
    expect(c.winding).toBeNull();
  });

  it('全課目: 区画バンドは1.5m/2.5m・指示列は開始→…→課目終了まで揃っている', () => {
    for (const c of COURSES) {
      expect(c.zoneBands).toEqual({ freeM: 1.5, deductM: 2.5 });
      const ids = c.instructions.map((i) => i.id);
      expect(ids[0]).toBe('intro');
      expect(ids).toContain('takeoff');
      expect(ids).toContain('land');
      expect(ids).toContain('motor_stop');
      expect(ids[ids.length - 1]).toBe('end');
    }
  });
});

describe('座標マッピング（コース: x右・z奥 ⇔ ワールド: 受験者がz+側）', () => {
  it('コースの奥(z+)はワールドの-z', () => {
    const out = { x: 0, z: 0 };
    courseToWorld(0, 2.5, out);
    expect(out).toEqual({ x: 0, z: -2.5 });
  });
  it('受験者立ち位置はワールドでz+側になる', () => {
    const out = { x: 0, z: 0 };
    courseToWorld(COURSES[0].pilot.x, COURSES[0].pilot.z, out);
    expect(out.z).toBeGreaterThan(0);
  });
  it('往復変換で元に戻る', () => {
    const out = { x: 0, z: 0 };
    courseToWorld(1.25, -3.75, out);
    worldToCourse(out.x, out.z, out);
    expect(out).toEqual({ x: 1.25, z: -3.75 });
  });
});

describe('parseCourse の検証', () => {
  it('正しいJSONはパースできる', () => {
    expect(() => parseCourse('4-1', raw41)).not.toThrow();
  });
  it('flightModeが不正なら失敗', () => {
    expect(() => parseCourse('x', { ...raw41, flightMode: 'auto' })).toThrow(/flightMode/);
  });
  it('zoneBandsの大小関係が壊れていたら失敗', () => {
    expect(() =>
      parseCourse('x', { ...raw41, zoneBands: { freeM: 2.5, deductM: 1.5 } }),
    ).toThrow(/zoneBands/);
  });
  it('polygon経路にwindingを付けたら失敗', () => {
    expect(() =>
      parseCourse('x', {
        ...raw41,
        winding: { minSampleRadiusM: 0.3, switchHysteresisM: 0.5, fullTurnToleranceRad: 0.35, laps: 2 },
      }),
    ).toThrow(/winding/);
  });
});
