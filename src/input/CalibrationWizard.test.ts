import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type ControlInput } from '../sim/FlightModel';
import { applyCalibration } from './calibration';
import { CalibrationWizard } from './CalibrationWizard';

const AXES = 6; // 実プロポ想定: 軸0=エルロン, 軸1=エレベーター(反転), 軸2=スロットル, 軸5=ラダー

function makeWizard(): CalibrationWizard {
  return new CalibrationWizard({
    gamepadId: 'test-pad',
    mode: 2,
    holdFeeds: 3,
    deflectionThreshold: 0.4,
    neutralThreshold: 0.2,
  });
}

function frame(over: Partial<Record<number, number>> = {}): number[] {
  const axes = new Array<number>(AXES).fill(0);
  for (const [k, v] of Object.entries(over)) axes[Number(k)] = v!;
  return axes;
}

function feedN(w: CalibrationWizard, axes: number[], n: number): void {
  for (let i = 0; i < n; i++) w.feed(axes);
}

describe('CalibrationWizard（軸実測→割当→ボタン→デッドゾーン）', () => {
  it('フルフロー: 4軸（反転軸含む）＋宣言ボタンを実測し、生成した設定で正規化4軸が期待値に一致する', () => {
    const w = makeWizard();
    expect(w.step.kind).toBe('neutral');
    expect(w.step.stepCount).toBe(11);

    // 1. 中立記録
    w.feed(frame());
    expect(w.confirmNeutral()).toBe(true);
    expect(w.step.kind).toBe('axis-positive');
    expect(w.step.func).toBe('throttle');
    expect(w.step.prompt).toContain('スロットル');
    expect(w.step.prompt).toContain('上');

    // 2-3. スロットル=軸2。保持中の最大偏差(0.9)が端点として記録される
    w.feed(frame({ 2: 0.7 }));
    w.feed(frame({ 2: 0.9 }));
    expect(w.step.kind).toBe('axis-positive'); // まだ保持中
    w.feed(frame({ 2: 0.85 }));
    expect(w.step.kind).toBe('axis-negative');
    expect(w.step.func).toBe('throttle');
    feedN(w, frame({ 2: -0.95 }), 3);
    expect(w.step.kind).toBe('axis-positive');
    expect(w.step.func).toBe('rudder');

    // 4-5. ラダー=軸5（中立復帰後に検出。スロットル軸は割当済みなので下がったままでよい）
    w.feed(frame({ 2: -0.95 }));
    feedN(w, frame({ 2: -0.95, 5: 0.85 }), 3);
    expect(w.step.func).toBe('rudder');
    expect(w.step.kind).toBe('axis-negative');
    feedN(w, frame({ 5: -0.9 }), 3);

    // 6-7. エレベーター=軸1・反転（前に倒すと生値が負）
    expect(w.step.func).toBe('elevator');
    w.feed(frame()); // 中立復帰でアーム
    feedN(w, frame({ 1: -1 }), 3);
    expect(w.step.kind).toBe('axis-negative');
    feedN(w, frame({ 1: 1 }), 3);

    // 8-9. エルロン=軸0
    expect(w.step.func).toBe('aileron');
    w.feed(frame());
    feedN(w, frame({ 0: 0.95 }), 3);
    feedN(w, frame({ 0: -0.9 }), 3);

    // 10. 宣言ボタン（新規押下のエッジで確定）
    expect(w.step.kind).toBe('declare-button');
    w.feed(frame(), [false, false, false]);
    w.feed(frame(), [false, false, true]);
    expect(w.step.kind).toBe('deadzone');

    // 11. デッドゾーン→完了
    w.setDeadzone(0.1);
    const calib = w.finish();
    expect(calib).not.toBeNull();
    expect(w.step.kind).toBe('done');

    expect(calib!.gamepadId).toBe('test-pad');
    expect(calib!.mode).toBe(2);
    expect(calib!.deadzone).toBeCloseTo(0.1, 12);
    expect(calib!.declareButtonIndex).toBe(2);
    expect(calib!.axes.throttle).toEqual({ axisIndex: 2, center: 0, positive: 0.9, negative: -0.95 });
    expect(calib!.axes.rudder).toEqual({ axisIndex: 5, center: 0, positive: 0.85, negative: -0.9 });
    expect(calib!.axes.elevator).toEqual({ axisIndex: 1, center: 0, positive: -1, negative: 1 });
    expect(calib!.axes.aileron).toEqual({ axisIndex: 0, center: 0, positive: 0.95, negative: -0.9 });

    // 実測結果のキャリブレーションを既知の軸配列へ適用 → 正規化4軸が期待値一致
    const out: ControlInput = { ...NEUTRAL_INPUT };
    applyCalibration([0.475, 0.5, 0.45, 0, 0, -0.45], calib!, out);
    const dz = (v: number): number => (v - 0.1) / 0.9; // デッドゾーン再スケール
    expect(out.aileron).toBeCloseTo(dz(0.475 / 0.95), 12); // +0.4444…
    expect(out.elevator).toBeCloseTo(-dz(0.5 / 1), 12); // 反転軸: 生+0.5→-0.4444…
    expect(out.throttle).toBeCloseTo(dz(0.45 / 0.9), 12);
    expect(out.rudder).toBeCloseTo(-dz(0.45 / 0.9), 12);
  });

  it('割当済みの軸は次の機能の検出候補にならない（スロットルを倒したままでも誤検出しない）', () => {
    const w = makeWizard();
    w.feed(frame());
    w.confirmNeutral();
    feedN(w, frame({ 2: 0.9 }), 3); // スロットル正
    feedN(w, frame({ 2: -0.9 }), 3); // スロットル負 → ラダー待ち
    expect(w.step.func).toBe('rudder');
    // スロットル軸だけを大きく動かし続けても捕捉されない
    feedN(w, frame({ 2: 0.9 }), 10);
    expect(w.step.func).toBe('rudder');
    expect(w.step.kind).toBe('axis-positive');
  });

  it('中立復帰（未割当軸）まで次の機能の検出を武装しない', () => {
    const w = makeWizard();
    w.feed(frame());
    w.confirmNeutral();
    feedN(w, frame({ 2: 0.9 }), 3);
    feedN(w, frame({ 2: -0.9 }), 3);
    expect(w.step.func).toBe('rudder');
    // 中立を経ずに軸5を倒し続けても武装前なので捕捉されない
    feedN(w, frame({ 5: 0.9 }), 10);
    expect(w.step.kind).toBe('axis-positive');
    expect(w.step.holdProgress).toBe(0);
    // 中立復帰→武装→捕捉できる
    w.feed(frame());
    feedN(w, frame({ 5: 0.9 }), 3);
    expect(w.step.kind).toBe('axis-negative');
  });

  it('しきい値未満の倒し込みでは保持カウントが進まない', () => {
    const w = makeWizard();
    w.feed(frame());
    w.confirmNeutral();
    feedN(w, frame({ 2: 0.3 }), 10); // deflectionThreshold=0.4未満
    expect(w.step.kind).toBe('axis-positive');
    expect(w.step.holdProgress).toBe(0);
  });

  it('宣言ボタンはスキップできる（declareButtonIndex=null）', () => {
    const w = makeWizard();
    w.feed(frame());
    w.confirmNeutral();
    for (const [axis, sign] of [
      [2, 1],
      [5, 1],
      [1, -1],
      [0, 1],
    ] as const) {
      w.feed(frame());
      feedN(w, frame({ [axis]: sign * 0.9 }), 3);
      feedN(w, frame({ [axis]: -sign * 0.9 }), 3);
    }
    expect(w.step.kind).toBe('declare-button');
    w.skipDeclare();
    expect(w.step.kind).toBe('deadzone');
    const calib = w.finish();
    expect(calib!.declareButtonIndex).toBeNull();
  });

  it('finish()はデッドゾーン調整ステップ以外ではnull', () => {
    const w = makeWizard();
    expect(w.finish()).toBeNull();
    w.feed(frame());
    w.confirmNeutral();
    expect(w.finish()).toBeNull();
  });

  it('中立記録前は軸が読めていなければconfirmNeutralできない', () => {
    const w = makeWizard();
    expect(w.confirmNeutral()).toBe(false); // まだfeedされていない
    w.feed(frame());
    expect(w.confirmNeutral()).toBe(true);
  });
});
