# カメラスクリプト API(バージョン 1)

Bloxd Replay Editor のカメラスクリプトは、実行すると **カメラやテキストを作る・直す命令** を出す小さな JavaScript です。
命令はまとめてエディタに反映され、**Ctrl+Z 1回で全部元に戻せます**。結果はふつうのカメラブロックなので、あとから手で直すこともできます。

- 置き場所: 左の素材一覧 → 🧩 スクリプト(公式 / カスタム / 公開)
- 書く: カスタム → 「＋ 新しく書く」。公式スクリプトは `</>` から中身を見て「コピーして編集」できます
- 渡す: スクリプトの右パネル → 「⬇ .js で書き出す」。もらった側は「⬆ .js を読み込む」

## 安全のしくみ

スクリプトは、ページから切り離された場所(別オリジンの sandbox iframe の中の Web Worker)で動きます。

- ネットワーク(fetch / XMLHttpRequest / WebSocket / importScripts)は使えません
- エディタのページ・DOM・保存データ(localStorage 等)には触れません
- 15秒で終わらなければ打ち切られます(無限ループでも画面は固まりません)
- スクリプトが出した命令は、エディタ側で全部チェックしてから反映します。1つでもおかしな命令があれば何も反映しません

そのため、他の人が書いたスクリプトでも安心して試せます。

## 単位と座標

| もの | 単位 |
|---|---|
| 位置 `pos` | Bloxd のワールド座標 `[x, y, z]`(画面左上に出ている座標と同じ) |
| 向き `yaw` / `pitch` | 度。`yaw = 0` が +Z 方向、`yaw = 90` が +X 方向。`pitch` は上が + (−88〜88) |
| `tick` | リプレイのコマ番号。`api.tps` コマ = 1秒 |
| キーの `time` | カメラブロックの先頭からの **秒** |

## 書き方の基本

```js
api.info({ name: '真上から見る', description: '再生ヘッドの所に、真上から見下ろすカメラを置く' });

const p = api.params({
  height:  { type: 'number', label: '高さ', min: 5, max: 40, step: 1, default: 18, unit: 'ブロック' },
  seconds: { type: 'number', label: '長さ', min: 1, max: 20, step: 0.5, default: 3, unit: '秒' },
});

const f = api.player().at(api.playhead);
api.addCamera({
  start: api.playhead,
  seconds: p.seconds,
  name: '真上',
  keys: [{ time: 0, pos: [f.head[0], f.head[1] + p.height, f.head[2] + 0.1], lookAt: f.head }],
});
```

- スクリプトは関数の中身として実行されます。一番外側で `return` や `await` が使えます
- `api.info` と `api.params` は、スクリプトの **最初の方** に書いてください。
  エディタは右パネルに設定項目を出すため、`api.params` の所まで(隔離した場所で)スクリプトを動かして項目を読み取ります

## 情報・設定

| API | 説明 |
|---|---|
| `api.version` | この API のバージョン(今は `1`) |
| `api.info({ name, description })` | スクリプトの名前と説明(読み込んだ時の名前・説明に使われます) |
| `api.params(defs)` | 設定項目を定義し、今の値のオブジェクトを返す(下を参照) |
| `api.tps` | 1秒あたりのコマ数 |
| `api.totalTicks` | リプレイ全体のコマ数 |
| `api.playhead` | 再生ヘッドの tick |
| `api.toTick(秒)` / `api.toSec(tick)` | 秒 ⇄ tick |
| `api.view` | 今の編集視点 `{ pos, yaw, pitch, fov }` |

### 設定項目の種類

```js
api.params({
  dist:  { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 6, unit: 'ブロック' }, // スライダー
  aim:   { type: 'bool',   label: 'プレイヤーの方を向く', default: true },                         // チェック
  mode:  { type: 'choice', label: '動き方', options: [['なめらか', 'smooth'], ['等速', 'linear']], default: 'smooth' }, // ボタン
  title: { type: 'text',   label: '文字', default: 'スタート!' },                                   // 文字入力
});
```

設定した値は、スクリプトごとにブラウザに保存されます。

## プレイヤー

| API | 説明 |
|---|---|
| `api.players()` | 全員の `{ id, name, isMe }` |
| `api.player(id?)` | プレイヤーを取得。省略すると右下で選んでいる人 |
| `player.id` / `player.name` / `player.isMe` / `player.ticks` | 基本情報 |
| `player.at(tick)` | その時刻の状態(範囲外は端に寄せる) |

`player.at(tick)` が返すもの:

| 項目 | 説明 |
|---|---|
| `pos` | 足元の位置 |
| `head` | 目の位置(足元 + 1.5) |
| `yaw` / `pitch` | 向き(度) |
| `pose` | 姿勢の名前(例: `'walk'`) |
| `held` | 持っているアイテムの名前(無ければ `null`) |
| `jumping` / `crouching` | ジャンプ中・しゃがみ中か |

## 地形

リプレイから分かる、**表面が見えているブロック**を使います(埋もれて見えないブロックは入っていません)。
`tick` を渡すと、その時点で建っているブロックだけを見ます(建築の途中を正しく扱えます)。

| API | 説明 |
|---|---|
| `api.world.raycast(from, to, { tick, ignoreStart })` | `from` から `to` への線分で最初にぶつかるブロック。`{ pos, block, normal, dist }` か `null` |
| `api.world.isSolid(x, y, z, tick?)` | そこにブロックがあるか |
| `api.world.groundY(x, z, fromY?, tick?)` | その列で `fromY` 以下の一番上のブロックの上面の高さ(無ければ `null`) |

