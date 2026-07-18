/**
 * input/InputSource.ts — 入力ソースの共通インターフェース。
 *
 * KeyboardInput（フォールバック）と GamepadManager（プロポ/パッド）が実装する。
 * main.ts は「どのソースが有効か」だけを選び、シムへは正規化済みの ControlInput を渡す。
 */

import type { ControlInput } from '../sim/FlightModel';

export interface InputSource {
  /** 現在の4軸（各-1〜+1）をoutへ書き込む（毎物理ステップ呼んでよい・アロケーションしない） */
  read(out: ControlInput): void;
  /** 安全確認の宣言キー/ボタンが押されているか（M4の採点で使用） */
  readonly declarePressed: boolean;
}
