/**
 * ui/InputSetupUI.ts — 接続画面（右上パネル）とキャリブレーションウィザードのUI。
 *
 * ロジックはinput/配下（GamepadManager / CalibrationWizard）が持ち、ここはDOM表示と操作だけ。
 * update()を毎描画フレーム呼ぶ（ウィザードへの生値フィードと表示更新）。
 * DOM再構築は状態キーが変わったときのみ（毎フレームのinnerHTML書き換えはしない）。
 */

import { CalibrationWizard } from '../input/CalibrationWizard';
import type { GamepadManager } from '../input/GamepadManager';
import type { StickMode } from '../input/calibration';

/** 接続画面の導線文言（仕様固定・CLAUDE-CODE-PROMPT.md「入力（input/）」節） */
export const CONNECT_GUIDE_TEXT =
  'プロポのスイッチを操作するか、いずれかのボタンを押してください（スティック操作だけでは認識されない場合があります）';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class InputSetupUI {
  private readonly manager: GamepadManager;
  private readonly panel: HTMLElement;
  private readonly overlay: HTMLElement;
  private wizard: CalibrationWizard | null = null;
  private preferredMode: StickMode = 2;
  private panelKey = '';
  private wizardKey = '';
  private holdBar: HTMLElement | null = null;

  constructor(root: HTMLElement, manager: GamepadManager) {
    this.manager = manager;

    this.panel = document.createElement('div');
    this.panel.id = 'input-panel';
    root.appendChild(this.panel);

    this.overlay = document.createElement('div');
    this.overlay.id = 'wizard-overlay';
    this.overlay.hidden = true;
    root.appendChild(this.overlay);

    const onClick = (e: Event): void => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
      if (target?.dataset.action) this.handleAction(target.dataset.action);
    };
    this.panel.addEventListener('click', onClick);
    this.overlay.addEventListener('click', onClick);
    this.overlay.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.id === 'ip-deadzone' && this.wizard) {
        this.wizard.setDeadzone(Number.parseFloat(t.value));
        const val = this.overlay.querySelector('#ip-deadzone-val');
        if (val) val.textContent = this.wizard.deadzone.toFixed(2);
      }
    });
  }

  get wizardActive(): boolean {
    return this.wizard !== null;
  }

  /** 毎描画フレーム呼ぶ */
  update(): void {
    if (this.wizard) {
      if (!this.manager.connected) {
        // ウィザード中の切断は中止扱い
        this.closeWizard();
      } else {
        this.wizard.feed(this.manager.rawAxes, this.manager.rawButtons);
        this.renderWizard();
      }
    }
    this.renderPanel();
  }

  // --- 内部 ---

  private handleAction(action: string): void {
    switch (action) {
      case 'calibrate': {
        const id = this.manager.gamepadId;
        if (!id) return;
        this.wizard = new CalibrationWizard({ gamepadId: id, mode: this.currentMode() });
        this.wizardKey = '';
        this.overlay.hidden = false;
        break;
      }
      case 'preset-standard':
        this.manager.applyStandardPreset(this.currentMode());
        break;
      case 'mode-1':
      case 'mode-2': {
        const mode: StickMode = action === 'mode-1' ? 1 : 2;
        this.preferredMode = mode;
        this.manager.setMode(mode);
        break;
      }
      case 'wizard-neutral':
        this.wizard?.confirmNeutral();
        break;
      case 'wizard-skip':
        this.wizard?.skipDeclare();
        break;
      case 'wizard-finish': {
        const result = this.wizard?.finish() ?? null;
        if (result) {
          this.manager.saveCalibration(result);
          this.closeWizard();
        }
        break;
      }
      case 'wizard-cancel':
        this.closeWizard();
        break;
      default:
        break;
    }
  }

  private currentMode(): StickMode {
    return this.manager.calibration?.mode ?? this.preferredMode;
  }

  private closeWizard(): void {
    this.wizard = null;
    this.holdBar = null;
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.wizardKey = '';
  }

  private renderPanel(): void {
    const m = this.manager;
    const calibrated = m.calibration !== null;
    const mode = m.calibration?.mode ?? this.preferredMode;
    const key = `${m.connected}|${m.gamepadId ?? ''}|${calibrated}|${mode}|${m.mapping ?? ''}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    this.panel.innerHTML = m.connected
      ? this.connectedHtml(m.gamepadId ?? '', calibrated, mode, m.mapping === 'standard')
      : this.disconnectedHtml();
  }

  private disconnectedHtml(): string {
    return `
      <details open>
        <summary class="ip-title">入力機器: <b>未接続</b></summary>
        <p class="ip-guide">${CONNECT_GUIDE_TEXT}</p>
        <details class="ip-trouble">
          <summary>認識されないときは</summary>
          <ul>
            <li>スティックではなく<b>スイッチ（SA〜SD等）を数回操作</b>するか、ボタンを押す</li>
            <li>この画面を一度クリックして<b>タブにフォーカス</b>を当てる</li>
            <li>USBケーブルが<b>データ通信対応</b>か確認（充電専用ケーブルは不可）</li>
            <li>プロポが<b>USBジョイスティックモード</b>になっているか確認（EdgeTX機は接続時に「USB Joystick (HID)」を選択）</li>
            <li>DJI純正送信機は非対応（ジョイスティックとして認識されないため）</li>
          </ul>
        </details>
        <p class="ip-kb">キーボードでも操縦できます（モード2配置: W/S=スロットル・A/D=ラダー・↑↓=エレベーター・←→=エルロン・Space=安全確認宣言）</p>
      </details>`;
  }

  private connectedHtml(
    id: string,
    calibrated: boolean,
    mode: StickMode,
    isStandard: boolean,
  ): string {
    const status = calibrated
      ? `キャリブレーション済（モード${mode}）`
      : '未キャリブレーション（キーボード操作のまま）';
    return `
      <details open>
        <summary class="ip-title">入力機器: <b>接続中</b></summary>
        <div class="ip-id">${escapeHtml(id)}</div>
        <div class="ip-calib">${status}</div>
        <div class="ip-actions">
          <button type="button" data-action="calibrate">${calibrated ? 'キャリブレーションをやり直す' : 'キャリブレーション開始'}</button>
          ${isStandard ? '<button type="button" data-action="preset-standard">標準ゲームパッド配置を使う</button>' : ''}
        </div>
        <div class="ip-mode">スティックモード:
          <button type="button" data-action="mode-1" class="${mode === 1 ? 'active' : ''}">モード1</button>
          <button type="button" data-action="mode-2" class="${mode === 2 ? 'active' : ''}">モード2</button>
        </div>
      </details>`;
  }

  private renderWizard(): void {
    const w = this.wizard;
    if (!w) return;
    const v = w.step;
    const key = `${v.kind}|${v.stepIndex}|${v.message ?? ''}`;
    if (key !== this.wizardKey) {
      this.wizardKey = key;
      this.overlay.innerHTML = `
        <div class="wizard-dialog">
          <div class="wizard-title">キャリブレーション（ステップ ${v.stepIndex}/${v.stepCount}）</div>
          <p class="wizard-prompt">${v.prompt}</p>
          <div class="wizard-hold"><div class="wizard-hold-bar"></div></div>
          <p class="wizard-msg">${v.message ?? ''}</p>
          <div class="wizard-actions">
            ${v.kind === 'neutral' ? '<button type="button" data-action="wizard-neutral">中立を記録</button>' : ''}
            ${v.kind === 'declare-button' ? '<button type="button" data-action="wizard-skip">スキップ（Spaceキーのみ使用）</button>' : ''}
            ${
              v.kind === 'deadzone'
                ? `<label class="wizard-dz">デッドゾーン
                     <input id="ip-deadzone" type="range" min="0" max="0.3" step="0.01" value="${w.deadzone}">
                     <span id="ip-deadzone-val">${w.deadzone.toFixed(2)}</span>
                   </label>
                   <button type="button" data-action="wizard-finish">完了</button>`
                : ''
            }
            <button type="button" class="wizard-cancel" data-action="wizard-cancel">中止</button>
          </div>
        </div>`;
      this.holdBar = this.overlay.querySelector('.wizard-hold-bar');
    }
    if (this.holdBar) {
      this.holdBar.style.width = `${Math.round(v.holdProgress * 100)}%`;
    }
  }
}
