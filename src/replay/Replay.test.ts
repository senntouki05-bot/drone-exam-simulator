/**
 * replay/Replay.test.ts — リプレイ記録・シリアライズ・再生のユニットテスト（node環境・DOM非依存）。
 *
 * 検証項目（担当仕様の最低ライン）:
 * - 240Hz×10秒 → 20Hzへ間引かれ約200サンプル（±5%）・先頭サンプル保持
 * - serialize→parse 往復一致
 * - parse: version不一致・samples欠損・NaN混入などの不正データをthrow
 * - Player: 位置の線形補間・nlerpの単位長と符号合わせ・範囲外クランプ・modeの直近過去
 * - record()のp/qコピー（呼び出し後に元オブジェクトを書き換えても記録が変わらない）
 */

import { describe, expect, it } from 'vitest';
import type { DeductionEvent } from '../exam/ScoringEngine';
import type { FlightMode, Quat, Vec3 } from '../sim/FlightModel';
import {
  REPLAY_HZ,
  ReplayPlayer,
  ReplayRecorder,
  parseReplay,
  serializeReplay,
  type ReplayRecording,
  type ReplaySample,
} from './Replay';

/** 単位クォータニオン（無回転） */
const Q_ID: Quat = { x: 0, y: 0, z: 0, w: 1 };

function sample(t: number, p: Partial<Vec3> = {}, q: Quat = Q_ID, mode: FlightMode = 'gps'): ReplaySample {
  return { t, p: { x: 0, y: 0, z: 0, ...p }, q: { ...q }, mode };
}

function recording(samples: ReplaySample[], events: DeductionEvent[] = []): ReplayRecording {
  return { version: 1, machineId: 'phantom4-like', courseId: 'course-4-1', samples, events };
}

/** 補間出力の書き込み先（sampleAtはアロケーションなし前提なので使い回す） */
function makeOut(): { p: Vec3; q: Quat; mode: FlightMode } {
  return { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, mode: 'gps' };
}

const EVENT: DeductionEvent = {
  t: 12.3,
  code: 'ZONE_DEV',
  points: -5,
  immediate: false,
  reason: '減点区画へ進入（同レグ2回目）',
  pos: { x: 6.5, z: 4.2 },
  phase: 'work',
  zoneId: 'outer',
};

describe('ReplayRecorder', () => {
  it('240Hz×10秒の入力が約200サンプル（±5%）に間引かれ、先頭サンプルを含む', () => {
    const rec = new ReplayRecorder('phantom4-like', 'course-4-1');
    const hz = 240;
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < hz * 10; i++) {
      const t = i / hz;
      p.x = t; // 位置も動かしておく（先頭サンプル確認用）
      rec.record(t, p, Q_ID, 'gps');
    }
    const expected = REPLAY_HZ * 10; // 200
    expect(rec.sampleCount).toBeGreaterThanOrEqual(expected * 0.95);
    expect(rec.sampleCount).toBeLessThanOrEqual(expected * 1.05);
    const out = rec.finish();
    expect(out.samples[0].t).toBe(0);
    expect(out.samples[0].p.x).toBe(0);
    // 間引き後も時系列は単調増加
    for (let i = 1; i < out.samples.length; i++) {
      expect(out.samples[i].t).toBeGreaterThan(out.samples[i - 1].t);
    }
  });

  it('record()はp/qをコピーして格納する（元オブジェクトの書き換えが記録に影響しない）', () => {
    const rec = new ReplayRecorder('m', 'c');
    const p: Vec3 = { x: 1, y: 2, z: 3 };
    const q: Quat = { x: 0, y: 0.6, z: 0, w: 0.8 };
    rec.record(0, p, q, 'atti');
    p.x = 999;
    q.w = -123;
    const out = rec.finish();
    expect(out.samples[0].p).toEqual({ x: 1, y: 2, z: 3 });
    expect(out.samples[0].q).toEqual({ x: 0, y: 0.6, z: 0, w: 0.8 });
    expect(out.samples[0].mode).toBe('atti');
  });

  it('finish()のスナップショットは以後の記録・イベント追加の影響を受けない', () => {
    const rec = new ReplayRecorder('m', 'c');
    rec.record(0, { x: 0, y: 0, z: 0 }, Q_ID, 'gps');
    const snap = rec.finish();
    rec.record(1, { x: 5, y: 0, z: 0 }, Q_ID, 'gps');
    rec.addEvent(EVENT);
    expect(snap.samples).toHaveLength(1);
    expect(snap.events).toHaveLength(0);
    expect(rec.sampleCount).toBe(2);
  });
});

