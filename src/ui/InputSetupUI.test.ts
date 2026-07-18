import { describe, expect, it } from 'vitest';
import { CONNECT_GUIDE_TEXT } from './InputSetupUI';

describe('接続画面の導線文言（仕様固定）', () => {
  it('CLAUDE-CODE-PROMPT.md「入力（input/）」節の文言と一致する', () => {
    expect(CONNECT_GUIDE_TEXT).toBe(
      'プロポのスイッチを操作するか、いずれかのボタンを押してください（スティック操作だけでは認識されない場合があります）',
    );
  });
});
