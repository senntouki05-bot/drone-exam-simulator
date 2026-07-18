/**
 * exam/ExamSession.test.ts — M4受験テスト（Done条件）。
 *
 * ExamSession経由で合成軌道＋イベント列を流す（物理は通さない・シード固定＝random注入）。
 * ①理想軌道（スクエア四隅のヨー旋回・hover_done条件を満たす解析軌道）→減点0・合格
 * ②故意の変形軌道→期待どおりの減点コードと点数。
 */

import { describe, expect, it } from 'vitest';
import { COURSES, type Course } from './Course';
import { DEDUCTIONS } from './DeductionsConfig';
import {
  ExamSession,
  type ActiveInstruction,
  type ExamSessionOptions,
} from './ExamSession';
import type { ExamWarning } from './ScoringEngine';
import { TrajectoryBuilder, nominalSpeechS } from './trajectoryHelpers';

const C41 = COURSES[0];
const C42 = COURSES[1];
const C43 = COURSES[2];

function makeSession(course: Course, opts?: Partial<ExamSessionOptions>) {
  const instructions: ActiveInstruction[] = [];
  const warnings: ExamWarning[] = [];
  const session = new ExamSession({
    course,
    machineRadiusM: 0.3,
    random: () => 0.5, // 固定シード相当（4-3の緊急事態=1往復完了+12.5秒）
    direction: 'standard',
    onInstruction: (i) => instructions.push(i),
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  return { session, instructions, warnings };
}

/** 共通プロローグ: intro/離陸指示を待つ→宣言→離陸上昇→5秒ホバ */
function prologue(b: TrajectoryBuilder, course: Course, declare = true): void {
  const introDur = nominalSpeechS(course.instructions[0].text, DEDUCTIONS);
  b.wait(introDur + 0.5);
  if (declare) b.declare();
  b.wait(0.3);
  b.ascendTo(course.altitudeM, Math.max(2.0, course.altitudeM));
  b.wait(5.8);
}

/** 共通エピローグ: H上空へ→宣言→降下→接地→モーター停止（2秒接地保持） */
function epilogue(b: TrajectoryBuilder, course: Course, declare = true): void {
  b.moveTo(course.h.x, course.h.z, 3.0);
  if (declare) b.declare();
  b.wait(0.5);
  b.descendTo(0, Math.max(3.0, course.altitudeM * 1.4));
  b.wait(2.6);
}

/** 4-1: H→A→（反時計回りの周回・四隅でヨー旋回）→A */
function squareLapCcw(b: TrajectoryBuilder): void {
  b.turnTo(Math.PI, 2.4);
  b.moveTo(0, 0, 3.0); // H→A
  b.turnTo(Math.PI / 2, 1.2);
  b.moveTo(6.5, 0, 5.5); // A→B
  b.turnTo(0, 1.2);
  b.moveTo(6.5, 5, 4.5); // B→C
  b.turnTo(-Math.PI / 2, 1.2);
  b.moveTo(-6.5, 5, 8.5); // C→D
  b.turnTo(Math.PI, 1.2);
  b.moveTo(-6.5, 0, 4.5); // D→E
  b.turnTo(Math.PI / 2, 1.2);
  b.moveTo(0, 0, 5.5); // E→A
}

/** 4-1のC地点まで（変形軌道テストの共通部分） */
function squareUpToC(b: TrajectoryBuilder): void {
  b.turnTo(Math.PI, 2.4);
  b.moveTo(0, 0, 3.0);
  b.turnTo(Math.PI / 2, 1.2);
  b.moveTo(6.5, 0, 5.5);
  b.turnTo(0, 1.2);
  b.moveTo(6.5, 5, 4.5);
  b.turnTo(-Math.PI / 2, 1.2);
}

/** 4-1のD以降を完走 */
function squareFromD(b: TrajectoryBuilder): void {
  b.turnTo(Math.PI, 1.2);
  b.moveTo(-6.5, 0, 4.5);
  b.turnTo(Math.PI / 2, 1.2);
  b.moveTo(0, 0, 5.5);
}

/** 4-2: 基準パターン（左円反時計→右円時計）×2周 */
function figure8Standard(b: TrajectoryBuilder): void {
  b.arc(-2.5, 0, 2.5, 0, Math.PI * 2, 14);
  b.arc(2.5, 0, 2.5, Math.PI, -Math.PI, 14);
  b.arc(-2.5, 0, 2.5, 0, Math.PI * 2, 14);
  b.arc(2.5, 0, 2.5, Math.PI, -Math.PI, 14);
}

function codes(result: { deductions: Array<{ code: string }> } | null): string[] {
  return (result?.deductions ?? []).map((d) => d.code);
}

// ---------------------------------------------------------------------------
// ①理想軌道 → 減点0・合格
// ---------------------------------------------------------------------------

describe('理想軌道（減点0・合格）', () => {
  it('4-1 スクエア: 反時計回りの周回＋四隅ヨー旋回で満点合格・指示列が順に発話される', () => {
    const { session, instructions } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareLapCcw(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.points).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.endReason).toBe('completed');
    expect(r.elapsedS).toBeLessThan(r.timeLimitS);
    expect(r.track.length).toBeGreaterThan(100);
    expect(instructions.map((i) => i.id)).toEqual([
      'intro',
      'takeoff',
      'climb',
      'hover',
      'to_A',
      'lap',
      'return_h',
      'land',
      'motor_stop',
      'end',
    ]);
    // 指示テキストのプレースホルダが埋まっている
    const lap = instructions.find((i) => i.id === 'lap')!;
    expect(lap.text).toContain('反時計回り');
    expect(lap.text).toContain('A、B、C、D、E、A');
  });

  it('4-1 時計回り（reverse方向設定）でも満点合格', () => {
    const { session, instructions } = makeSession(C41, { direction: 'reverse' });
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    b.turnTo(Math.PI, 2.4);
    b.moveTo(0, 0, 3.0); // H→A
    b.turnTo(-Math.PI / 2, 1.2);
    b.moveTo(-6.5, 0, 5.5); // A→E
    b.turnTo(0, 1.2);
    b.moveTo(-6.5, 5, 4.5); // E→D
    b.turnTo(Math.PI / 2, 1.2);
    b.moveTo(6.5, 5, 8.5); // D→C
    b.turnTo(Math.PI, 1.2);
    b.moveTo(6.5, 0, 4.5); // C→B
    b.turnTo(-Math.PI / 2, 1.2);
    b.moveTo(0, 0, 5.5); // B→A
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.passed).toBe(true);
    expect(instructions.find((i) => i.id === 'lap')!.text).toContain('A、E、D、C、B、A');
  });

  it('4-2 8の字: 左円反時計→右円時計×2周で満点合格（巻き数統合）', () => {
    const { session } = makeSession(C42);
    const b = new TrajectoryBuilder(C42);
    prologue(b, C42);
    figure8Standard(b);
    b.declare();
    b.wait(0.5);
    b.descendTo(0, 3.0);
    b.wait(2.6);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.points).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.endReason).toBe('completed');
  });

  it('4-3 異常事態: ATTIで往復→緊急ホバ→緊急着陸で満点合格（緊急タイミングは注入乱数で決定的）', () => {
    const { session, instructions } = makeSession(C43);
    const b = new TrajectoryBuilder(C43);
    prologue(b, C43);
    b.moveTo(0, 0, 3.0); // H→A（機首前方のまま後退）
    b.moveTo(-6.5, 0, 6.0); // A→E
    b.moveTo(6.5, 0, 10.0); // E→B（2端点到達=1往復完了）
    b.wait(16.0); // B上でホバ待機: +12.5秒で緊急事態→その場ホバ2秒→緊急着陸指示
    b.moveTo(0, 2.5, 6.0); // 高度維持のまま最短経路でH上空へ
    b.declare();
    b.wait(0.5);
    b.descendTo(0, 5.0);
    b.wait(2.6);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.points).toBe(100);
    expect(r.passed).toBe(true);
    const ids = instructions.map((i) => i.id);
    expect(ids).toContain('emergency');
    expect(ids).toContain('emergency_land');
  });

  it('H直上（H円内）でのホバ・離陸・帰投・着陸は減点0（Hは内側減点区画の中にある）', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    const introDur = nominalSpeechS(C41.instructions[0].text, DEDUCTIONS);
    b.wait(introDur + 0.5);
    b.declare();
    b.wait(0.3);
    b.ascendTo(3.5, 3.5);
    b.moveTo(0.35, 2.5, 1.0); // H円内でオフセットしてホバ
    b.wait(6.2);
    squareLapCcw(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ②変形軌道 → 期待どおりの減点コードと点数
// ---------------------------------------------------------------------------

describe('区画逸脱（ZONE_DEV）', () => {
  it('レグ内初回進入は警告のみ・2秒以内復帰で減点なし', () => {
    const { session, warnings } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareUpToC(b);
    b.moveTo(3, 5, 3.5); // C→D途中
    b.moveTo(3, 6.7, 1.8); // 外側1.7m=減点区画へ
    b.moveTo(3, 5, 1.8); // すぐ復帰（滞在約0.8秒<2秒）
    b.moveTo(-6.5, 5, 5.5); // Dへ
    squareFromD(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(r.passed).toBe(true);
  });

  it('同レグ2回目の進入は即−5', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareUpToC(b);
    b.moveTo(3, 5, 3.5);
    b.moveTo(3, 6.7, 1.8);
    b.moveTo(3, 5, 1.8); // 1回目: 警告のみ
    b.wait(0.5);
    b.moveTo(3, 6.7, 1.8);
    b.moveTo(3, 5, 1.8); // 2回目: 即−5
    b.moveTo(-6.5, 5, 5.5);
    squareFromD(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(codes(r)).toEqual(['ZONE_DEV']);
    expect(r.points).toBe(95);
    expect(r.passed).toBe(true);
  });

  it('2秒以内に復帰できず滞留すると−5', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareUpToC(b);
    b.moveTo(3, 5, 3.5);
    b.moveTo(3, 6.7, 1.8);
    b.wait(2.2); // 滞留（復帰窓2秒を超過）
    b.moveTo(3, 5, 1.8);
    b.moveTo(-6.5, 5, 5.5);
    squareFromD(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(codes(r)).toEqual(['ZONE_DEV']);
    expect(r.points).toBe(95);
  });
});

describe('高度・速度・宣言', () => {
  it('高度違反: 指示高度±1.0m超が3秒継続でWRONG_OP −5', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareUpToC(b);
    b.moveTo(3, 5, 3.5);
    b.ascendTo(4.8, 1.5); // +1.3m
    b.wait(3.2);
    b.descendTo(3.5, 1.5);
    b.moveTo(-6.5, 5, 5.5);
    squareFromD(b);
    epilogue(b, C41);
    const r = b.run(session)!;
    expect(codes(r)).toEqual(['WRONG_OP']);
    expect(r.points).toBe(95);
    expect(r.passed).toBe(true);
  });

  it('速度超過: 5m/s超が0.5秒継続で即不合格（SPEED）', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    squareUpToC(b);
    b.moveTo(-6.5, 5, 2.8); // C→D 13mを2.8秒（最大約7m/s）
    const r = b.run(session)!;
    expect(r.failCode).toBe('SPEED');
    expect(r.passed).toBe(false);
    expect(r.endReason).toBe('immediate_fail');
  });

  it('宣言忘れ: 進行はブロックされず離陸・着陸で各−5（SAFETY）', () => {
    const { session } = makeSession(C41);
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41, false); // 宣言なし離陸
    squareLapCcw(b);
    epilogue(b, C41, false); // 宣言なし降下
    const r = b.run(session)!;
    expect(codes(r)).toEqual(['SAFETY', 'SAFETY']);
    expect(r.points).toBe(90);
    expect(r.passed).toBe(true);
    expect(r.endReason).toBe('completed');
  });
});

