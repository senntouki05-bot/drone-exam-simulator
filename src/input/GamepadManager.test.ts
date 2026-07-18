import { describe, expect, it, vi } from 'vitest';
import { NEUTRAL_INPUT, type ControlInput } from '../sim/FlightModel';
import {
  CALIBRATION_VERSION,
  standardGamepadCalibration,
  type GamepadCalibration,
} from './calibration';
import { loadCalibration, saveCalibration, type StorageLike } from './CalibrationStore';
import {
  GamepadManager,
  type GamepadEventTargetLike,
  type GamepadLike,
} from './GamepadManager';

const PAD_ID = 'RadioMaster TX16S Joystick (Vendor: 1234 Product: 5678)';

/** テスト用の可変ゲームパッド（navigator.getGamepads相当のモックが返す実体） */
interface MutablePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: Array<{ pressed: boolean }>;
}

function makePad(over: Partial<MutablePad> = {}): MutablePad {
  return {
    id: PAD_ID,
    index: 0,
    connected: true,
    mapping: '',
    axes: [0, 0, 0, 0, 0, 0],
    buttons: [{ pressed: false }, { pressed: false }, { pressed: false }, { pressed: false }],
    ...over,
  };
}

function makeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function makeEventTarget(): GamepadEventTargetLike & { fire(): void } {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type, l) => listeners.add(l),
    removeEventListener: (_type, l) => listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
  };
}

/** 実プロポ風の混在割当（軸2=スロットル・軸5=ラダー反転・軸1=エレベーター反転・軸0=エルロン） */
function radioCalibration(): GamepadCalibration {
  return {
    version: CALIBRATION_VERSION,
    gamepadId: PAD_ID,
    mode: 2,
    deadzone: 0,
    axes: {
      throttle: { axisIndex: 2, center: 0, positive: 1, negative: -1 },
      rudder: { axisIndex: 5, center: 0, positive: -1, negative: 1 },
      elevator: { axisIndex: 1, center: 0, positive: -1, negative: 1 },
      aileron: { axisIndex: 0, center: 0, positive: 1, negative: -1 },
    },
    declareButtonIndex: 3,
  };
}

function readOut(mgr: GamepadManager): ControlInput {
  const out: ControlInput = { ...NEUTRAL_INPUT };
  mgr.read(out);
  return out;
}

