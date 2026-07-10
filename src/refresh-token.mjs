// refresh-token.mjs
// 長期アクセストークン（Instagramログイン方式）を延長する。
// 標準出力(stdout)には「新しいトークンだけ」を出す（CIで取り込むため）。
// 説明メッセージは標準エラー(stderr)へ。
//
// 環境変数:
//   IG_ACCESS_TOKEN … 現在の長期トークン
// 実行:
//   IG_ACCESS_TOKEN=xxxx node src/refresh-token.mjs

const TOKEN = process.env.IG_ACCESS_TOKEN;
if (!TOKEN) { console.error('Missing env: IG_ACCESS_TOKEN'); process.exit(1); }

const url = new URL('https://graph.instagram.com/refresh_access_token');
url.searchParams.set('grant_type', 'ig_refresh_token');
url.searchParams.set('access_token', TOKEN);

const res = await fetch(url);
const json = await res.json();
if (!res.ok || json.error) { console.error(JSON.stringify(json, null, 2)); process.exit(1); }

const days = Math.round((json.expires_in || 0) / 86400);
console.error(`新しい長期トークンを取得（有効期限 約${days}日）`);
process.stdout.write(json.access_token); // stdout はトークンのみ
