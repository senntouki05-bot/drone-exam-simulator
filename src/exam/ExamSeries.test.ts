/**
 * exam/ExamSeries.test.ts — 試験モード3課目通し（ExamSeries）の受験テスト。
 *
 * ExamSession.test.tsの理想軌道スクリプトを流用し、シリーズ経由で3課目を通す。
 * TrajectoryBuilder.run()はExamSession専用のため、builder.samples/eventsを
 * 自前ループで series.step へ流すヘルパ（feed）をテスト内に持つ。
 * 検証の柱: 持ち点の課目間持ち越し・awaitingNext遷移・即不合格時の即終了/練習続行・
 * start()の状態ガード・abort()。
 */

import { describe, expect, it } from 'vitest';
import { COURSES, type Course } from './Course';
import { DEDUCTIONS } from './DeductionsConfig';
import type { ExamEvent } from './ExamSession';
import { ExamSeries, type ExamSeriesOptions, type ExamSeriesResult } from './ExamSeries';
import { TrajectoryBuilder, nominalSpeechS } from './trajectoryHelpers';

const C41 = COURSES[0];
const C42 = COURSES[1];
const C43 = COURSES[2];

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** builderのサンプル列＋イベント列をシリーズへ流す（run()のシリーズ版・課目終了後の余剰stepは無視される） */
function feed(series: ExamSeries, b: TrajectoryBuilder): void {
  let ei = 0;
  const buf: ExamEvent[] = [];
  for (const { t, sample } of b.samples) {
    buf.length = 0;
    while (ei < b.events.length && b.events[ei].t <= t) buf.push(b.events[ei++]);
    series.step(t, sample, buf);
  }
}

function makeSeries(opts?: Partial<ExamSeriesOptions>) {
  const courseFinished: number[] = [];
  const seriesFinished: ExamSeriesResult[] = [];
  const series = new ExamSeries({
    courses: COURSES,
    machineRadiusM: 0.3,
    random: () => 0.5, // 固定シード相当（4-3の緊急事態=1往復完了+12.5秒）
    direction: 'standard',
    onCourseFinished: (_r, i) => courseFinished.push(i),
    onSeriesFinished: (r) => seriesFinished.push(r),
    ...opts,
  });
  return { series, courseFinished, seriesFinished };
}

/** 共通プロローグ: intro/離陸指示を待つ→宣言→離陸上昇→5秒ホバ（ExamSession.test.tsと同一） */
function prologue(b: TrajectoryBuilder, course: Course, declare = true): void {
  const introDur = nominalSpeechS(course.instructions[0].text, DEDUCTIONS);
  b.wait(introDur + 0.5);
  if (declare) b.declare();
  b.wait(0.3);
  b.ascendTo(course.altitudeM, Math.max(2.0, course.altitudeM));
  b.wait(5.8);
}

/** 共通エピローグ: H上空へ→宣言→降下→接地→モーター停止（ExamSession.test.tsと同一） */
function epilogue(b: TrajectoryBuilder, course: Course, declare = true): void {
  b.moveTo(course.h.x, course.h.z, 3.0);
  if (declare) b.declare();
  b.wait(0.5);
  b.descendTo(0, Math.max(3.0, course.altitudeM * 1.4));
  b.wait(2.6);
}

/** 4-1理想軌道: H→A→反時計回りの周回（四隅ヨー旋回）→A→H */
function ideal41(declare = true): TrajectoryBuilder {
  const b = new TrajectoryBuilder(C41);
  prologue(b, C41, declare);
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
  epilogue(b, C41, declare);
  return b;
}

/** 4-2理想軌道: 左円反時計→右円時計×2周（各円はHで終わる）→着陸 */
function ideal42(): TrajectoryBuilder {
  const b = new TrajectoryBuilder(C42);
  prologue(b, C42);
  b.arc(-2.5, 0, 2.5, 0, Math.PI * 2, 14);
  b.arc(2.5, 0, 2.5, Math.PI, -Math.PI, 14);
  b.arc(-2.5, 0, 2.5, 0, Math.PI * 2, 14);
  b.arc(2.5, 0, 2.5, Math.PI, -Math.PI, 14);
  b.declare();
  b.wait(0.5);
  b.descendTo(0, 3.0);
  b.wait(2.6);
  return b;
}

/** 4-3理想軌道: ATTIで往復→緊急ホバ→高度維持でH上空→着陸 */
function ideal43(): TrajectoryBuilder {
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
  return b;
}

