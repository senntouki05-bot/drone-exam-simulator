# drone-exam-sim

二等無人航空機操縦士（回転翼マルチローター・基本）実地試験の**実技シミュレータ**。実物のプロポをUSB接続してブラウザで練習する。

- 状態: **設計段階**（2026-07-18設計書作成・実装未着手）
- [DESIGN.md](DESIGN.md) — 全体設計（試験仕様・システム構成・マイルストーン）
- [CLAUDE-CODE-PROMPT.md](CLAUDE-CODE-PROMPT.md) — Claude Codeに貼る開発プロンプト
- [research/RESEARCH-2026-07-18.md](research/RESEARCH-2026-07-18.md) — 事前調査（一次資料の出典つき）

## 始め方

```bash
cd ~/dev/drone-exam-sim && claude
# CLAUDE-CODE-PROMPT.md の内容を貼り付け（まずは「M0〜M2まで」区切りを推奨）
```

## ハードウェア前提

- EdgeTX系プロポ（RadioMaster等）ならUSBケーブル1本で接続可。
- **DJI純正送信機は非対応**（HIDとして認識されないため）。
