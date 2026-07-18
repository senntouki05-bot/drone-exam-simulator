/**
 * MachineProfile（data/machines/*.json の読込・検証）の機械検証。
 */

import { describe, expect, it } from 'vitest';
import phantom4Raw from '../../data/machines/phantom4-like.json';
import sotenRaw from '../../data/machines/soten-like.json';
import trainerRaw from '../../data/machines/trainer.json';
import { MACHINES, parseMachineProfile } from './MachineProfile';

describe('MACHINES（バンドル済みプロファイル）', () => {
  it('3機（phantom4-like / soten-like / trainer）が読み込まれる', () => {
    expect(MACHINES.map((m) => m.id)).toEqual(['phantom4-like', 'soten-like', 'trainer']);
  });

  it('全機のmaxSpeedMs/maxDescendMsは危険速度5m/s未満（減点表SPEEDの注記）', () => {
    for (const m of MACHINES) {
      expect(m.maxSpeedMs).toBeLessThan(5);
      expect(m.maxDescendMs).toBeLessThan(5);
    }
  });

  it('各JSONに _note（出典/仮置きの明記）がある', () => {
    for (const raw of [phantom4Raw, sotenRaw, trainerRaw]) {
      const note = (raw as Record<string, unknown>)._note;
      expect(typeof note).toBe('string');
      expect((note as string).length).toBeGreaterThan(10);
    }
  });

  it('trainerはphantom4-likeより穏やか（傾斜・速度が小さい）', () => {
    const phantom = MACHINES.find((m) => m.id === 'phantom4-like')!;
    const trainer = MACHINES.find((m) => m.id === 'trainer')!;
    expect(trainer.maxTiltDeg).toBeLessThan(phantom.maxTiltDeg);
    expect(trainer.maxSpeedMs).toBeLessThan(phantom.maxSpeedMs);
  });
});

describe('parseMachineProfile（検証）', () => {
  const valid = { ...(phantom4Raw as Record<string, unknown>) };

  it('危険速度5m/s以上のmaxSpeedMsは拒否する', () => {
    expect(() => parseMachineProfile('x', { ...valid, maxSpeedMs: 5 })).toThrow(/5m\/s/);
  });

  it('必須フィールド欠落・型不正は拒否する', () => {
    expect(() => parseMachineProfile('x', { ...valid, massKg: undefined })).toThrow();
    expect(() => parseMachineProfile('x', { ...valid, name: '' })).toThrow();
    expect(() => parseMachineProfile('x', { ...valid, expo: 1.5 })).toThrow();
    expect(() => parseMachineProfile('x', null)).toThrow();
  });
});
