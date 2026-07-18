/**
 * exam/ScoreHistory.test.ts — スコア履歴（localStorage注入）のユニットテスト。
 *
 * 検証: 追加→新しい順のlist／MAX=50超過の切り捨て／壊れたJSONの空扱い＋add復旧／
 * 型不一致エントリの除外／clear／storage未注入（null）でのメモリ動作／保存失敗時の非クラッシュ。
 * ストレージは CalibrationStore.test.ts と同じMapベースの偽物を使う（node環境・DOM不要）。
 */

import { describe, expect, it } from 'vitest';
import {
  SCORE_HISTORY_KEY,
  SCORE_HISTORY_MAX,
  ScoreHistory,
  type ScoreEntry,
} from './ScoreHistory';

/** localStorage互換のモック（Mapベース・removeItem付き） */
function makeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** テスト用エントリ生成（atは呼び出し側が与える仕様＝ここで明示的に組み立てる） */
function entry(over: Partial<ScoreEntry> = {}): ScoreEntry {
  return {
    at: '2026-07-19T10:00:00.000Z',
    kind: 'practice',
    courseId: 'course-4-1',
    label: 'スクエア飛行',
    machineId: 'phantom4-like',
    points: 95,
    passed: true,
    failCode: null,
    endReason: 'completed',
    elapsedS: 123.4,
    ...over,
  };
}

describe('ScoreHistory（追加とlistの順序）', () => {
  it('add順の逆＝新しい順でlistされる', () => {
    const h = new ScoreHistory(makeStorage());
    h.add(entry({ label: '1回目' }));
    h.add(entry({ label: '2回目' }));
    h.add(entry({ label: '3回目' }));
    expect(h.list().map((e) => e.label)).toEqual(['3回目', '2回目', '1回目']);
  });

  it('保存されたエントリは全フィールドが往復で保たれる', () => {
    const h = new ScoreHistory(makeStorage());
    const e = entry({
      kind: 'exam',
      courseId: 'series',
      label: '試験（3課目通し）',
      points: 55,
      passed: false,
      failCode: 'ZONE_FAIL',
      endReason: 'fail_immediate',
      elapsedS: 310.25,
    });
    h.add(e);
    expect(h.list()).toEqual([e]);
    expect(h.list()[0]).not.toBe(e); // JSON往復した別オブジェクト
  });

  it('同じstorageを共有する別インスタンスから履歴が見える（毎回storageから読む）', () => {
    const storage = makeStorage();
    const a = new ScoreHistory(storage);
    a.add(entry({ label: 'Aが追加' }));
    const b = new ScoreHistory(storage);
    expect(b.list().map((e) => e.label)).toEqual(['Aが追加']);
  });
});

describe('ScoreHistory（MAX件数の切り捨て）', () => {
  it(`MAX=${SCORE_HISTORY_MAX}を超えたら古い方から捨てる`, () => {
    const h = new ScoreHistory(makeStorage());
    for (let i = 1; i <= SCORE_HISTORY_MAX + 3; i++) {
      h.add(entry({ label: `run-${i}` }));
    }
    const list = h.list();
    expect(list).toHaveLength(SCORE_HISTORY_MAX);
    expect(list[0].label).toBe(`run-${SCORE_HISTORY_MAX + 3}`); // 最新が先頭
    expect(list[list.length - 1].label).toBe('run-4'); // run-1〜3が捨てられた
  });
});

