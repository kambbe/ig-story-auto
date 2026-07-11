# ig-story-auto — 営業案内ストーリーの自動投稿

その日の営業状況（営業中／臨時休業）を毎朝 Instagram ストーリーズに自動投稿する仕組み。
写真の上に、日付・OPEN/CLOSED・営業時間・次の営業日・一言（備考）を自動で載せて画像化する。

- **営業日** … `OPEN` ＋ 日付・営業時間
- **休業日** … `CLOSED` ＋ 次の営業日と営業時間
- 臨時休業・時間変更は **Googleスプレッドシート**に1行足すだけ（スマホから、GitHub不要）
- 背景写真は `backgrounds/` に入れておくと日替わりで自動差し替え（HEIC可）
- 毎朝 **JST 10:00** に GitHub Actions が自動投稿。トークンも毎月自動更新

日々の使い方・初期セットアップは **[運用ガイド.md](./運用ガイド.md)** を参照。

---

## 仕組み（データの流れ）

```
schedule.json（週の固定営業時間）
        ＋
Googleスプレッドシート（臨時休業・時間変更・備考）  ← スマホから編集
        ↓  src/render.mjs が毎朝読み込み
その日の状態を計算（src/status.mjs）
        ↓  src/template.html に流し込み
Playwright で 1080×1920 PNG を生成（背景は backgrounds/ から日替わり）
        ↓  src/post.mjs
Instagram グラフAPI（graph.instagram.com）でストーリー投稿
```

## ファイル

| ファイル | 役割 |
|----------|------|
| `schedule.json` | 店名・週の固定営業時間・スプレッドシートURL・（予備の）臨時設定 |
| `src/status.mjs` | 指定日の営業/休業と次の営業日を計算（JST基準） |
| `src/render.mjs` | スプレッドシート取得＋テンプレ流し込み＋PNG生成 |
| `src/template.html` | ストーリーの見た目（`:root` の変数で色・フォント・文字サイズを調整） |
| `src/post.mjs` | Instagram へストーリー投稿（2ステップ） |
| `src/refresh-token.mjs` | 長期トークンを延長（月次で自動実行） |
| `backgrounds/` | 背景写真（jpg/png/webp/heic、日替わりで1枚選択） |
| `.github/workflows/daily-story.yml` | 毎朝 JST 10:00 に投稿 |
| `.github/workflows/refresh-token.yml` | 毎月1日にトークンを自動更新 |

## ローカルで見た目を確認

```bash
npm install
npx playwright install chromium

node src/render.mjs              # 今日の分 → out/story.png
node src/render.mjs 2026-07-22   # 指定日でテスト → out/story-2026-07-22.png
```

`out/story-*.html` も出力されるので、ブラウザで開けば調整しやすい（原寸なのでズームアウト推奨）。
見た目は `src/template.html` 冒頭の `:root`（`--accent` / `--muted` / 各 `--fs-*`）で変える。

## スケジュールの持ち方

- **週の固定営業時間** … `schedule.json` の `regular`（`null` = 定休日）。
- **臨時休業・時間変更・備考** … スプレッドシート（`overridesSheetCsvUrl` に公開CSVのURL）。
  同じ日付はスプレッドシートが `schedule.json` の `overrides` より優先。取得失敗時は `overrides` で継続。

スプレッドシートの列は3つ：`日付 / 営業時間 / 備考`
- 臨時休業 = 日付だけ入れて営業時間は空欄
- 時間変更 = `14:00-18:00`（`〜` でも可）
- 備考 = 任意の一言（ストーリーに表示）

## Instagram 側（Instagramログイン方式）

- Instagram プロアカウント＋Facebookページ連携。
- Meta アプリ（ユースケース「Instagramでメッセージとコンテンツを管理」）。
- 自分のアカウントに投稿するだけなら **App Review・ビジネス認証は不要**（開発モードのまま）。
- 必要な GitHub Secrets：`IG_USER_ID` / `IG_ACCESS_TOKEN` / `GH_PAT`（トークン自動更新用）。
- トークンは約60日で失効するが、`refresh-token.yml` が毎月更新するので基本は放置。

詳しい取得・設定手順は **[運用ガイド.md](./運用ガイド.md)** を参照。

## メモ

- ストーリーへのリンクスタンプはAPIでは付けられない（自動投稿では不可）。オンライン導線はプロフィールのリンクへ。
- 定刻実行は数分ずれることがある。当日ぶんの変更はスプレッドシートに早めに。
