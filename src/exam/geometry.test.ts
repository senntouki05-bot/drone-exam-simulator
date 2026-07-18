/**
 * exam/geometry.test.ts — M3純幾何関数の単体テスト。
 *
 * 寸法は細則どおり（4-1: 13m×5m矩形／4-2: φ5m円×2／4-3: 13m直線・境界矩形18m×5m）。
 * 巻き数はプロンプト指定のケース群（左右円×回転方向の4通り＋ショートカット＋H直上揺れ）。
 */

import { describe, expect, it } from 'vitest';
import {
  H_PAD_RADIUS,
  WindingTracker,
  createZoneResult,
  distanceToSegment,
  evalZone,
  inHCircle,
  pylonCollisionIndex,
  type CirclesPath,
  type CorridorPath,
  type PolygonPath,
  type PylonSet,
  type WindingConfig,
  type ZoneBands,
} from './geometry';

const BANDS: ZoneBands = { freeM: 1.5, deductM: 2.5 };

/** 4-1 スクエア: A(0,0) B(6.5,0) C(6.5,5) D(-6.5,5) E(-6.5,0) */
const SQUARE: PolygonPath = {
  kind: 'polygon',
  points: [
    { id: 'A', x: 0, z: 0 },
    { id: 'B', x: 6.5, z: 0 },
    { id: 'C', x: 6.5, z: 5 },
    { id: 'D', x: -6.5, z: 5 },
    { id: 'E', x: -6.5, z: 0 },
  ],
};

/** 4-2 8の字: 直径5mの円2つが原点(H)で接する */
const EIGHT: CirclesPath = {
  kind: 'circles',
  circles: [
    { id: 'left', center: { x: -2.5, z: 0 }, radiusM: 2.5 },
    { id: 'right', center: { x: 2.5, z: 0 }, radiusM: 2.5 },
  ],
};

/** 4-3 直線: E(-6.5,0)–B(6.5,0) */
const LINE: CorridorPath = {
  kind: 'corridor',
  from: { id: 'E', x: -6.5, z: 0 },
  to: { id: 'B', x: 6.5, z: 0 },
};

function zone(path: PolygonPath | CirclesPath | CorridorPath, x: number, z: number) {
  return evalZone(path, BANDS, x, z, createZoneResult());
}

