// post.mjs
// レンダリング済みPNG（公開URL）を Instagram ストーリーズに投稿する。
// Instagramログイン方式（graph.instagram.com）の2ステップ: (1) メディアコンテナ作成 → (2) 公開。
//
// 必要な環境変数:
//   IG_USER_ID        Instagram の user_id（数字）
//   IG_ACCESS_TOKEN   長期アクセストークン（instagram_business_content_publish 権限つき）
//   IMAGE_URL         レンダリングしたPNGの「公開URL」（httpsで誰でも取得できること）
//
// 使い方: IMAGE_URL=... node src/post.mjs

const GRAPH = 'https://graph.instagram.com/v21.0';

const IG_USER_ID = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;
const IMAGE_URL = process.env.IMAGE_URL;

function need(name, v) { if (!v) { console.error(`Missing env: ${name}`); process.exit(1); } }
need('IG_USER_ID', IG_USER_ID);
need('IG_ACCESS_TOKEN', TOKEN);
need('IMAGE_URL', IMAGE_URL);

async function api(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(url, { method: 'POST', body });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Graph API error: ${JSON.stringify(json.error || json)}`);
  }
  return json;
}

async function getStatus(creationId) {
  const url = new URL(`${GRAPH}/${creationId}`);
  url.searchParams.set('fields', 'status_code,status');
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url);
  return res.json();
}

async function postOnce() {
  // 1) ストーリー用コンテナを作成
  const container = await api(`${IG_USER_ID}/media`, {
    media_type: 'STORIES',
    image_url: IMAGE_URL,
  });
  const creationId = container.id;
  console.log(`[post] container created: ${creationId}`);

  // 2) 準備完了まで待つ（画像は通常すぐFINISHED）
  for (let i = 0; i < 12; i++) {
    const st = await getStatus(creationId);
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR') throw new Error(`container error: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  // 3) 公開
  const published = await api(`${IG_USER_ID}/media_publish`, { creation_id: creationId });
  console.log(`[post] published story id: ${published.id}`);
}

// 一時的なブロック/レート制限に備えて数回だけ再試行。成功したら即終了（＝二重投稿しない）。
async function main() {
  const MAX = 3;
  const WAITS = [30000, 60000]; // 1回目失敗→30秒、2回目失敗→60秒
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      await postOnce();
      return; // 成功 → ここで終わり。以降のリトライはしない
    } catch (e) {
      console.error(`[post] 試行 ${attempt}/${MAX} 失敗: ${e.message}`);
      if (attempt >= MAX) throw e; // 最後まで失敗ならエラー終了（失敗通知が飛ぶ）
      const wait = WAITS[attempt - 1] ?? 60000;
      console.log(`[post] ${wait / 1000}秒待って再試行します…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
