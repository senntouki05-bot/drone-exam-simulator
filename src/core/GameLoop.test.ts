import { describe, expect, it, vi } from 'vitest';
import { FIXED_DT, GameLoop, MAX_FRAME_DT, type VisibilityTarget } from './GameLoop';

/** 呼び出し記録つきのループを作るテストヘルパ */
function makeLoop(extra: Partial<ConstructorParameters<typeof GameLoop>[0]> = {}) {
  const updates: Array<{ dt: number; tSim: number }> = [];
  const alphas: number[] = [];
  const loop = new GameLoop({
    update: (dt, tSim) => updates.push({ dt, tSim }),
    render: (alpha) => alphas.push(alpha),
    visibilityTarget: null, // node環境（documentなし）でも明示しておく
    ...extra,
  });
  return { loop, updates, alphas };
}

describe('GameLoop 固定Δt積算', () => {
  it('120Hz相当のフレームを1秒分流すと、ちょうど240ステップ・全ステップdt=固定Δt・シム時間≈1s', () => {
    const { loop, updates } = makeLoop();
    // 121回呼ぶ（初回は基準時刻の確立のみ）＝実時間1.000sぶん
    for (let i = 0; i <= 120; i++) {
      loop.frame(i * (1000 / 120));
    }
    expect(updates.length).toBe(240); // 1s ÷ (1/240s) ＝240ステップ（doubleの決定的計算で実測240）
    for (const u of updates) expect(u.dt).toBe(FIXED_DT);
    expect(loop.simTime).toBeCloseTo(1.0, 9);
    // tSimはステップ開始時点の値＝固定Δtの積算列
    expect(updates[0]!.tSim).toBe(0);
    expect(updates[1]!.tSim).toBeCloseTo(FIXED_DT, 12);
    expect(updates[239]!.tSim).toBeCloseTo(239 * FIXED_DT, 9);
  });

  it('シム時間の積算誤差はアキュムレータ残余の範囲（0 ≤ 実時間−シム時間 < 固定Δt）に収まる', () => {
    const { loop, updates } = makeLoop();
    // 固定Δtの整数倍でない中途半端なフレーム間隔（7ms）を大量に流す
    const frames = 500;
    for (let i = 0; i <= frames; i++) loop.frame(i * 7);
    const elapsed = (frames * 7) / 1000;
    const residual = elapsed - loop.simTime;
    // 数学的には 0 ≤ residual < FIXED_DT。doubleの丸めで1e-13程度の負値になり得るため許容を持たせる
    expect(residual).toBeGreaterThanOrEqual(-1e-9);
    expect(residual).toBeLessThan(FIXED_DT);
    expect(loop.simTime).toBeCloseTo(updates.length * FIXED_DT, 9);
  });

  it('巨大フレーム（タブ復帰等の10秒）はMAX_FRAME_DT=0.25sにキャップされる', () => {
    const { loop, updates } = makeLoop();
    loop.frame(0);
    loop.frame(10_000); // 実時間10sだが0.25sとして処理される
    // 0.25 ÷ (1/240) ＝名目60ステップだが、doubleでは1/240の丸めにより実測59ステップ
    // （残余アキュムレータ≈固定Δt弱が持ち越される。時間を失わないことが不変条件）
    expect(updates.length).toBe(59);
    expect(loop.simTime).toBeLessThanOrEqual(MAX_FRAME_DT);
    expect(MAX_FRAME_DT - loop.simTime).toBeLessThan(FIXED_DT); // 残余 < 固定Δt
  });

  it('ポーズ中はシム時間が進まず、再開後も実時間経過をキャッチアップしない', () => {
    const { loop, updates } = makeLoop();
    loop.frame(0);
    loop.frame(100); // 0.1s → 24ステップ
    expect(updates.length).toBe(24);

    loop.pause();
    loop.frame(200);
    loop.frame(5_000);
    expect(updates.length).toBe(24); // ポーズ中は積算されない
    const simAtPause = loop.simTime;

    loop.resume();
    loop.frame(5_000); // 再開後の初回は基準時刻の確立のみ（巨大Δtのキャッチアップなし）
    expect(updates.length).toBe(24);
    expect(loop.simTime).toBe(simAtPause);

    loop.frame(5_100); // +0.1s → さらに24ステップ
    expect(updates.length).toBe(48);
    expect(loop.simTime).toBeCloseTo(simAtPause + 0.1, 9);
  });

  it('renderは毎フレーム呼ばれ、補間係数alphaは常に[0,1)', () => {
    const { loop, alphas } = makeLoop();
    for (let i = 0; i <= 50; i++) loop.frame(i * 6); // 6ms＝固定Δtの非整数倍
    expect(alphas.length).toBe(51);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });
});

describe('GameLoop visibilitychangeによる自動ポーズ', () => {
  function makeVisibilityTarget() {
    const listeners = new Set<() => void>();
    const target: VisibilityTarget & { visibilityState: string; fire(): void } = {
      visibilityState: 'visible',
      addEventListener: (_type, l) => listeners.add(l),
      removeEventListener: (_type, l) => listeners.delete(l),
      fire: () => listeners.forEach((l) => l()),
    };
    return target;
  }

  it('hiddenで自動ポーズしonAutoPauseが呼ばれる。visible復帰だけでは再開しない', () => {
    const onAutoPause = vi.fn();
    const target = makeVisibilityTarget();
    const { loop, updates } = makeLoop({
      visibilityTarget: target,
      onAutoPause,
      raf: undefined, // node環境: rAF駆動なしでstart()し、frame()は手動で呼ぶ
    });
    loop.start();
    loop.frame(0);
    loop.frame(50);
    expect(updates.length).toBeGreaterThan(0);
    const stepsBeforeHidden = updates.length;

    target.visibilityState = 'hidden';
    target.fire();
    expect(loop.isPaused).toBe(true);
    expect(onAutoPause).toHaveBeenCalledTimes(1);

    // visibleに戻ってもUIのresume()までポーズ維持（再開ダイアログ方式）
    target.visibilityState = 'visible';
    target.fire();
    expect(loop.isPaused).toBe(true);
    loop.frame(100);
    expect(updates.length).toBe(stepsBeforeHidden);

    loop.resume();
    expect(loop.isPaused).toBe(false);
    loop.frame(200); // 基準時刻の確立
    loop.frame(300); // ここから積算再開
    expect(updates.length).toBeGreaterThan(stepsBeforeHidden);
  });
});
