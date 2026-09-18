// community.js (サンプル)
// ============================================================
// Supabaseとの連携部分。index.htmlに以下のCDNスクリプトタグを追加してから使う:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//
// SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY は、Supabaseダッシュボードの
// Project Settings → API に表示されているものをそのまま使う。
//
// publishable key(sb_publishable_...)は「公開されても問題ない」設計になっている
// (実際のアクセス制御はRLSポリシー側でやっている)ので、ソースに直接書いてOK。
//
// ★secret key(sb_secret_...)は絶対にここ(ブラウザ側のコード)に書かないこと。
//   RLSを全部バイパスできる強い権限を持つキーで、サーバー側でしか使ってはいけない。
// ============================================================

const SUPABASE_URL = 'https://bwtptvftoqxgvslnpnff.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_den85maPZO7Il3gLor1--A__Uc4Q9cp';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // Supabase無料枠の上限(50MB)に合わせる
const ALLOWED_KINDS = new Set(['texture', 'pose', 'effect', 'shader']);


// ============================================================
// 投稿する
// ============================================================
async function uploadCommunityPost(file, kind, title, author) {
  if (!ALLOWED_KINDS.has(kind)) throw new Error('kindが不正です');
  if (file.size > MAX_FILE_SIZE) throw new Error(`ファイルが大きすぎます(上限${MAX_FILE_SIZE / 1024 / 1024}MB)`);

  const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
  const storagePath = `${kind}/${crypto.randomUUID()}${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from('community-assets')
    .upload(storagePath, file, { contentType: file.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;

  const { data, error: insertError } = await supabaseClient
    .from('posts')
    .insert({
      kind, title, author: author || '名無し',
      storage_path: storagePath, file_size: file.size,
    })
    .select()
    .single();
  if (insertError) throw insertError;

  return data;
}


// ============================================================
// 一覧を取得する
// ============================================================
async function listCommunityPosts(kind, { limit = 20, before = null } = {}) {
  let query = supabaseClient
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (kind) query = query.eq('kind', kind);
  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}


// ============================================================
// ダウンロード用URLを取得する(publicバケットなので、直接組み立てるだけで良い)
// ============================================================
function communityFileUrl(storagePath) {
  const { data } = supabaseClient.storage.from('community-assets').getPublicUrl(storagePath);
  return data.publicUrl;
}


// ============================================================
// 使用例
// ============================================================
// const post = await uploadCommunityPost(fileInput.files[0], 'texture', 'マイテクスチャ', '増田');
//
// const posts = await listCommunityPosts('texture');
// for (const p of posts) {
//   console.log(p.title, communityFileUrl(p.storage_path));
// }
