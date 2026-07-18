/**
 * ui/WarningBeep.ts — 減点警告のビープ音（WebAudio・本番実装）。
 *
 * 減点警告はTTSでなく即時ビープ＋HUD視覚警告（設計方針）。2秒復帰窓の起点は
 * ExamSession側がシム時間のイベント発生時刻で記録するため、音が鳴らなくても判定は成立する。
 * resume() は課目開始ボタンのクリックハンドラ内で呼ぶ（AudioContextの自動再生制限対策）。
 */

export class WarningBeep {
  private ctx: AudioContext | null = null;

  /** 課目開始クリックで呼ぶ（生成＋suspended解除） */
  resume(): void {
    if (typeof AudioContext === 'undefined') return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 区画進入などの警告（高いピッ×2） */
  warning(): void {
    this.tone(880, 0, 0.09);
    this.tone(880, 0.13, 0.09);
  }

  /** 減点確定（低いブッ） */
  deduct(): void {
    this.tone(330, 0, 0.22);
  }

  /** 即不合格（下降音） */
  fail(): void {
    this.tone(440, 0, 0.18);
    this.tone(294, 0.2, 0.3);
  }

  private tone(freq: number, delayS: number, durS: number): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delayS;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durS);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durS + 0.05);
  }
}