describe('serializeReplay / parseReplay', () => {
  it('serialize→parseの往復で一致する（イベント含む）', () => {
    const rec = new ReplayRecorder('soten-like', 'course-4-3');
    rec.record(0, { x: 0, y: 0, z: -2.5 }, Q_ID, 'atti');
    rec.record(0.05, { x: 0.1, y: 0.5, z: -2.5 }, { x: 0, y: 0.6, z: 0, w: 0.8 }, 'atti');
    rec.addEvent(EVENT);
    const original = rec.finish();
    const parsed = parseReplay(serializeReplay(original));
    expect(parsed).toEqual(original);
  });

  it('version不一致はthrow', () => {
    const bad = { ...recording([sample(0)]), version: 2 };
    expect(() => parseReplay(JSON.stringify(bad))).toThrow(/version/);
  });

  it('samples欠損はthrow', () => {
    const bad: Record<string, unknown> = { ...recording([sample(0)]) };
    delete bad.samples;
    expect(() => parseReplay(JSON.stringify(bad))).toThrow(/samples/);
  });

  it('サンプル位置のNaN混入はthrow（JSONのnull経由）', () => {
    // JSON.stringifyはNaNをnullにするため、null混入として届くケースを検証
    const bad = recording([sample(0, { y: NaN })]);
    expect(() => parseReplay(serializeReplay(bad))).toThrow(/p\.y/);
  });

  it('サンプルtの非有限値・mode不正・イベントの非有限値もthrow', () => {
    const badT = JSON.stringify(recording([{ ...sample(0), t: 'x' as unknown as number }]));
    expect(() => parseReplay(badT)).toThrow(/t/);
    const badMode = JSON.stringify(recording([{ ...sample(0), mode: 'auto' as FlightMode }]));
    expect(() => parseReplay(badMode)).toThrow(/mode/);
    const badEvent = JSON.stringify(recording([sample(0)], [{ ...EVENT, points: NaN }]));
    expect(() => parseReplay(badEvent)).toThrow(/points/);
  });

  it('JSONとして壊れた文字列・非オブジェクトはthrow', () => {
    expect(() => parseReplay('{oops')).toThrow(/JSON/);
    expect(() => parseReplay('[1,2,3]')).toThrow(/オブジェクト/);
  });
});

describe('ReplayPlayer', () => {
  it('samplesが空ならthrow', () => {
    expect(() => new ReplayPlayer(recording([]))).toThrow(/サンプル/);
  });

  it('startT/durationSが先頭・末尾サンプルから求まる', () => {
    const player = new ReplayPlayer(recording([sample(2), sample(2.5), sample(7)]));
    expect(player.startT).toBe(2);
    expect(player.durationS).toBe(5);
  });

  it('2サンプル間の中点で位置が線形補間される', () => {
    const player = new ReplayPlayer(
      recording([sample(0, { x: 1, y: 2, z: 3 }), sample(1, { x: 3, y: 6, z: -1 })]),
    );
    const out = makeOut();
    player.sampleAt(0.5, out);
    expect(out.p.x).toBeCloseTo(2, 10);
    expect(out.p.y).toBeCloseTo(4, 10);
    expect(out.p.z).toBeCloseTo(1, 10);
  });

  it('姿勢のnlerp結果は単位長になる', () => {
    // 単位qどうしの中間はlerpのままだと長さ<1になる組（ヨー90°差）で正規化を確認
    const qYaw90: Quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const player = new ReplayPlayer(recording([sample(0, {}, Q_ID), sample(1, {}, qYaw90)]));
    const out = makeOut();
    player.sampleAt(0.5, out);
    const len = Math.hypot(out.q.x, out.q.y, out.q.z, out.q.w);
    expect(len).toBeCloseTo(1, 10);
    // この対称ケースでは正規化中点がヨー45°のクォータニオンに一致する
    expect(out.q.y).toBeCloseTo(Math.sin(Math.PI / 8), 10);
    expect(out.q.w).toBeCloseTo(Math.cos(Math.PI / 8), 10);
  });

  it('nlerpの符号合わせ: qと-q（同一回転）の間で補間が破綻しない', () => {
    // 符号合わせなしのlerpだと中点で零ベクトルになる最悪ケース
    const qNeg: Quat = { x: -0, y: -0, z: -0, w: -1 };
    const player = new ReplayPlayer(recording([sample(0, {}, Q_ID), sample(1, {}, qNeg)]));
    const out = makeOut();
    player.sampleAt(0.5, out);
    const len = Math.hypot(out.q.x, out.q.y, out.q.z, out.q.w);
    expect(len).toBeCloseTo(1, 10);
    // 実質無回転のまま（wの符号はどちらでも同一回転だが、符号合わせ後は+1側）
    expect(Math.abs(out.q.w)).toBeCloseTo(1, 10);
  });

  it('範囲外は端のサンプルへクランプされる', () => {
    const player = new ReplayPlayer(
      recording([sample(1, { x: 10 }, Q_ID, 'gps'), sample(2, { x: 20 }, Q_ID, 'atti')]),
    );
    const out = makeOut();
    player.sampleAt(0, out); // 先頭より前
    expect(out.p.x).toBe(10);
    expect(out.mode).toBe('gps');
    player.sampleAt(99, out); // 末尾より後
    expect(out.p.x).toBe(20);
    expect(out.mode).toBe('atti');
  });

  it('modeは直近過去サンプルの値（補間しない）', () => {
    const player = new ReplayPlayer(
      recording([
        sample(0, {}, Q_ID, 'gps'),
        sample(0.05, {}, Q_ID, 'atti'),
        sample(0.1, {}, Q_ID, 'atti'),
      ]),
    );
    const out = makeOut();
    player.sampleAt(0.03, out);
    expect(out.mode).toBe('gps'); // 直近過去=t0のgps
    player.sampleAt(0.05, out);
    expect(out.mode).toBe('atti'); // ちょうど切替サンプル上はそのサンプルの値
    player.sampleAt(0.07, out);
    expect(out.mode).toBe('atti');
  });
});
