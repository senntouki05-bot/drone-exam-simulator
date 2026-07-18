/**
 * exam/ScoreHistory.ts — M5: スコア履歴のlocalStorage保存/読出（試験モード・練習モード共通）。
 *
 * 実装原則3: exam/配下はヘッドレス＝DOM・WebGL・Audio系APIをimportしない。
 * ストレージは input/CalibrationStore.ts と同じ注入パターン: コンストラクタで
 * localStorage互換オブジェクトを受け取り、Vitest(node環境)からは偽ストレージで検証する。
 * 未指定(undefined)なら globalThis.localStorage を存在チェック付きで既定使用、
 * null または localStorage の無い環境ではインスタンス内配列のメモリ動作にフォールバックする。
 *
 * 記録時刻 `at` は呼び出し側が渡す（本モジュールは Date.now() を呼ばない＝決定的テストのため）。
 * 保存失敗（容量超過・プライベートモード等）はクラッシュさせず黙って無視する。
 * 読出時、壊れたJSONは空扱い・型不一致エントリは黙って除外する（次のaddで正常データに復旧）。
 */

/** 1回分の受験/練習結果 */
export interface ScoreEntry {
  /** ISO8601（呼び出し側が入れる。本モジュールでDate.now()を勝手に呼ばない） */
  at: string;
  /** 課目単体練習 / 試験モード通し */
  kind: 'practice' | 'exam';
  /** 課目id。通しは 'series' */
  courseId: string;
  /** 表示名（課目名 or 「試験（3課目通し）」） */
  label: string;
  machineId: string;
  points: number;
  passed: boolean;
  failCode: string | null;
  endReason: string;
  elapsedS: number;
}

export const SCORE_HISTORY_KEY = 'examHistory.v1';
export const SCORE_HISTORY_MAX = 50;

/** localStorage互換の最小インターフェース（clear用にremoveItemも要求） */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** 型不一致エントリの除外判定（JSON往復後のunknownを検査） */
function isValidEntry(value: unknown): value is ScoreEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.at === 'string' &&
    (e.kind === 'practice' || e.kind === 'exam') &&
    typeof e.courseId === 'string' &&
    typeof e.label === 'string' &&
    typeof e.machineId === 'string' &&
    typeof e.points === 'number' &&
    typeof e.passed === 'boolean' &&
    (e.failCode === null || typeof e.failCode === 'string') &&
    typeof e.endReason === 'string' &&
    typeof e.elapsedS === 'number'
  );
}

/** 既定ストレージの解決。localStorageの無い環境（node等）・アクセス例外はnull */
function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls === undefined ? null : ls;
  } catch {
    // ブラウザのストレージ無効設定等でアクセス自体が例外になるケース
    return null;
  }
}

/**
 * スコア履歴。新しい順に最大 SCORE_HISTORY_MAX 件を保持する。
 * storage=null（またはlocalStorage不在）ではメモリ内動作（ページ再読込で消える）。
 */
export class ScoreHistory {
  private readonly storage: StorageLike | null;

  /** メモリフォールバック用（storage===nullのときのみ使用） */
  private memory: ScoreEntry[] = [];

  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? defaultStorage() : storage;
  }

  /** 先頭に追加（新しい順）。MAX超過は古い方を捨てる。保存失敗はクラッシュしない */
  add(e: ScoreEntry): void {
    const next = [{ ...e }, ...this.list()].slice(0, SCORE_HISTORY_MAX);
    if (this.storage === null) {
      this.memory = next;
      return;
    }
    try {
      this.storage.setItem(SCORE_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 容量超過等。履歴は本質データではないため黙って無視（クラッシュ・console出力しない）
    }
  }

  /** 新しい順で返す。壊れたJSON・型不一致エントリは黙って除外 */
  list(): ScoreEntry[] {
    if (this.storage === null) {
      return this.memory.map((e) => ({ ...e }));
    }
    let raw: string | null;
    try {
      raw = this.storage.getItem(SCORE_HISTORY_KEY);
    } catch {
      return [];
    }
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  }

  /** 全履歴を消す */
  clear(): void {
    if (this.storage === null) {
      this.memory = [];
      return;
    }
    try {
      this.storage.removeItem(SCORE_HISTORY_KEY);
    } catch {
      // 失敗しても致命ではないため無視
    }
  }
}
