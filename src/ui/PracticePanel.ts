/**
 * ui/PracticePanel.ts — M5: 練習モードの設定パネル（機体・風・シーン・カメラ・区画・リプレイ）。
 *
 * 仕様（CLAUDE-CODE-PROMPT.md「描画・UI」節）: 練習モード=課目単体・区画/軌跡表示・
 * 風スライダー・機体選択・ミニマップ・リプレイ（JSONエクスポート/インポート）。
 * 俯瞰/追従カメラ切替は練習モードのみ（試験モード通し中はmain側が操縦者定点へ固定）。
 *
 * 本パネルは表示とイベント委譲のみ（状態の正はmain側）。受験中は setEnabled(false) でロック。
 */

import { MACHINES } from '../sim/MachineProfile';
import { WIND_PRESETS } from '../sim/WindPresets';

export type CameraMode = 'pilot' | 'overhead' | 'chase';
export type SceneKind = 'gym' | 'outdoor';

export interface PracticePanelHooks {
  onMachine(index: number): void;
  onWindPreset(index: number): void;
  /** 風スライダー（カスタム風: 定常風速[m/s]と突風の有無） */
  onWindCustom(steadyMs: number, gusts: boolean): void;
  onScene(kind: SceneKind): void;
  onCamera(mode: CameraMode): void;
  onZones(visible: boolean): void;
  onReplaySave(): void;
  onReplayLoad(file: File): void;
  onReplayPlay(): void;
  onReplayStop(): void;
}

export class PracticePanel {
  private readonly root: HTMLDivElement;
  private readonly machineSel: HTMLSelectElement;
  private readonly windSel: HTMLSelectElement;
  private readonly windSlider: HTMLInputElement;
  private readonly windVal: HTMLSpanElement;
  private readonly gustChk: HTMLInputElement;
  private readonly sceneSel: HTMLSelectElement;
  private readonly cameraSel: HTMLSelectElement;
  private readonly zonesChk: HTMLInputElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly loadInput: HTMLInputElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly statusEl: HTMLDivElement;

