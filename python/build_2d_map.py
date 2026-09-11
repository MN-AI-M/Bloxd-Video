"""
build_2d_map.py
================
.bloxdreplayを解析して、2Dトップダウンマップ用のデータ(JSON)を作る。

v2: chunkAdded/chunkRemovedのrle(ランレングス圧縮された地形本体)を
    デコードできるようになったので、地形もちゃんと載るようになった。

rleのデコード方式(ゲーム本体のJSソースから直接発見、確定):
    (runLength, blockId) のペアが繰り返される。
    どちらも「符号なしの普通のVLQ」(LEB128スタイル、MSBが継続ビット。
    Avroのzigzag varintとは別物なので注意)。
    1チャンク = 32x32x32 = 32768ブロック(実データで検証済み)。

    ※ 3軸(x,y,z)の並び順は index = z + y*32 + x*32*32 で確定済み
    (チャンク境界での高さの滑らかさを検証して確認した)。
"""
import sys, csv, json
sys.path.insert(0, '.')
from bloxdreplay_decode_full import make_decoder

CHUNK_SIZE = 32
AIR_ID = 0  # IDリストに存在しない0番はAir(空気)とみなす
MAX_LAYER_DEPTH = 32  # 地層(断面)表示で持たせる最大の深さ(パレット圧縮済みなのである程度上げても大丈夫)

# 「確実」なデータを高さに関係なく「不確実」なデータより優先するかどうか。
# False(デフォルト): 単純に一番高い(y座標が大きい)ものを採用する。
#   truncated(不確実)な読み取りが一番高くても、それが今分かってる中で
#   一番信頼できる答えなので、そのまま採用して「不確実」フラグだけ立てる。
# True: 確実 > 不確実 > 高さ の優先順位にする。
#   これを有効にすると、地上の建物など「一番上が不確実」なものが、
#   下にある確実な地面データに負けて消えてしまう不具合があるため、
#   通常は False のままにしておくこと。
PREFER_CERTAIN_OVER_HEIGHT = False


def read_vlq(data, pos):
    val, shift = 0, 0
    while data[pos] >= 128:
        val += (data[pos] & 127) << shift
        shift += 7
        pos += 1
    val += data[pos] << shift
    return val, pos + 1


def decode_rle(data):
    """(runLength, blockId)ペアの列を展開して、フラットな32768要素の配列にする"""
    blocks = []
    pos, n = 0, len(data)
    while pos < n:
        run, pos = read_vlq(data, pos)
        val, pos = read_vlq(data, pos)
        blocks.extend([val] * run)
    return blocks


def chunk_top_surface(blocks):
    """32768要素のフラット配列から、(x,z)ごとの「一番上から、空気にぶつかるまでの
    連続したブロックの積み重なり」を探す。

    軸の並び順は index = z + y*CHUNK_SIZE + x*CHUNK_SIZE*CHUNK_SIZE
    (zが一番速く変化し、次にy、xが一番遅い)。

    ※ この並び順は「チャンク境界をまたいだ時の高さの滑らかさ」を実データで
    検証して確定させたもの。以前の仮定 (x + y*32 + z*32*32) はチャンク
    "内部"は綺麗にデコードできていたが、隣のチャンクとの継ぎ目がズレて
    しまい、地形が32x32の四角いパッチ状に見える不具合があった。

    戻り値: {(x,z): (y, blockId, truncated, layers)}
        y, blockId: 一番上のブロックの世界内ローカルY座標と種類(今まで通り)
        truncated: 一番上がこのチャンクの最上段(y=31)だったか(今まで通り)
        layers: 一番上から下に向かって、空気にぶつかるまで連続して並んでいる
                (ローカルY, blockId) のリスト。地層(断面)表示に使う。
                MAX_LAYER_DEPTH層まで(ファイルサイズが爆発しないよう上限あり)。
    """
    surface = {}
    for x in range(CHUNK_SIZE):
        for z in range(CHUNK_SIZE):
            top_found = None
            layers = []
            for y in range(CHUNK_SIZE - 1, -1, -1):
                idx = z + y * CHUNK_SIZE + x * CHUNK_SIZE * CHUNK_SIZE
                if idx >= len(blocks):
                    break
                bid = blocks[idx]
                if bid != AIR_ID:
                    if top_found is None:
                        top_found = y
                    if len(layers) < MAX_LAYER_DEPTH:
                        layers.append((y, bid))
                elif top_found is not None:
                    break  # 一番上の塊が終わった(空気にぶつかった)ので打ち切り
            if top_found is not None:
                truncated = (top_found == CHUNK_SIZE - 1)
                surface[(x, z)] = (top_found, layers[0][1], truncated, layers)
    return surface