`ignoreStart: true` で出発点のブロックを無視します。プレイヤーの頭が草や水の中にある時などに使います。

## カメラを読む

| API | 説明 |
|---|---|
| `api.cameras()` | 全カメラ |
| `api.camera(id)` | IDで1台 |
| `api.selectedCamera()` | 選んでいるカメラ(無ければ `null`) |
| `cam.poseAt(tick)` | その時刻の `{ pos, yaw, pitch }`(エディタと同じ補間・速さのカーブ込み) |

カメラのオブジェクト: `{ id, name, start, end, layer, fov, display, keys }`

- `start` / `end`: tick。`layer`: 重なり順(大きいほど手前)
- `display`: 画面の中の表示位置 `{ x, y, w }`(0〜1の割合)。`null` は自動
- `keys`: `[{ time, pos, yaw, pitch, curve? }]`

## 作る・直す

| API | 説明 |
|---|---|
| `api.addCamera(spec)` | カメラを追加。戻り値のIDは、同じスクリプトの中で `updateCamera` などに使えます |
| `api.updateCamera(id, patch)` | 書いた所だけ変える(`keys` は全部入れ替え) |
| `api.removeCamera(id)` | 削除 |
| `api.addText(spec)` | テキストを追加 |
| `api.select(id)` | 実行後に選んでおくカメラ |
| `api.seek(tick)` | 実行後の再生ヘッドの位置 |

### `addCamera` / `updateCamera` の項目

| 項目 | 説明 |
|---|---|
| `start` | 始まりの tick(`addCamera` で省略すると再生ヘッド) |
| `end` か `seconds` | 終わりの tick か、長さ(秒) |
| `name` | 名前 |
| `fov` | 画角(度) |
| `layer` | 重なり順。同じ層で時間が重なると、自動で上の層にずれます |
| `display` | 表示位置 `{ x, y, w }` か `null` |
| `keys` | キーの配列(1つ以上) |

### キー

```js
{ time: 1.5, pos: [x, y, z], yaw: 90, pitch: -10 }
{ time: 1.5, pos: [x, y, z], lookAt: [x, y, z] }         // その点を向く
{ time: 0,   pos: [x, y, z], lookAt: head, curve: 'smooth' } // 次のキーまでの速さ
```

`curve` は `'linear'`(等速)/ `'smooth'`(なめらか)/ `'easeIn'`(ゆっくり始まる)/ `'easeOut'`(ゆっくり止まる)、
または `[x1, y1, x2, y2]`(CSS の cubic-bezier と同じ)。

### `addText` の項目

`start`, `seconds` か `end`, `content`, `x`, `y`(0〜1)に加えて、見た目の項目が使えます:
`font`('gothic' / 'rounded' / 'mincho' / 'pixel' / 'display'), `fontSize`, `weight`, `italic`, `color`, `opacity`, `align`,
`letterSpacing`, `lineHeight`, `strokeWidth`, `strokeColor`, `shadow`('none' / 'soft' / 'hard' / 'glow'), `shadowColor`,
`bgOpacity`, `bgColor`, `bgPadding`, `bgRadius`, `rotation`, `animIn`, `animInSec`, `animOut`, `animOutSec`。

## べんりな道具

| API | 説明 |
|---|---|
| `api.math.vec.add / sub / scale / dot / cross / len / dist / norm / lerp` | 3次元ベクトル(配列 `[x, y, z]`) |
| `api.math.lookAt(from, to)` | `from` から `to` を向く `{ yaw, pitch }` |
| `api.math.forward(yaw, pitch?)` | 向き → 前向きのベクトル |
| `api.math.right(yaw)` | 向き → 右向きのベクトル(水平) |
| `api.math.angleDiff(a, b)` | a から b への一番近い回り方の角度差(−180〜180) |
| `api.math.noise(t, seed)` | なめらかな揺れ(−1〜1) |
| `api.math.random(seed)` | 毎回同じ順で数が出る乱数を作る(`const r = api.math.random(1); r()`) |
| `api.math.clamp / lerp / smoothstep / easeInOut` | よく使う計算 |
| `api.curves` | 速さのカーブのひな形 |
| `api.evalKeys(keys, 秒)` | キーの配列の補間(`poseAt` と同じ計算) |

## その他

| API | 説明 |
|---|---|
| `api.log(...)` | 右パネルの結果の欄に表示 |
| `api.toast(文)` | 画面上に通知 |
| `api.fail(文)` | 理由を表示して止める(何も変えない) |
| `api.progress(0〜1)` | 進み具合のバー |

## 例: 壁に隠れる所だけカメラを寄せる(公式「障害物をよける」の要点)

```js
const cam = api.selectedCamera();
if (!cam) api.fail('カメラを選んでください');
const me = api.player(), V = api.math.vec;
const len = (cam.end - cam.start) / api.tps;
const keys = [];
for (let t = 0; t <= len; t += 0.25) {
  const tick = cam.start + api.toTick(t);
  const pose = cam.poseAt(tick), head = me.at(tick).head;
  const hit = api.world.raycast(head, pose.pos, { tick, ignoreStart: true });
  const pos = hit ? V.add(head, V.scale(V.norm(V.sub(pose.pos, head)), Math.max(1.5, hit.dist - 0.6))) : pose.pos;
  keys.push({ time: t, pos, yaw: pose.yaw, pitch: pose.pitch });
}
api.updateCamera(cam.id, { keys });
```

## 制限

- 1回の実行で出せる命令は 20000 個まで、1台のカメラのキーは 5000 個まで
- 実行時間は 15 秒まで
- `api.log` は 500 行まで
