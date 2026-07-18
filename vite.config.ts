import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Cloudflare Pages等どこに置いても動くよう相対パス（完全静的・外部CDNなし）
  base: './',
  test: {
    // exam/ はヘッドレス純粋モジュールにする方針（実装原則3）のため、テストはnode環境で走らせる
    environment: 'node',
  },
});