  constructor(parent: HTMLElement, hooks: PracticePanelHooks) {
    this.root = document.createElement('div');
    this.root.id = 'practice-panel';
    const machineOpts = MACHINES.map((m, i) => `<option value="${i}">${m.name}</option>`).join('');
    const windOpts = WIND_PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('');
    this.root.innerHTML = `
      <div class="ep-title">練習設定（受験中はロック）</div>
      <div class="pp-row"><span class="pp-label">機体</span><select id="pp-machine">${machineOpts}</select></div>
      <div class="pp-row"><span class="pp-label">風</span><select id="pp-wind">${windOpts}</select></div>
      <div class="pp-row"><span class="pp-label">風速</span>
        <input type="range" id="pp-wind-slider" min="0" max="3.5" step="0.1" value="0">
        <span id="pp-wind-val">0.0</span>m/s
        <label class="pp-inline"><input type="checkbox" id="pp-gust"> 突風</label></div>
      <div class="pp-row"><span class="pp-label">シーン</span><select id="pp-scene">
        <option value="gym">屋内（体育館）</option><option value="outdoor">屋外</option></select></div>
      <div class="pp-row"><span class="pp-label">カメラ</span><select id="pp-camera">
        <option value="pilot">操縦者定点</option><option value="overhead">俯瞰</option><option value="chase">追従</option></select></div>
      <div class="pp-row"><label class="pp-inline"><input type="checkbox" id="pp-zones" checked> 区画帯を表示（Z）</label></div>
      <div class="pp-row pp-replay"><span class="pp-label">リプレイ</span>
        <button type="button" id="pp-rep-save" disabled>保存</button>
        <button type="button" id="pp-rep-load">読込</button>
        <button type="button" id="pp-rep-play" disabled>再生</button>
        <button type="button" id="pp-rep-stop" hidden>停止</button>
        <input type="file" id="pp-rep-file" accept="application/json,.json" hidden></div>
      <div class="pp-status" id="pp-status">受験を完走するとリプレイを保存できます</div>
    `;
    parent.appendChild(this.root);

    this.machineSel = this.root.querySelector('#pp-machine')!;
    this.windSel = this.root.querySelector('#pp-wind')!;
    this.windSlider = this.root.querySelector('#pp-wind-slider')!;
    this.windVal = this.root.querySelector('#pp-wind-val')!;
    this.gustChk = this.root.querySelector('#pp-gust')!;
    this.sceneSel = this.root.querySelector('#pp-scene')!;
    this.cameraSel = this.root.querySelector('#pp-camera')!;
    this.zonesChk = this.root.querySelector('#pp-zones')!;
    this.saveBtn = this.root.querySelector('#pp-rep-save')!;
    this.loadInput = this.root.querySelector('#pp-rep-file')!;
    this.playBtn = this.root.querySelector('#pp-rep-play')!;
    this.stopBtn = this.root.querySelector('#pp-rep-stop')!;
    this.statusEl = this.root.querySelector('#pp-status')!;

    this.machineSel.addEventListener('change', () => hooks.onMachine(Number(this.machineSel.value)));
    this.windSel.addEventListener('change', () => {
      const i = Number(this.windSel.value);
      // スライダー表示をプリセット値に同期（風の正はmain側）
      const cfg = WIND_PRESETS[i].config;
      this.windSlider.value = String(cfg.steadyMs);
      this.windVal.textContent = cfg.steadyMs.toFixed(1);
      this.gustChk.checked = cfg.gust.enabled;
      hooks.onWindPreset(i);
    });
    const fireCustom = (): void => {
      const v = Number(this.windSlider.value);
      this.windVal.textContent = v.toFixed(1);
      hooks.onWindCustom(v, this.gustChk.checked);
    };
    this.windSlider.addEventListener('input', fireCustom);
    this.gustChk.addEventListener('change', fireCustom);
    this.sceneSel.addEventListener('change', () => hooks.onScene(this.sceneSel.value as SceneKind));
    this.cameraSel.addEventListener('change', () =>
      hooks.onCamera(this.cameraSel.value as CameraMode),
    );
    this.zonesChk.addEventListener('change', () => hooks.onZones(this.zonesChk.checked));
    this.saveBtn.addEventListener('click', () => hooks.onReplaySave());
    this.root.querySelector('#pp-rep-load')!.addEventListener('click', () => this.loadInput.click());
    this.loadInput.addEventListener('change', () => {
      const f = this.loadInput.files?.[0];
      if (f) hooks.onReplayLoad(f);
      this.loadInput.value = ''; // 同一ファイルの再選択を許す
    });
    this.playBtn.addEventListener('click', () => hooks.onReplayPlay());
    this.stopBtn.addEventListener('click', () => hooks.onReplayStop());
  }

  /** 受験中のロック（リプレイ操作含む全入力） */
  setEnabled(enabled: boolean): void {
    for (const el of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      'select, input, button',
    )) {
      if (el === this.saveBtn || el === this.playBtn) continue; // 可否は setReplayAvailable が管理
      el.disabled = !enabled;
    }
    if (!enabled) {
      this.saveBtn.disabled = true;
      this.playBtn.disabled = true;
    }
  }

  setZonesChecked(v: boolean): void {
    this.zonesChk.checked = v;
  }

  setCameraValue(mode: CameraMode): void {
    this.cameraSel.value = mode;
  }

  setMachineValue(index: number): void {
    this.machineSel.value = String(index);
  }

  setReplayAvailable(canSave: boolean, canPlay: boolean): void {
    this.saveBtn.disabled = !canSave;
    this.playBtn.disabled = !canPlay;
  }

  setReplayPlaying(playing: boolean): void {
    this.stopBtn.hidden = !playing;
    this.playBtn.hidden = playing;
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }
}