/** 4-2で速度超過（SPEED即不合格）: 左円1周を2秒（平均約7.9m/s・経路上=区画違反なし） */
function speedFail42(): TrajectoryBuilder {
  const b = new TrajectoryBuilder(C42);
  prologue(b, C42);
  b.arc(-2.5, 0, 2.5, 0, Math.PI * 2, 2.0);
  return b;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('ExamSeries 3課目通し', () => {
  it('3課目とも理想軌道 → passed=true・100点・results3件・課目間はawaitingNext経由', () => {
    const { series, courseFinished, seriesFinished } = makeSeries();
    expect(series.finished).toBe(false);
    expect(series.awaitingNext).toBe(false);
    expect(series.courseIndex).toBe(0);
    expect(series.points).toBe(100);

    series.start();
    expect(series.session).not.toBeNull();
    expect(series.awaitingNext).toBe(false);
    feed(series, ideal41());
    // 課目1完了→機体H再配置待ち
    expect(series.awaitingNext).toBe(true);
    expect(series.session).toBeNull();
    expect(series.courseIndex).toBe(1);
    expect(series.course.id).toBe('4-2');
    expect(series.points).toBe(100);

    series.start();
    feed(series, ideal42());
    expect(series.awaitingNext).toBe(true);
    expect(series.courseIndex).toBe(2);

    series.start();
    feed(series, ideal43());
    expect(series.finished).toBe(true);
    expect(series.awaitingNext).toBe(false);

    const r = series.result!;
    expect(r.passed).toBe(true);
    expect(r.points).toBe(100);
    expect(r.endedEarly).toBe(false);
    expect(r.results.length).toBe(3);
    expect(r.results.map((x) => x.courseId)).toEqual(['4-1', '4-2', '4-3']);
    expect(r.results.every((x) => x.passed && x.endReason === 'completed')).toBe(true);
    expect(courseFinished).toEqual([0, 1, 2]);
    expect(seriesFinished.length).toBe(1);
    expect(seriesFinished[0]).toBe(r);
  });

  it('課目1で宣言忘れ×2（−10）→ 課目2がstartPoints=90で始まり最終90点で合格', () => {
    const { series } = makeSeries();
    series.start();
    feed(series, ideal41(false)); // 離陸・着陸とも宣言なし=SAFETY×2
    expect(series.results[0].points).toBe(90);
    expect(series.results[0].passed).toBe(true);
    expect(series.awaitingNext).toBe(true);

    const s2 = series.start();
    expect(s2.points).toBe(90); // 持ち点の持ち越し
    expect(series.points).toBe(90);
    feed(series, ideal42());

    series.start();
    feed(series, ideal43());
    const r = series.result!;
    expect(r.passed).toBe(true);
    expect(r.points).toBe(90);
    expect(r.results.length).toBe(3);
  });

  it('課目2で速度超過の即不合格（continueOnFail=false既定）→ シリーズ即終了・endedEarly=true・results2件', () => {
    const { series, courseFinished, seriesFinished } = makeSeries();
    series.start();
    feed(series, ideal41());
    series.start();
    feed(series, speedFail42());

    expect(series.finished).toBe(true);
    expect(series.awaitingNext).toBe(false);
    const r = series.result!;
    expect(r.endedEarly).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.results.length).toBe(2);
    expect(r.results[1].endReason).toBe('immediate_fail');
    expect(r.results[1].failCode).toBe('SPEED');
    expect(courseFinished).toEqual([0, 1]);
    expect(seriesFinished.length).toBe(1);
  });

  it('同ケースでcontinueOnFail=true → 課目3まで実施・results3件・passed=false（70点床で再開）', () => {
    const { series, courseFinished } = makeSeries({ continueOnFail: true });
    series.start();
    feed(series, ideal41());
    series.start();
    feed(series, speedFail42());

    // 即不合格でも練習続行: awaitingNextを経て課目3へ
    expect(series.finished).toBe(false);
    expect(series.awaitingNext).toBe(true);
    expect(series.courseIndex).toBe(2);

    const s3 = series.start();
    // 練習続行時の持ち点=max(直近結果points, passPoints)（70点床）
    const expected = Math.max(series.results[1].points, DEDUCTIONS.pass.passPoints);
    expect(s3.points).toBe(expected);

    feed(series, ideal43());
    expect(series.finished).toBe(true);
    const r = series.result!;
    expect(r.results.length).toBe(3);
    expect(r.passed).toBe(false); // 課目2不合格のため総合不合格のまま
    expect(r.endedEarly).toBe(false); // 最終課目まで実施した
    expect(r.results[2].passed).toBe(true);
    expect(courseFinished).toEqual([0, 1, 2]);
  });

  it('start()の状態ガード: 進行中・シリーズ終了後はthrow', () => {
    const { series } = makeSeries();
    series.start();
    expect(() => series.start()).toThrow(); // 進行中（awaitingNextでない）

    feed(series, ideal41());
    series.start();
    feed(series, speedFail42()); // continueOnFail=false → シリーズ終了
    expect(series.finished).toBe(true);
    expect(() => series.start()).toThrow(); // 終了後
  });

  it('進行中のabort() → 課目結果aborted・endedEarly=true・passed=false', () => {
    const { series, seriesFinished } = makeSeries({ continueOnFail: true });
    series.start();
    const b = new TrajectoryBuilder(C41);
    prologue(b, C41);
    feed(series, b); // ホバまで進めた途中でabort
    expect(series.finished).toBe(false);

    series.abort();
    expect(series.finished).toBe(true);
    const r = series.result!;
    expect(r.endedEarly).toBe(true); // abortedはcontinueOnFailによらず即終了
    expect(r.passed).toBe(false);
    expect(r.results.length).toBe(1);
    expect(r.results[0].endReason).toBe('aborted');
    expect(seriesFinished.length).toBe(1);
  });

  it('開始前・課目間のabort()もシリーズ終了（endedEarly・実施分のみresultsに残る）', () => {
    // 開始前
    const before = makeSeries().series;
    before.abort();
    expect(before.finished).toBe(true);
    expect(before.result!.endedEarly).toBe(true);
    expect(before.result!.passed).toBe(false);
    expect(before.result!.results.length).toBe(0);
    expect(before.result!.points).toBe(100);

    // 課目間（awaitingNext中）
    const { series } = makeSeries();
    series.start();
    feed(series, ideal41());
    expect(series.awaitingNext).toBe(true);
    series.abort();
    expect(series.finished).toBe(true);
    expect(series.result!.endedEarly).toBe(true);
    expect(series.result!.results.length).toBe(1);
    expect(series.result!.results[0].passed).toBe(true); // 課目1自体は完了済み
  });
});
