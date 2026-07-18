/**
 * ui/InputDebugOverlay.ts — `?input=debug` の入力デバッグ画面。
 *
 * 生軸の値・正規化後の4軸・ボタン押下・宣言キー状態・アクティブな入力ソースを毎フレーム表示する。
 * 検証用オーバーレイなのでDOM更新は素朴だが、textContentは変化時のみ書き換える。
 */

import type { ControlInput } from '../sim/FlightModel';
import type { StickMode } from '../input/calibration';

export interface InputDebugView {
  sourceName: string;
  gamepadId: string | null;
  calibrated: boolean;
  mode: StickMode | null;
  deadzone: number | null;
  rawAxes: readonly number[];
  pressedButtons: readonly boolean[];
  normalized: Readonly<ControlInput>;
  declare: boolean;
}

interface BarRow {
  root: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
  lastText: string;
}

const NORM_LABELS: ReadonlyArray<{ key: keyof ControlInput; label: string }> = [
  { key: 'throttle', label: 'スロットル' },
  { key: 'rudder', label: 'ラダー' },
  { key: 'elevator', label: 'エレベーター' },
  { key: 'aileron', label: 'エルロン' },
];

export class InputDebugOverlay {
  private readonly info: HTMLElement;
  private readonly axesBox: HTMLElement;
  private readonly buttonsLine: HTMLElement;
  private readonly declareLine: HTMLElement;
  private readonly axisRows: BarRow[] = [];
  private readonly normRows: BarRow[] = [];
  private lastInfo = '';
  private lastButtons = '';
  private lastDeclare = '';

  constructor(root: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'input-debug';

    const title = document.createElement('div');
    title.className = 'dbg-title';
    title.textContent = '入力デバッグ（?input=debug）';
    el.appendChild(title);

    this.info = document.createElement('div');
    this.info.className = 'dbg-info';
    el.appendChild(this.info);

    const rawTitle = document.createElement('div');
    rawTitle.className = 'dbg-section';
    rawTitle.textContent = '生軸（Gamepad.axes）';
    el.appendChild(rawTitle);

    this.axesBox = document.createElement('div');
    el.appendChild(this.axesBox);

    const normTitle = document.createElement('div');
    normTitle.className = 'dbg-section';
    normTitle.textContent = '正規化4軸（キャリブレーション適用後）';
    el.appendChild(normTitle);

    const normBox = document.createElement('div');
    el.appendChild(normBox);
    for (const { label } of NORM_LABELS) {
      this.normRows.push(makeBarRow(normBox, label));
    }

    this.buttonsLine = document.createElement('div');
    this.buttonsLine.className = 'dbg-line';
    el.appendChild(this.buttonsLine);

    this.declareLine = document.createElement('div');
    this.declareLine.className = 'dbg-line';
    el.appendChild(this.declareLine);

    root.appendChild(el);
  }

  update(view: InputDebugView): void {
    const info = view.gamepadId
      ? `ソース: ${view.sourceName} ／ ${view.gamepadId} ／ ${
          view.calibrated
            ? `キャリブレーション済（モード${view.mode}・DZ ${view.deadzone?.toFixed(2)}）`
            : '未キャリブレーション'
        }`
      : `ソース: ${view.sourceName} ／ ゲームパッド未接続`;
    if (info !== this.lastInfo) {
      this.info.textContent = info;
      this.lastInfo = info;
    }

    // 生軸行の数を実軸数に合わせる
    while (this.axisRows.length < view.rawAxes.length) {
      this.axisRows.push(makeBarRow(this.axesBox, `軸${this.axisRows.length}`));
    }
    while (this.axisRows.length > view.rawAxes.length) {
      const row = this.axisRows.pop();
      row?.root.remove();
    }
    for (let i = 0; i < view.rawAxes.length; i++) {
      updateBarRow(this.axisRows[i]!, view.rawAxes[i]!);
    }

    for (let i = 0; i < NORM_LABELS.length; i++) {
      updateBarRow(this.normRows[i]!, view.normalized[NORM_LABELS[i]!.key]);
    }

    const pressed: number[] = [];
    for (let i = 0; i < view.pressedButtons.length; i++) {
      if (view.pressedButtons[i]) pressed.push(i);
    }
    const buttonsText = `ボタン押下: ${pressed.length > 0 ? pressed.join(', ') : 'なし'}`;
    if (buttonsText !== this.lastButtons) {
      this.buttonsLine.textContent = buttonsText;
      this.lastButtons = buttonsText;
    }

    const declareText = `安全確認宣言: ${view.declare ? 'ON' : 'OFF'}`;
    if (declareText !== this.lastDeclare) {
      this.declareLine.textContent = declareText;
      this.lastDeclare = declareText;
    }
  }
}

function makeBarRow(parent: HTMLElement, label: string): BarRow {
  const root = document.createElement('div');
  root.className = 'dbg-row';

  const lab = document.createElement('span');
  lab.className = 'dbg-label';
  lab.textContent = label;
  root.appendChild(lab);

  const bar = document.createElement('span');
  bar.className = 'dbg-bar';
  const fill = document.createElement('span');
  fill.className = 'dbg-bar-fill';
  bar.appendChild(fill);
  root.appendChild(bar);

  const value = document.createElement('span');
  value.className = 'dbg-value';
  root.appendChild(value);

  parent.appendChild(root);
  return { root, fill, value, lastText: '' };
}

function updateBarRow(row: BarRow, v: number): void {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  if (clamped >= 0) {
    row.fill.style.left = '50%';
    row.fill.style.width = `${clamped * 50}%`;
  } else {
    row.fill.style.left = `${50 + clamped * 50}%`;
    row.fill.style.width = `${-clamped * 50}%`;
  }
  const text = v.toFixed(3);
  if (text !== row.lastText) {
    row.value.textContent = text;
    row.lastText = text;
  }
}