describe('ScoreHistory（壊れたデータへの耐性）', () => {
  it('壊れたJSONは空扱いで、addすると正常データに復旧する', () => {
    const storage = makeStorage();
    storage.map.set(SCORE_HISTORY_KEY, '{not json');
    const h = new ScoreHistory(storage);
    expect(h.list()).toEqual([]); // 例外を投げず空
    h.add(entry({ label: '復旧後' }));
    expect(h.list().map((e) => e.label)).toEqual(['復旧後']);
    expect(() => JSON.parse(storage.map.get(SCORE_HISTORY_KEY)!)).not.toThrow(); // 正常JSONで上書き
  });

  it('ルートが配列でないJSONは空扱い', () => {
    const storage = makeStorage();
    storage.map.set(SCORE_HISTORY_KEY, JSON.stringify({ oops: true }));
    expect(new ScoreHistory(storage).list()).toEqual([]);
  });

  it('型不一致エントリは黙って除外し、正常エントリだけ返す', () => {
    const storage = makeStorage();
    const good = entry({ label: '正常' });
    const mixed = [
      good,
      { ...entry(), kind: 'unknown-kind' }, // kindが列挙外
      { ...entry(), points: '95' }, // pointsが文字列
      { ...entry(), failCode: 123 }, // failCodeがstring|null以外
      { ...entry(), passed: undefined }, // フィールド欠落相当
      null,
      'garbage',
      42,
      [],
    ];
    storage.map.set(SCORE_HISTORY_KEY, JSON.stringify(mixed));
    expect(new ScoreHistory(storage).list()).toEqual([good]);
  });

  it('failCode=nullは正常値として通す', () => {
    const storage = makeStorage();
    storage.map.set(SCORE_HISTORY_KEY, JSON.stringify([entry({ failCode: null })]));
    expect(new ScoreHistory(storage).list()).toHaveLength(1);
  });

  it('setItemが例外（容量超過等）でもaddはクラッシュしない', () => {
    const storage = makeStorage();
    const h = new ScoreHistory(storage);
    h.add(entry({ label: '保存済み' }));
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => h.add(entry({ label: '保存失敗' }))).not.toThrow();
    expect(h.list().map((e) => e.label)).toEqual(['保存済み']); // 直前の状態を維持
  });

  it('getItem/removeItemが例外でもlist/clearはクラッシュしない', () => {
    const storage = makeStorage();
    storage.getItem = () => {
      throw new Error('SecurityError');
    };
    storage.removeItem = () => {
      throw new Error('SecurityError');
    };
    const h = new ScoreHistory(storage);
    expect(h.list()).toEqual([]);
    expect(() => h.clear()).not.toThrow();
  });
});

describe('ScoreHistory（clear）', () => {
  it('clearで全件消え、storageのキー自体が消える', () => {
    const storage = makeStorage();
    const h = new ScoreHistory(storage);
    h.add(entry());
    h.add(entry());
    h.clear();
    expect(h.list()).toEqual([]);
    expect(storage.map.has(SCORE_HISTORY_KEY)).toBe(false);
  });
});

describe('ScoreHistory（storage=nullのメモリフォールバック）', () => {
  it('null注入でもadd/list/clearがメモリ内で機能する', () => {
    const h = new ScoreHistory(null);
    h.add(entry({ label: '1回目' }));
    h.add(entry({ label: '2回目' }));
    expect(h.list().map((e) => e.label)).toEqual(['2回目', '1回目']);
    h.clear();
    expect(h.list()).toEqual([]);
  });

  it('メモリ動作でもMAX超過で切り捨てる', () => {
    const h = new ScoreHistory(null);
    for (let i = 1; i <= SCORE_HISTORY_MAX + 2; i++) {
      h.add(entry({ label: `run-${i}` }));
    }
    expect(h.list()).toHaveLength(SCORE_HISTORY_MAX);
    expect(h.list()[0].label).toBe(`run-${SCORE_HISTORY_MAX + 2}`);
  });

  it('listが返す配列を書き換えても内部履歴は汚れない', () => {
    const h = new ScoreHistory(null);
    h.add(entry({ label: '本物' }));
    const out = h.list();
    out.pop();
    out.push(entry({ label: '偽物' }));
    expect(h.list().map((e) => e.label)).toEqual(['本物']);
  });

  it('引数省略（localStorage不在のnode環境）でもメモリ動作にフォールバックする', () => {
    // node(Vitest既定環境)にはlocalStorageが無い想定。無くてもクラッシュせず動くこと。
    // （万一環境がlocalStorageを持っていても、clear→add→listの往復は成立する）
    const h = new ScoreHistory();
    h.clear();
    h.add(entry({ label: '既定ストレージなし' }));
    expect(h.list().map((e) => e.label)).toEqual(['既定ストレージなし']);
    h.clear();
  });
});
