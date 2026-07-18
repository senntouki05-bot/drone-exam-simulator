/**
 * input/KeyboardInput.ts — キーボードフォールバック入力（モード2配置）。
 *
 * W/S=スロットル・A/D=ラダー（左スティック相当）
 * ↑↓=エレベーター・←→=エルロン（右スティック相当）
 * Space=安全確認宣言（M4で使用。M0では押下記録のみ）
 *
 * M1でGamepad入力と共通のInputSourceインターフェースに統合する予定。
 * デジタル入力の平滑はsim側の1次遅れに任せ、ここでは-1/0/+1を返す。
 */

import type { ControlInput } from '../sim/FlightModel';

const CONTROL_CODES = new Set([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private readonly target: Window;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!CONTROL_CODES.has(e.code)) return;
    e.preventDefault(); // 矢印キーのスクロール等を抑止
    this.pressed.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear(); // フォーカス喪失でスタックキー防止
  };

  constructor(target: Window = window) {
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }

  /** 現在の4軸を読む（毎物理ステップ呼んでよい・アロケーション回避のためoutへ書き込む） */
  read(out: ControlInput): void {
    out.throttle = this.axis('KeyW', 'KeyS');
    out.rudder = this.axis('KeyD', 'KeyA');
    out.elevator = this.axis('ArrowUp', 'ArrowDown');
    out.aileron = this.axis('ArrowRight', 'ArrowLeft');
  }

  /** 安全確認宣言キー（Space）が押されているか（M4で使用） */
  get declarePressed(): boolean {
    return this.pressed.has('Space');
  }

  private axis(positive: string, negative: string): number {
    return (this.pressed.has(positive) ? 1 : 0) - (this.pressed.has(negative) ? 1 : 0);
  }
}
