import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type ControlInput } from '../sim/FlightModel';
import { KeyboardInput } from './KeyboardInput';

/** window相当のイベントターゲット（node環境用の偽物） */
function makeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type: string, l: (e: unknown) => void): void {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener(type: string, l: (e: unknown) => void): void {
      listeners.get(type)?.delete(l);
    },
    keydown(code: string): void {
      listeners.get('keydown')?.forEach((l) => l({ code, preventDefault: () => {} }));
    },
    keyup(code: string): void {
      listeners.get('keyup')?.forEach((l) => l({ code }));
    },
    blur(): void {
      listeners.get('blur')?.forEach((l) => l({}));
    },
  };
}

function read(kb: KeyboardInput): ControlInput {
  const out: ControlInput = { ...NEUTRAL_INPUT };
  kb.read(out);
  return out;
}

describe('KeyboardInput（モード2配置のフォールバック）', () => {
  it('W/S=スロットル・A/D=ラダー・↑↓=エレベーター・←→=エルロン', () => {
    const win = makeWindow();
    const kb = new KeyboardInput(win as unknown as Window);

    win.keydown('KeyW');
    expect(read(kb).throttle).toBe(1);
    win.keyup('KeyW');
    win.keydown('KeyS');
    expect(read(kb).throttle).toBe(-1);
    win.keyup('KeyS');

    win.keydown('KeyD');
    expect(read(kb).rudder).toBe(1);
    win.keyup('KeyD');
    win.keydown('KeyA');
    expect(read(kb).rudder).toBe(-1);
    win.keyup('KeyA');

    win.keydown('ArrowUp');
    expect(read(kb).elevator).toBe(1);
    win.keyup('ArrowUp');
    win.keydown('ArrowDown');
    expect(read(kb).elevator).toBe(-1);
    win.keyup('ArrowDown');

    win.keydown('ArrowRight');
    expect(read(kb).aileron).toBe(1);
    win.keyup('ArrowRight');
    win.keydown('ArrowLeft');
    expect(read(kb).aileron).toBe(-1);
    win.keyup('ArrowLeft');

    expect(read(kb)).toEqual(NEUTRAL_INPUT);
  });

  it('同軸の対キー同時押しは0', () => {
    const win = makeWindow();
    const kb = new KeyboardInput(win as unknown as Window);
    win.keydown('KeyW');
    win.keydown('KeyS');
    expect(read(kb).throttle).toBe(0);
  });

  it('Space=安全確認宣言', () => {
    const win = makeWindow();
    const kb = new KeyboardInput(win as unknown as Window);
    expect(kb.declarePressed).toBe(false);
    win.keydown('Space');
    expect(kb.declarePressed).toBe(true);
    win.keyup('Space');
    expect(kb.declarePressed).toBe(false);
  });

  it('フォーカス喪失（blur）で押下状態をクリアする（スタックキー防止）', () => {
    const win = makeWindow();
    const kb = new KeyboardInput(win as unknown as Window);
    win.keydown('KeyW');
    win.keydown('ArrowUp');
    expect(read(kb).throttle).toBe(1);
    win.blur();
    expect(read(kb)).toEqual(NEUTRAL_INPUT);
  });

  it('dispose後は入力を受け付けない', () => {
    const win = makeWindow();
    const kb = new KeyboardInput(win as unknown as Window);
    kb.dispose();
    win.keydown('KeyW');
    expect(read(kb)).toEqual(NEUTRAL_INPUT);
  });
});
