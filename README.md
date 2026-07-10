# ig-story-auto — 営業案内ストーリーの自動投稿

スケジュール（JSON）を渡すだけで、毎日の Instagram ストーリーズを自動生成・自動投稿する仕組みです。

- **営業日**: `OPEN` ＋ 曜日・日付・営業時間
- **休業日**: `CLOSED` ＋ 次の営業日と営業時間（臨時休業も同じ挙動で自動処理）
- 写真は `backgrounds/` に撮り溜めておくと日替わりで自動差し替え。**毎回の画像編集は不要。**
- 臨時休業・時間変更は `schedule.json` の `overrides` に1行足すだけ。

構成: `schedule.json`（データ） → `src/render.mjs`（HTML→PNG） → `src/post.mjs`（Graph APIで投稿）。毎朝 GitHub Actions が自動実行します。

---

## 1. スケジュールの編集（`schedule.json`）

```jsonc
{
  "shopName": "YOUR BIKE SHOP",   // ストーリーに出る店名
  "location": "田園調布, 東京",
  "regular": {                    // 毎週の固定営業時間。null = 定休日
    "mon": null,
    "tue": { "open": "11:00", "close": "19:00" },
    ...
  },
  "overrides": {                  // 臨時の変更だけここに足す
    "2026-07-15": null,                                   // 臨時休業
    "2026-07-20": { "open": "13:00", "close": "18:00", "note": "短縮営業" }  // 時間変更
  }
}
```

臨時休業や時間変更は `overrides` に日付キーで足すだけ。過ぎた日付は消してOK（残っていても無害）。
スマホから編集したいなら、このJSONをGoogleスプレッドシート化する拡張も可能です（下の「発展」参照）。

## 2. ローカルで見た目を確認

```bash
npm install
npx playwright install chromium

node src/render.mjs              # 今日の分 → out/story.png
node src/render.mjs 2026-07-15   # 指定日でテスト → out/story-2026-07-15.png
```

`out/story-*.html` も一緒に出力されるので、ブラウザで開けばデザイン調整ができます。
見た目（色・フォント）は `src/template.html` 冒頭の `:root` 変数をいじるだけで変えられます。

## 3. Instagram 側の準備（初回だけ）

自動投稿には Meta の Graph API を使います。以下が必要です。

1. Instagram を**プロアカウント（ビジネス/クリエイター）**にし、Facebookページと連携。
2. [Meta for Developers](https://developers.facebook.com/) でアプリを作成。
3. `instagram_business_content_publish` 権限を取得（アプリ審査 & ビジネス認証が必要な場合あり）。
4. **長期アクセストークン**と **IGユーザーID**（数字）を取得。

> 注意
> - ストーリーはテキストのみ不可 → 必ず画像が要る（このツールが毎日生成します）。
> - 投稿は24時間で消えます。1日あたり25投稿まで（リール等と共有枠）。
> - 長期トークンは約60日で失効。定期的にリフレッシュしてください（`src/refresh-token.mjs` 参照）。

## 4. GitHub Actions で毎朝自動化

1. このフォルダをそのまま **公開リポジトリ**として GitHub に push
   （画像を公開URLで配信するため。店の営業案内画像なので公開で問題なし）。
2. リポジトリの **Settings → Secrets and variables → Actions** に登録:
   - `IG_USER_ID` … InstagramのユーザーID
   - `IG_ACCESS_TOKEN` … 長期アクセストークン
3. あとは `.github/workflows/daily-story.yml` が毎日 **JST 08:00** に自動実行。
   `workflow_dispatch`（Actionsタブの「Run workflow」）で臨時にも回せます。

投稿時刻は `daily-story.yml` の `cron: '0 23 * * *'`（UTC）を変えれば調整できます。
（例: JST 07:00 に投げたいなら `'0 22 * * *'`。）

## 5. 運用の流れ

- 通常: **何もしなくてOK**。毎朝その日の営業案内が自動で流れます。
- 臨時休業/時間変更: `schedule.json` の `overrides` に足して push するだけ。
- 写真を増やす: `backgrounds/` に画像を足して push するだけ。

---

## 発展（必要なら追加できます）

- **Googleスプレッドシート連携**: 臨時休業をスマホの表からポチッと入力 → 自動反映。
- **オンラインストア(Shopify)への導線**: ストーリーに「オンラインは24h営業」バッジ＋リンクスタンプ用の固定文言。
- **休業日は投稿しない/別デザイン**にする、祝日を自動判定する、なども対応可能。