describe('distanceToSegment', () => {
  it('線分中央への垂線距離', () => {
    expect(distanceToSegment(0, 2, -1, 0, 1, 0)).toBeCloseTo(2);
  });
  it('端点の外側は端点までの距離', () => {
    expect(distanceToSegment(3, 4, -1, 0, 1, 0)).toBeCloseTo(Math.hypot(2, 4));
  });
  it('退化した線分（点）でも動く', () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe('evalZone 4-1 スクエア（閉多角形）', () => {
  it('経路上は自由帯・距離0', () => {
    const r = zone(SQUARE, 0, 0);
    expect(r.zone).toBe('free');
    expect(r.distM).toBeCloseTo(0);
  });
  it('H(0,2.5)は内側減点区画の中（距離2.5m・矩形の中心）', () => {
    const r = zone(SQUARE, 0, 2.5);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('inner');
    expect(r.distM).toBeCloseTo(2.5);
  });
  it('内側1.0mは自由帯', () => {
    const r = zone(SQUARE, 0, 1.0);
    expect(r.zone).toBe('free');
    expect(r.zoneId).toBe('inner');
  });
  it('内側2.0mは減点区画', () => {
    expect(zone(SQUARE, 0, 2.0).zone).toBe('deduct');
  });
  it('外側1.6mは減点区画（最寄りレグ=A-B）', () => {
    const r = zone(SQUARE, 1, -1.6);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('outer');
    expect(r.legId).toBe('A-B');
  });
  it('外側2.6mは不合格区画', () => {
    expect(zone(SQUARE, 1, -2.6).zone).toBe('fail');
  });
  it('角の外側はユークリッド距離（斜め2m,2mで2.83m→不合格）', () => {
    expect(zone(SQUARE, 8.5, -2).zone).toBe('fail');
  });
  it('内側に不合格区画は幾何的に発生しない（矩形の半幅=2.5mが上限）', () => {
    for (let x = -6.4; x <= 6.4; x += 0.4) {
      for (let z = 0.1; z <= 4.9; z += 0.4) {
        expect(zone(SQUARE, x, z).zone).not.toBe('fail');
      }
    }
  });
});

describe('evalZone 4-2 8の字（円2つ）', () => {
  it('H(0,0)=接点は経路上・自由帯', () => {
    const r = zone(EIGHT, 0, 0);
    expect(r.zone).toBe('free');
    expect(r.distM).toBeCloseTo(0);
  });
  it('円中心は内側減点区画（円周から2.5m）', () => {
    const r = zone(EIGHT, -2.5, 0);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('inner-left');
    expect(r.legId).toBe('left');
  });
  it('中心から0.9m（円周から1.6m）は内側減点区画=中心の半径1m円と同値', () => {
    const r = zone(EIGHT, -1.6, 0);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('inner-left');
  });
  it('中心から1.1m（円周から1.4m）は自由帯', () => {
    expect(zone(EIGHT, -1.4, 0).zone).toBe('free');
  });
  it('右円の内側も同様', () => {
    const r = zone(EIGHT, 2.5, 0);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('inner-right');
  });
  it('外側: 接点の手前(0,-4)は減点区画', () => {
    const r = zone(EIGHT, 0, -4);
    expect(r.zone).toBe('deduct');
    expect(r.zoneId).toBe('outer');
  });
  it('外側: (0,-4.6)は不合格区画（両円周から2.5m超）', () => {
    expect(zone(EIGHT, 0, -4.6).zone).toBe('fail');
  });
  it('外側: (0,3)は自由帯（円周から約1.4m）', () => {
    expect(zone(EIGHT, 0, 3).zone).toBe('free');
  });
});

describe('evalZone 4-3 直線（矩形バンド）', () => {
  it('直線上は自由帯・レグ=E-B', () => {
    const r = zone(LINE, 0, 0);
    expect(r.zone).toBe('free');
    expect(r.legId).toBe('E-B');
  });
  it('H(0,2.5)は不合格境界上=減点区画（不合格ではない）', () => {
    const r = zone(LINE, 0, 2.5);
    expect(r.zone).toBe('deduct');
    expect(r.distM).toBeCloseTo(2.5);
  });
  it('(0,2.6)は不合格区画（M4テスト「4-3往復中に流される」の幾何部分）', () => {
    expect(zone(LINE, 0, 2.6).zone).toBe('fail');
  });
  it('端点Bの先1.0mは自由帯（境界矩形は端方向にも伸びる）', () => {
    expect(zone(LINE, 7.5, 0).zone).toBe('free');
  });
  it('端点Bの先2.6mは不合格区画（境界矩形18m×5mの外）', () => {
    expect(zone(LINE, 9.1, 0).zone).toBe('fail');
  });
  it('端の角(8.9,2.4)は矩形距離で減点区画（ユークリッドなら3.4mで不合格になってしまう）', () => {
    const r = zone(LINE, 8.9, 2.4);
    expect(r.zone).toBe('deduct');
    expect(r.distM).toBeCloseTo(2.4);
  });
  it('斜めの合成(8.0,2.0)は矩形距離max(1.5,2.0)=2.0で減点区画', () => {
    expect(zone(LINE, 8.0, 2.0).distM).toBeCloseTo(2.0);
  });
});

describe('inHCircle', () => {
  const h = { x: 0, z: 2.5 };
  it('半径ちょうど1.0mまでがH円内（境界含む）', () => {
    expect(inHCircle(0, 2.5, h)).toBe(true);
    expect(inHCircle(H_PAD_RADIUS, 2.5, h)).toBe(true);
    expect(inHCircle(1.01, 2.5, h)).toBe(false);
  });
});

describe('pylonCollisionIndex', () => {
  const pylons: PylonSet = {
    heightM: 0.7,
    radiusM: 0.2,
    positions: [
      { x: 0, z: 0 },
      { x: 6.5, z: 0 },
    ],
  };
  const MACHINE_R = 0.3;
  it('高度3.5mでパイロン直上通過→衝突なし', () => {
    expect(pylonCollisionIndex(0, 0, 3.5, MACHINE_R, pylons)).toBe(-1);
  });
  it('高度0.5mで接触→CRASH（該当パイロンのindex）', () => {
    expect(pylonCollisionIndex(0, 0, 0.5, MACHINE_R, pylons)).toBe(0);
    expect(pylonCollisionIndex(6.5, 0.3, 0.5, MACHINE_R, pylons)).toBe(1);
  });
  it('水平距離が機体半径+パイロン半径以上なら接触しない', () => {
    expect(pylonCollisionIndex(0.55, 0, 0.5, MACHINE_R, pylons)).toBe(-1);
    expect(pylonCollisionIndex(0.45, 0, 0.5, MACHINE_R, pylons)).toBe(0);
  });
  it('機体下端がパイロン高さちょうどなら衝突しない（未満のときのみ評価）', () => {
    expect(pylonCollisionIndex(0, 0, 0.7, MACHINE_R, pylons)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 巻き数アキュムレータ
// ---------------------------------------------------------------------------

const WINDING: WindingConfig = {
  circles: EIGHT.circles,
  hCenter: { x: 0, z: 0 },
  minSampleRadiusM: 0.3,
  switchHysteresisM: 0.5,
  fullTurnToleranceRad: 0.35,
};

/** 円周上の点列を生成（fromRad→toRadへstep刻み・両端含む） */
function circleArc(
  center: { x: number; z: number },
  radius: number,
  fromRad: number,
  toRad: number,
  stepRad: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const dir = Math.sign(toRad - fromRad);
  const n = Math.ceil(Math.abs(toRad - fromRad) / stepRad);
  for (let i = 0; i <= n; i++) {
    const a = fromRad + dir * Math.min(i * stepRad, Math.abs(toRad - fromRad));
    pts.push([center.x + radius * Math.cos(a), center.z + radius * Math.sin(a)]);
  }
  return pts;
}

const STEP = (5 * Math.PI) / 180;
const LEFT = EIGHT.circles[0];
const RIGHT = EIGHT.circles[1];

describe('WindingTracker', () => {
  it.each([
    ['左円・反時計回り', LEFT, 0, Math.PI * 2, 'left', 1],
    ['左円・時計回り', LEFT, 0, -Math.PI * 2, 'left', -1],
    ['右円・反時計回り', RIGHT, Math.PI, Math.PI * 3, 'right', 1],
    ['右円・時計回り', RIGHT, Math.PI, -Math.PI, 'right', -1],
  ] as const)('%s の1周で±2π到達', (_label, circle, from, to, id, sign) => {
    const w = new WindingTracker(WINDING);
    for (const [x, z] of circleArc(circle.center, circle.radiusM, from, to, STEP)) {
      expect(w.update(x, z)).toBeNull(); // 単円周回では切替イベントは出ない
    }
    const end = w.finish();
    expect(end).not.toBeNull();
    expect(end!.circleId).toBe(id);
    expect(end!.fullTurn).toBe(true);
    expect(Math.sign(end!.accumRad)).toBe(sign);
    expect(Math.abs(end!.accumRad)).toBeGreaterThan(Math.PI * 2 - WINDING.fullTurnToleranceRad);
  });

  it('8の字（左CCW→右CW）: 切替で左円のfullTurnが報告され、終了で右円も揃う', () => {
    const w = new WindingTracker(WINDING);
    const events = [];
    // 左円を反時計回りに1周（H発→H着）→続けて右円を時計回りに1周
    for (const [x, z] of circleArc(LEFT.center, LEFT.radiusM, 0, Math.PI * 2, STEP)) {
      const ev = w.update(x, z);
      if (ev) events.push(ev);
    }
    for (const [x, z] of circleArc(RIGHT.center, RIGHT.radiusM, Math.PI, -Math.PI, STEP)) {
      const ev = w.update(x, z);
      if (ev) events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].circleId).toBe('left');
    expect(events[0].fullTurn).toBe(true);
    expect(events[0].accumRad).toBeGreaterThan(0); // 反時計回り=正
    const last = w.finish();
    expect(last!.circleId).toBe('right');
    expect(last!.fullTurn).toBe(true);
    expect(last!.accumRad).toBeLessThan(0); // 時計回り=負
  });

  it('H付近を斜めに横切るショートカット: 半周+直線横断では2πに達しない（CENTER_MISS素材）', () => {
    const w = new WindingTracker(WINDING);
    // 左円をH(θ=0)から反時計回りに半周（θ=π: 点(-5,0)）
    for (const [x, z] of circleArc(LEFT.center, LEFT.radiusM, 0, Math.PI, STEP)) {
      w.update(x, z);
    }
    // そこから中心(-2.5,0)を直線で横切ってHへ（中心近傍0.3mはスキップされる）
    for (let x = -5; x <= 0; x += 0.1) {
      w.update(x, 0);
    }
    // 右円側へ抜けて切替を発生させる
    let ev = null;
    for (let x = 0.1; x <= 1.2; x += 0.1) {
      ev = w.update(x, -0.4) ?? ev;
    }
    expect(ev).not.toBeNull();
    expect(ev!.circleId).toBe('left');
    expect(ev!.fullTurn).toBe(false);
    expect(Math.abs(ev!.accumRad)).toBeLessThan(Math.PI * 1.5);
  });

  it('H直上で往復してxの符号が揺れてもヒステリシス内なら切替しない', () => {
    const w = new WindingTracker(WINDING);
    // まず左円側で確立
    for (const [x, z] of circleArc(LEFT.center, LEFT.radiusM, 0, Math.PI / 2, STEP)) {
      w.update(x, z);
    }
    expect(w.activeCircleId).toBe('left');
    // H直上(0.5m未満)でx符号が揺れる
    for (let i = 0; i < 40; i++) {
      const ev = w.update(i % 2 === 0 ? 0.2 : -0.2, i % 3 === 0 ? 0.1 : -0.1);
      expect(ev).toBeNull();
    }
    expect(w.activeCircleId).toBe('left');
  });

  it('中心近傍スキップ: 中心を通過しても見かけのπ回転を累積しない', () => {
    const w = new WindingTracker(WINDING);
    // 左円側で確立（θ=π/2の点から）
    w.update(-2.5, 2.5); // 左円周上・H から2.5m → activate
    w.update(-2.5, 2.0);
    const before = w.accumRad;
    // 中心の真上から真下へ縦断（|中心からの距離|<0.3の帯を通過）
    for (let z = 0.4; z >= -0.4; z -= 0.05) {
      w.update(-2.5, z);
    }
    // atan2の飛び（π/2→-π/2）が最短経路+スキップ再シードで処理され、±πの暴発がない
    expect(Math.abs(w.accumRad - before)).toBeLessThan(0.2);
  });

  it('円がH同側にある設定は拒否する', () => {
    expect(
      () =>
        new WindingTracker({
          ...WINDING,
          circles: [
            { id: 'a', center: { x: 1, z: 0 }, radiusM: 1 },
            { id: 'b', center: { x: 3, z: 0 }, radiusM: 1 },
          ],
        }),
    ).toThrow();
  });
});