def load_id_to_root(path):
    m = {}
    with open(path, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            m[row['id']] = (row['root_name'], row['meta_suffix'])
    return m


def load_asset_lookup(path):
    m = {}
    with open(path, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            top = (row.get('final_top') or row.get('tex_top') or row.get('final_all')
                   or row.get('tex_all') or row.get('final_side') or row.get('tex_side')
                   or row.get('fuzzy_2') or row.get('fuzzy_3') or '')
            model = row.get('final_model') or row.get('model_file') or ''
            m[row['root_name']] = {'texture': top, 'model': model, 'asset_type': row.get('asset_type', '')}
    return m


def build_map(replay_path, id_to_root_path, asset_master_path, out_path):
    res = make_decoder(replay_path)
    result = build_map_from_decoded(res, id_to_root_path, asset_master_path, verbose=True)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"書き出し: {out_path}")


def build_map_from_decoded(res, id_to_root_path, asset_master_path, verbose=False):
    """既にmake_decoder()でデコード済みの res を受け取って、
    {palette, tiles} の辞書を返す(ファイルへの書き出しはしない)。
    Pyodide(ブラウザ内実行)から呼ぶ時など、ファイルI/Oを避けたい場合用。"""
    id_to_root = load_id_to_root(id_to_root_path)
    asset_lookup = load_asset_lookup(asset_master_path)

    cells = {}  # (worldX, worldZ) -> {y, blockId, assetIdx, meta, layers}

    # 同じ(root_name, texture, model, asset_type)の組み合わせを何十万回も
    # 文字列で繰り返すとJSONが肥大化するので、パレット化して番号で持たせる。
    palette_map = {}
    palette_list = []

    def palette_idx(block_id):
        root, _ = id_to_root.get(str(block_id), (None, None))
        asset = asset_lookup.get(root, {'texture': '', 'model': '', 'asset_type': ''}) if root else {'texture': '', 'model': '', 'asset_type': ''}
        key = (root, asset['texture'], asset['model'], asset['asset_type'])
        if key not in palette_map:
            palette_map[key] = len(palette_list)
            palette_list.append({'root_name': root, 'texture': asset['texture'], 'model': asset['model'], 'asset_type': asset['asset_type']})
        return palette_map[key]

    def make_cell(wx, wz, y, block_id, uncertain=False, layers=None):
        # パレット変換は最後にまとめて行うので、ここでは生のblockIdのまま持たせる。
        # (eP編集が既存のlayersに追記していく時に、パレット番号ではなく
        #  生のblockIdの方が扱いやすいため)
        return {'x': wx, 'y': y, 'z': wz, 'blockId': block_id,
                '_uncertain': uncertain, '_layers': list(layers) if layers else [(y, block_id)]}

    def apply_terrain_block(wx, wz, y, block_id, uncertain=False, world_layers=None):
        # 縦方向にもチャンクが複数積み重なっているので、
        # 既に記録されているものより「高い(y座標が大きい)」場合だけ上書きする。
        # そうしないと地下チャンクが後から処理された時に地表を踏み潰してしまう。
        #
        # PREFER_CERTAIN_OVER_HEIGHT=True の場合、「確実」なデータは高さに
        # 関係なく「不確実」なデータより常に優先する。そうしないと、たまたま
        # 高い位置に来た不確実な(chunkY境界で打ち切られた)読み取りが、
        # 信頼できる確実な地表データを上書きして消してしまうことがある。
        existing = cells.get((wx, wz))
        if existing is not None:
            if PREFER_CERTAIN_OVER_HEIGHT:
                if not existing['_uncertain'] and uncertain:
                    return  # 確実なデータを不確実なデータで上書きしない
                if existing['_uncertain'] == uncertain and existing['y'] >= y:
                    return  # 同じ確実さ同士なら、高い方を採用
            else:
                if existing['y'] >= y:
                    return  # 確実さを無視して、単純に高さだけで比較(旧挙動)
        cells[(wx, wz)] = make_cell(wx, wz, y, block_id, uncertain, world_layers or [])

    def apply_edit_block(wx, wz, y, block_id):
        # eP(実際のブロック変更イベント)は「確実」なデータ。
        #
        # 重要: たとえこの高さが列の中で一番高くなくても、情報を捨てずに
        # 既存のlayersにこの高さの記録を追加/更新する。以前は「一番高い
        # ものを更新できなければ何もしない」という実装だったため、
        # (地上の建築より高い場所に無関係な建物がある場合など)途中の
        # 高さに手作業で置いたブロックが、勝てないという理由だけで
        # 丸ごとデータから消えてしまうバグがあった。
        #
        # block_id が Air(0)の場合は「ブロックを壊した」ことを意味するので、
        # 実体として追加するのではなく、その高さの記録を削除する。
        # (これを実体扱いすると、見た目の無い"空気ブロック"がテクスチャ不明の
        # 黒いキューブとして描画されてしまう)
        existing = cells.get((wx, wz))
        if block_id == AIR_ID:
            if existing is None:
                return
            new_layers = [(ly, lb) for ly, lb in existing['_layers'] if ly != y]
            if not new_layers:
                del cells[(wx, wz)]
                return
            top_y, top_bid = new_layers[0]
            cells[(wx, wz)] = {'x': wx, 'y': top_y, 'z': wz, 'blockId': top_bid,
                                '_uncertain': False, '_layers': new_layers}
            return
        if existing is None:
            cells[(wx, wz)] = make_cell(wx, wz, y, block_id, uncertain=False, layers=[(y, block_id)])
            return
        new_layers = [(ly, lb) for ly, lb in existing['_layers'] if ly != y]
        new_layers.append((y, block_id))
        new_layers.sort(key=lambda p: -p[0])
        top_y, top_bid = new_layers[0]
        cells[(wx, wz)] = {'x': wx, 'y': top_y, 'z': wz, 'blockId': top_bid,
                            '_uncertain': False, '_layers': new_layers}

    # 1. 地形本体 (chunkAdded / chunkRemoved の rle)
    #    縦に離れた場所に複数の建造物がある場合(例: 地上の建築+はるか上空の
    #    ロビー)に対応するため、(chunkX,chunkZ)ごとに読み込まれてる全chunkYを
    #    まとめて洗い出し、各列で「今分かってる全てのブロック」を上から下まで
    #    1回で集める。「一番上のものだけ」ではなく、間に空気の空白があっても
    #    構わず全部集めるのがポイント(そうしないと、たまたま上空にある
    #    無関係な建物が、地上の建築物より高いというだけで地上の建物を
    #    隠してしまう)。
    chunk_events = {}
    for t in res['ticks']:
        for e in t['structuralEvents']:
            if e['type'] == 'chunkAdded':
                chunk_events[(e['chunkX'], e['chunkY'], e['chunkZ'])] = e

    decoded_cache = {}
    def get_blocks(key):
        if key not in decoded_cache:
            decoded_cache[key] = decode_rle(chunk_events[key]['rle'])
        return decoded_cache[key]

    MAX_TOTAL_LAYER_DEPTH = 400  # 1列あたり保持するブロック数の上限

    columns_by_chunk = {}
    for (cx, cy, cz) in chunk_events:
        columns_by_chunk.setdefault((cx, cz), []).append(cy)

    n_chunks = len(chunk_events)
    for (cx, cz), cys in columns_by_chunk.items():
        cys_sorted = sorted(cys, reverse=True)  # 高い方から順に
        top_cy = cys_sorted[0]
        for lx in range(CHUNK_SIZE):
            for lz in range(CHUNK_SIZE):
                all_blocks = []  # (worldY, blockId)、上から順
                for cy in cys_sorted:
                    blocks = get_blocks((cx, cy, cz))
                    for y in range(CHUNK_SIZE - 1, -1, -1):
                        idx = lz + y * CHUNK_SIZE + lx * CHUNK_SIZE * CHUNK_SIZE
                        bid = blocks[idx]
                        if bid != AIR_ID:
                            all_blocks.append((cy * CHUNK_SIZE + y, bid))
                            if len(all_blocks) >= MAX_TOTAL_LAYER_DEPTH:
                                break
                    if len(all_blocks) >= MAX_TOTAL_LAYER_DEPTH:
                        break
                if not all_blocks:
                    continue
                top_y, top_bid = all_blocks[0]
                # truncated: 読み込まれてる中で一番高いチャンクの、さらに最上段
                # (ローカルy=31)で見つかった場合、その上にまだ地形がある
                # かもしれないが録画されていない、という意味。
                truncated = (top_y - top_cy * CHUNK_SIZE == CHUNK_SIZE - 1)
                wx = cx * CHUNK_SIZE + lx
                wz = cz * CHUNK_SIZE + lz
                apply_terrain_block(wx, wz, top_y, top_bid, uncertain=truncated, world_layers=all_blocks)

    # 2. 実際のブロック変更イベント (eP) で上書き (地形より後の変更を優先)
    n_edits = 0
    for t in res['ticks']:
        for e in t['structuralEvents']:
            if e['type'] != 'eP':
                continue
            x, y, z = e['pos']
            apply_edit_block(x, z, y, e['toBlockId'])
            n_edits += 1

    all_cells = list(cells.values())
    n_uncertain = sum(1 for c in all_cells if c['_uncertain'])
    tiles = []
    for c in all_cells:
        tiles.append({
            'x': c['x'], 'y': c['y'], 'z': c['z'],
            'assetIdx': palette_idx(c['blockId']),
            'uncertain': c['_uncertain'],
            'layers': [[wy, palette_idx(lbid)] for wy, lbid in c['_layers']],
        })

    if verbose:
        print(f"読み込んだチャンク数: {n_chunks}")
        print(f"eP(手動編集)による上書き: {n_edits}")
        print(f"不確実(データ不足)扱い: {n_uncertain}")
        print(f"タイル数: {len(tiles)} (うち確実: {len(tiles)-n_uncertain}件)")
        print(f"パレット(ユニークな見た目)数: {len(palette_list)}")

    return {'palette': palette_list, 'tiles': tiles}


if __name__ == '__main__':
    if len(sys.argv) < 5:
        print("使い方: python3 build_2d_map.py <replay.bloxdreplay> <block_id_to_root.csv> <asset_master.csv> <output.json>")
        sys.exit(1)
    build_map(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
