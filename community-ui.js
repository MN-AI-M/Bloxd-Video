// community-ui.js
// ============================================================
// 投稿(post)の見た目まわりの共有ヘルパー。community.js(Supabaseとの
// やり取り)とは分けてあり、home.html / browse.html の両方から使う。
//
// サムネイル画像を持たない投稿(テクスチャzip・ポーズ/エフェクトJSON)を
// 「素材タイル」として見せるための、種類ごとのラベル・アイコン・カード生成。
// ============================================================

const KIND_META = {
  texture: { label: 'テクスチャ', icon: iconTexture, className: 'texture' },
  pose:    { label: 'ポーズ',     icon: iconPose,    className: 'pose' },
  effect:  { label: 'エフェクト', icon: iconEffect,  className: 'effect' },
  shader:  { label: 'シェーダー', icon: iconShader,  className: 'shader' },
};

function iconTexture() {
  return `<svg viewBox="0 0 48 48" fill="none"><rect x="6" y="6" width="16" height="16" rx="2" fill="currentColor" opacity="0.9"/><rect x="26" y="6" width="16" height="16" rx="2" fill="currentColor" opacity="0.45"/><rect x="6" y="26" width="16" height="16" rx="2" fill="currentColor" opacity="0.45"/><rect x="26" y="26" width="16" height="16" rx="2" fill="currentColor" opacity="0.9"/></svg>`;
}
function iconPose() {
  return `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="24" cy="10" r="4" fill="currentColor" stroke="none"/><path d="M24 15 L24 28 M24 19 L14 25 M24 19 L34 25 M24 28 L16 40 M24 28 L32 40"/></svg>`;
}
function iconEffect() {
  return `<svg viewBox="0 0 48 48" fill="currentColor"><path d="M24 4 L28 20 L44 24 L28 28 L24 44 L20 28 L4 24 L20 20 Z"/></svg>`;
}
function iconShader() {
  return `<svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="16" fill="currentColor" opacity="0.9"/><path d="M24 8 A16 16 0 0 0 24 40 Z" fill="#0B0D12" opacity="0.55"/></svg>`;
}

function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}か月前`;
  return `${Math.floor(months / 12)}年前`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// post(Supabaseの行) -> カードのDOM要素
function buildPostCard(post) {
  const meta = KIND_META[post.kind] || KIND_META.texture;
  const el = document.createElement('a');
  el.className = 'post-card';
  el.href = communityFileUrl(post.storage_path);
  el.target = '_blank';
  el.rel = 'noopener';
  el.innerHTML = `
    <div class="post-card-tile ${meta.className}">${meta.icon()}</div>
    <div class="post-card-body">
      <span class="kind-tag ${meta.className}">${meta.label}</span>
      <h3>${escapeHtml(post.title)}</h3>
      <p class="post-card-meta">${escapeHtml(post.author || '名無し')} ・ ${formatRelativeTime(post.created_at)} ・ ${formatFileSize(post.file_size)}</p>
    </div>
  `;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
