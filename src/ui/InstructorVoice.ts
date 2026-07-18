/**
 * ui/InstructorVoice.ts — 試験員指示の音声（SpeechSynthesis・本番実装）。
 *
 * - lang=ja-JP かつ localService===true の音声を優先（macOSならKyoko等）。
 *   voiceschanged を待ってから選択する（Chromeは初回getVoices()が空のことがある）。
 * - ローカル音声が無ければ available=false ＝ 字幕のみモードへ自動フォールバック
 *   （Google製ネットワーク音声はオフラインで無音になるため既定にしない）。
 * - prime() は課目開始ボタンのクリックハンドラ内で呼ぶ（ユーザー操作前はChromeが音声をブロック）。
 * - 判定タイミングはExamSession側が発話開始時刻で決める（実装原則4）ため、
 *   ここでの発話はUI演出であり、再生の成否・完了は判定に影響しない。
 */

export class InstructorVoice {
  private readonly synth: SpeechSynthesis | null;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(synth?: SpeechSynthesis | null) {
    this.synth =
      synth !== undefined ? synth : typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    if (!this.synth) return;
    this.pickVoice();
    this.synth.addEventListener('voiceschanged', () => this.pickVoice());
  }

  /** ローカルja音声が使えるか（falseなら字幕のみモード） */
  get available(): boolean {
    return this.voice !== null;
  }

  /** 課目開始のクリックハンドラ内で呼ぶ（音声のアンロック＋voices確定） */
  prime(): void {
    if (!this.synth) return;
    this.pickVoice();
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    this.synth.speak(u);
  }

  speak(text: string): void {
    if (!this.synth || !this.voice) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.voice = this.voice;
    u.rate = 1.05;
    this.synth.speak(u);
  }

  cancel(): void {
    this.synth?.cancel();
  }

  private pickVoice(): void {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    this.voice =
      voices.find((v) => v.lang.replace('_', '-').startsWith('ja') && v.localService) ?? null;
  }
}