describe('4-3 異常事態の区画とH境界', () => {
  it('往復中に(0, 2.6)へ流されるとZONE_FAIL（Hは不合格境界上・H円進入の特例はフェーズ限定）', () => {
    const { session } = makeSession(C43);
    const b = new TrajectoryBuilder(C43);
    prologue(b, C43);
    b.moveTo(0, 0, 3.0); // H→A（到達で往復フェーズへ）
    b.moveTo(0, 2.6, 4.0); // 直線から2.5m超へ流される
    const r = b.run(session)!;
    expect(r.failCode).toBe('ZONE_FAIL');
    expect(r.passed).toBe(false);
    const fail = r.deductions.find((d) => d.code === 'ZONE_FAIL')!;
    expect(fail.pos.z).toBeGreaterThan(2.4);
  });

  it('緊急着陸移動でH直近（境界すれすれ）を通過しても減点0', () => {
    const { session } = makeSession(C43);
    const b = new TrajectoryBuilder(C43);
    prologue(b, C43);
    b.moveTo(0, 0, 3.0);
    b.moveTo(-6.5, 0, 6.0);
    b.moveTo(6.5, 0, 10.0);
    b.wait(16.0);
    b.moveTo(0.2, 2.45, 6.0); // 不合格境界(2.5m)すれすれを通ってH円へ
    b.declare();
    b.wait(0.5);
    b.descendTo(0, 5.0);
    b.wait(2.6);
    const r = b.run(session)!;
    expect(r.deductions).toEqual([]);
    expect(r.passed).toBe(true);
  });
});

