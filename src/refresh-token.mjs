// refresh-token.mjs
// 長期アクセストークン（Instagramログイン方式）を延長する。
// 約60日で失効するので、切れる前に実行して新しいトークンでSecretを更新する。
//
// 環境変数:
//   IG_ACCESS_TOKEN … 現在の長期トークン（60日以内・24時間以上経過したもの）
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

console.log('新しい長期トークン:');
console.log(json.access_token);
console.log(`有効期限(秒): ${json.expires_in ?? '(不明)'}  ≒ ${Math.round((json.expires_in || 0) / 86400)}日`);