describe('GamepadManager（navigator.getGamepadsモック注入）', () => {
  it('未接続ではconnected=false・readは全軸0・declare=false', () => {
    const mgr = new GamepadManager({
      getGamepads: () => [null, null],
      eventTarget: null,
      storage: null,
    });
    mgr.poll();
    expect(mgr.connected).toBe(false);
    expect(mgr.ready).toBe(false);
    expect(readOut(mgr)).toEqual(NEUTRAL_INPUT);
    expect(mgr.declarePressed).toBe(false);
  });

  it('poll()で接続を検出し、id・mapping・生値が読める', () => {
    const pad = makePad({ axes: [0.1, -0.2, 0.3, 0, 0, 0.5] });
    const pads: Array<GamepadLike | null> = [null, pad];
    const onChange = vi.fn();
    const mgr = new GamepadManager({ getGamepads: () => pads, eventTarget: null, storage: null });
    mgr.onConnectionChange(onChange);
    mgr.poll();
    expect(mgr.connected).toBe(true);
    expect(mgr.gamepadId).toBe(PAD_ID);
    expect(mgr.mapping).toBe('');
    expect(mgr.rawAxes).toEqual([0.1, -0.2, 0.3, 0, 0, 0.5]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true, PAD_ID);
    // 2回目のpollでは再発火しない
    mgr.poll();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('既知の軸配列→キャリブレーション適用→正規化4軸が期待値に一致する', () => {
    const pad = makePad();
    const mgr = new GamepadManager({
      getGamepads: () => [pad],
      eventTarget: null,
      storage: null,
    });
    mgr.poll();
    mgr.saveCalibration(radioCalibration());
    expect(mgr.ready).toBe(true);

    pad.axes = [0.5, -1, 0.25, 0, 0, 0.6];
    mgr.poll();
    const out = readOut(mgr);
    expect(out.throttle).toBeCloseTo(0.25, 12);
    expect(out.rudder).toBeCloseTo(-0.6, 12);
    expect(out.elevator).toBeCloseTo(1, 12);
    expect(out.aileron).toBeCloseTo(0.5, 12);
  });

  it('宣言ボタン（declareButtonIndex）の押下がdeclarePressedに反映される', () => {
    const pad = makePad();
    const mgr = new GamepadManager({
      getGamepads: () => [pad],
      eventTarget: null,
      storage: null,
    });
    mgr.poll();
    mgr.saveCalibration(radioCalibration()); // declareButtonIndex=3
    expect(mgr.declarePressed).toBe(false);
    pad.buttons[3]!.pressed = true;
    mgr.poll();
    expect(mgr.declarePressed).toBe(true);
    pad.buttons[3]!.pressed = false;
    mgr.poll();
    expect(mgr.declarePressed).toBe(false);
  });

  it('切断でconnected=false・read全軸0になり、リスナへ通知される', () => {
    const pads: Array<GamepadLike | null> = [makePad({ axes: [1, 1, 1, 1, 1, 1] })];
    const onChange = vi.fn();
    const mgr = new GamepadManager({ getGamepads: () => pads, eventTarget: null, storage: null });
    mgr.onConnectionChange(onChange);
    mgr.poll();
    mgr.saveCalibration(radioCalibration());
    expect(readOut(mgr)).not.toEqual(NEUTRAL_INPUT);

    pads[0] = null;
    mgr.poll();
    expect(mgr.connected).toBe(false);
    expect(mgr.ready).toBe(false);
    expect(readOut(mgr)).toEqual(NEUTRAL_INPUT);
    expect(onChange).toHaveBeenLastCalledWith(false, null);
  });

  it('localStorage保存/復元の往復: 保存済み設定が接続時にgamepad.idごと自動復元される', () => {
    const storage = makeStorage();
    const pad = makePad();
    const pads: Array<GamepadLike | null> = [pad];

    // 1台目のマネージャで保存（ウィザード完了相当）
    const mgr1 = new GamepadManager({ getGamepads: () => pads, eventTarget: null, storage });
    mgr1.poll();
    mgr1.saveCalibration(radioCalibration());

    // 別セッション相当の2台目: 接続を検出した時点で自動復元され、そのままreadできる
    const mgr2 = new GamepadManager({ getGamepads: () => pads, eventTarget: null, storage });
    mgr2.poll();
    expect(mgr2.ready).toBe(true);
    expect(mgr2.calibration).toEqual(radioCalibration());
    pad.axes = [0.5, -1, 0.25, 0, 0, 0.6];
    mgr2.poll();
    const out = readOut(mgr2);
    expect(out.throttle).toBeCloseTo(0.25, 12);
    expect(out.rudder).toBeCloseTo(-0.6, 12);
    expect(out.elevator).toBeCloseTo(1, 12);
    expect(out.aileron).toBeCloseTo(0.5, 12);
  });

  it('別idのゲームパッドには他機の設定を復元しない', () => {
    const storage = makeStorage();
    saveCalibration(storage, radioCalibration()); // PAD_ID用
    const other = makePad({ id: 'Some Other Pad' });
    const mgr = new GamepadManager({ getGamepads: () => [other], eventTarget: null, storage });
    mgr.poll();
    expect(mgr.connected).toBe(true);
    expect(mgr.calibration).toBeNull();
    expect(mgr.ready).toBe(false);
  });

  it('setModeでモード1/2プリセットを切替え、永続化される', () => {
    const storage = makeStorage();
    const pad = makePad();
    const mgr = new GamepadManager({ getGamepads: () => [pad], eventTarget: null, storage });
    mgr.poll();
    mgr.saveCalibration(radioCalibration()); // mode2
    mgr.setMode(1);
    expect(mgr.calibration?.mode).toBe(1);
    // throttle⇔elevatorの軸が入れ替わる
    expect(mgr.calibration?.axes.throttle.axisIndex).toBe(1);
    expect(mgr.calibration?.axes.elevator.axisIndex).toBe(2);
    // storageにも反映されている（再接続時に復元される値）
    expect(loadCalibration(storage, PAD_ID)?.mode).toBe(1);
  });

  it('applyStandardPresetで標準マッピングのプリセットを適用できる', () => {
    const pad = makePad({ id: 'Xbox', mapping: 'standard', axes: [0, -1, 0, 0] });
    const storage = makeStorage();
    const mgr = new GamepadManager({ getGamepads: () => [pad], eventTarget: null, storage });
    mgr.poll();
    mgr.applyStandardPreset(2);
    expect(mgr.calibration).toEqual(standardGamepadCalibration('Xbox', 2));
    expect(loadCalibration(storage, 'Xbox')).toEqual(standardGamepadCalibration('Xbox', 2));
    mgr.poll();
    expect(readOut(mgr).throttle).toBeCloseTo(1, 12); // 左Y上いっぱい
  });

  it('gamepadconnectedイベントでもポーリングと同様に検出される（rAFポーリングとの併用）', () => {
    const pads: Array<GamepadLike | null> = [null];
    const eventTarget = makeEventTarget();
    const mgr = new GamepadManager({ getGamepads: () => pads, eventTarget, storage: null });
    expect(mgr.connected).toBe(false);
    pads[0] = makePad();
    eventTarget.fire(); // gamepadconnected → 内部でpoll
    expect(mgr.connected).toBe(true);
    expect(mgr.gamepadId).toBe(PAD_ID);
  });

  it('storage例外（容量超過等）でも落ちない', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const mgr = new GamepadManager({
      getGamepads: () => [makePad()],
      eventTarget: null,
      storage: throwing,
    });
    mgr.poll();
    expect(() => mgr.saveCalibration(radioCalibration())).not.toThrow();
    expect(mgr.ready).toBe(true); // メモリ上の設定は有効なまま
  });
});