describe('4-2 巻き数の採点統合', () => {
  it('H付近を横切るショートカット（半周のみ）はCENTER_MISSで即不合格', () => {
    const { session } = makeSession(C42);
    const b = new TrajectoryBuilder(C42);
    prologue(b, C42);
    b.arc(-2.5, 0, 2.5, 0, Math.PI, 7); // 左円を半周だけ
    b.moveTo(0.6, -0.3, 4.0); // 中心付近を突っ切って右円側へ
    const r = b.run(session)!;
    expect(r.failCode).toBe('CENTER_MISS');
    expect(r.passed).toBe(false);
  });

  it('規定と逆の周回方向は各セグメントWRONG_OP −5（完走・合格ラインは維持）', () => {
    const { session } = makeSession(C42);
    const b = new TrajectoryBuilder(C42);
    prologue(b, C42);
    b.arc(-2.5, 0, 2.5, 0, -Math.PI * 2, 14); // 左円を時計回り（規定は反時計）
    b.arc(2.5, 0, 2.5, Math.PI, Math.PI * 3, 14); // 右円を反時計回り（規定は時計）
    b.arc(-2.5, 0, 2.5, 0, -Math.PI * 2, 14);
    b.arc(2.5, 0, 2.5, Math.PI, Math.PI * 3, 14);
    b.declare();
    b.wait(0.5);
    b.descendTo(0, 3.0);
    b.wait(2.6);
    const r = b.run(session)!;
    // 逆回転×4セグメント＋機首の継続的不一致1回（接線と逆向き）= WRONG_OP×5
    const wrongOps = r.deductions.filter((d) => d.code === 'WRONG_OP');
    expect(wrongOps.length).toBe(5);
    expect(r.points).toBe(75);
    expect(r.passed).toBe(true);
  });
});
