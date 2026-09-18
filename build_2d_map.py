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


# ============================================================
# v3: ボクセルメッシュ版(面カリング)
# ============================================================
#
# 上のbuild_map_from_decoded()は「列ごとに高さ1つ+断面用の色データ」に
# 圧縮する方式だった。これは普通の地形(起伏のある地面)には十分だが、
# 「縦に離れた複数の建造物が同じ列にある」ようなケースを正しく表現できず、
# 閾値で誤魔化す必要があった(装飾ノイズと本物の構造物の区別がつかないため)。
#
# 一般的なボクセルレンダラー(Minecraft系)がやっている方式に変更する:
# 各ブロックについて、6方向の隣が「空気(または未記録)」かどうかを見て、
# 空気に面している面だけを出力する(face culling)。
# 地中に埋まってるブロックは面が1枚も出ないので、自動的に無視される。
# 「かたまり」を検出する必要も、装飾ノイズ用の閾値も一切不要になる。

# 面ごとの4隅のオフセット(ブロックのローカル座標を(0,0,0)〜(1,1,1)の
# 単位立方体とみなした時の頂点)。JS側(renderer.js)で実際の頂点座標に展開する。
# 巻き順は気にしない(バックフェイスカリングを使っていないため)。
VOXEL_MESH_DIRS = [
    ('+x', 1, 0, 0), ('-x', -1, 0, 0),
    ('+y', 0, 1, 0), ('-y', 0, -1, 0),
    ('+z', 0, 0, 1), ('-z', 0, 0, -1),
]
VOXEL_MESH_DIR_CODE = {name: i for i, (name, *_r) in enumerate(VOXEL_MESH_DIRS)}

MAX_MESH_FACES = 1_500_000  # 頂点数が際限なく増えないための安全弁

# --- LOD(Level of Detail)設定 ---
# 録画中に記録された全エンティティの通った場所から水平距離LOD_NEAR_RADIUS
# 以内はフル解像度(1ブロック=1面カリング単位)で描画する。それより遠い場所は
# 面の数を大きく減らす(遠方でこの塊自体も面カリングするので、完全に
# 埋もれてる塊は今まで通り出力されない)。
#
# 統合するのは水平方向(X,Z)だけで、縦方向(Y)は統合しない(=1ブロックの
# 厚みのまま)。地表は「芝生の下に土」のように薄い層が積み重なってることが
# 多く、縦方向までまとめると代表色が誤って選ばれ(例: 遠くの地面がまだらに
# 土色になる)ため。
LOD_ENABLED = True
LOD_NEAR_RADIUS = 50
LOD_GRID_SIZE = 10          # 近傍判定用の粗いグリッドのマス目サイズ(近似判定でOK)
LOD_FACTOR_XZ = 2           # 水平方向(X,Z)だけをこの倍率でまとめる。Yは常に1(統合しない)
LOD_ENTITY_SAMPLE_STRIDE = 20  # 全tickのうち何tickおきにプレイヤー位置をサンプルするか


def _sample_entity_positions(res, stride):
    """全エンティティの位置(差分形式)を復元しつつ、間引いてサンプリングする。
    LODの近傍判定にしか使わないので、水平位置(x,z)だけ集めれば十分。"""
    positions = []
    state = {}  # entityId -> 現在のposition
    for tick_num, t in enumerate(res['ticks']):
        for entity_id, deltas in t.get('entities', {}).items():
            for d in deltas:
                if d['i'] == 2:  # 2 = position (build_all_timelines.pyのFIELD_NAMESと同じ規約)
                    state[entity_id] = d['v']
        if tick_num % stride == 0:
            for pos in state.values():
                if pos:
                    positions.append((pos[0], pos[2]))
    return positions


def _build_near_cells(positions, radius, grid_size):
    """サンプリングした(x,z)位置の集合から、そこから水平距離radius以内にある
    粗いグリッドのマス目の集合を作る。この集合に入ってないマス目が「遠方」。"""
    near_cells = set()
    r_cells = radius // grid_size + 1
    for (px, pz) in positions:
        gcx, gcz = int(px // grid_size), int(pz // grid_size)
        for dgx in range(-r_cells, r_cells + 1):
            for dgz in range(-r_cells, r_cells + 1):
                gx, gz = gcx + dgx, gcz + dgz
                cx, cz = gx * grid_size + grid_size / 2, gz * grid_size + grid_size / 2
                if (cx - px) ** 2 + (cz - pz) ** 2 <= radius * radius:
                    near_cells.add((gx, gz))
    return near_cells


def build_voxel_mesh_from_decoded(res, id_to_root_path, asset_master_path, verbose=False, near_center=None, chunk_cache=None):
    """既にmake_decoder()でデコード済みの res を受け取って、
    {palette, faces, bbox, truncated} の辞書を返す。

    near_center: Noneなら今まで通り「録画中の全エンティティの通った場所」を
        近傍判定の基準にする。(x, z)を渡すと、代わりにその座標を中心に
        近傍判定する(自由カメラモードで、カメラの現在位置を中心に
        LODを再計算する用)。

    chunk_cache: チャンクのデコード結果(32³ブロック配列)を呼び出しをまたいで
        使い回すための辞書。web_glue.py側で1回作って毎回同じものを渡すと、
        同じチャンクのRLEデコードが2回走らなくなる。Noneならこの呼び出し限りの
        使い捨てキャッシュになる(単体で使う分には今まで通り)。

    faces: [[x, y, z, dirCode, paletteIdx, scale, revealTick], ...]
        (x,y,z)はそのブロック(またはLODの塊)自体のワールド座標
        (単位立方体の(0,0,0)側の角)。dirCodeは0〜5(VOXEL_MESH_DIR_CODE参照)。
        scaleは1(フル解像度、1ブロック)か LOD_FACTOR_XZ(遠方の塊)。
        revealTickは、このブロックが実際に置かれた(=見えるようになった)tick番号。
        録画の再生位置がこのtickに達するまで、JS側でこの面を表示しないようにする
        (「撮影中に追加されたブロックが最初から描画されている」問題への対応)。
        実際の頂点展開(面の4隅の計算)はJS側(renderer.js)で行う。
    bbox: [minX, maxX, minY, maxY, minZ, maxZ] (地形が1つも無ければ全て0)
    """
    id_to_root = load_id_to_root(id_to_root_path)
    asset_lookup = load_asset_lookup(asset_master_path)

    palette_map, palette_list = {}, []

    def palette_idx(block_id):
        root, _ = id_to_root.get(str(block_id), (None, None))
        asset = asset_lookup.get(root, {'texture': '', 'model': '', 'asset_type': ''}) if root else {'texture': '', 'model': '', 'asset_type': ''}
        key = (root, asset['texture'], asset['model'], asset['asset_type'])
        if key not in palette_map:
            palette_map[key] = len(palette_list)
            palette_list.append({'root_name': root, 'texture': asset['texture'], 'model': asset['model'], 'asset_type': asset['asset_type']})
        return palette_map[key]

    # 読み込まれてる全チャンク(chunkAdded)
    chunk_events = {}
    chunk_tick = {}   # (cx,cy,cz) -> 最初にchunkAddedされたtick番号(=このチャンクが最初に見えるようになった時刻)
    for tick_num, t in enumerate(res['ticks']):
        for e in t['structuralEvents']:
            if e['type'] == 'chunkAdded':
                key = (e['chunkX'], e['chunkY'], e['chunkZ'])
                chunk_events[key] = e
                if key not in chunk_tick:  # 再送されることがあるので、最初に見えた時刻を採用
                    chunk_tick[key] = tick_num

    decoded_cache = {} if chunk_cache is None else chunk_cache.setdefault('blocks', {})
    def get_chunk_blocks(key):
        if key not in decoded_cache:
            decoded_cache[key] = decode_rle(chunk_events[key]['rle']) if key in chunk_events else None
        return decoded_cache[key]

    # eP(実際のブロック変更イベント)。ワールド座標 -> blockId
    # (AIR_IDなら「壊された」という意味)。edit_tickは「そのブロックが今の状態に
    # なったtick」(同じ場所が複数回編集されてたら、最後の編集のtickを採用)。
    edits = {}
    edit_tick = {}
    for tick_num, t in enumerate(res['ticks']):
        for e in t['structuralEvents']:
            if e['type'] == 'eP':
                x, y, z = e['pos']
                edits[(x, y, z)] = e['toBlockId']
                edit_tick[(x, y, z)] = tick_num

    def get_block_slow(wx, wy, wz):
        """チャンク境界をまたぐ隣接ブロックの参照用(遅いパス)。
        None = 未記録(このチャンク自体が読み込まれていない) = 空気として扱う。"""
        key3 = (wx, wy, wz)
        if key3 in edits:
            return edits[key3]
        cx, lx = divmod(wx, CHUNK_SIZE)
        cy, ly = divmod(wy, CHUNK_SIZE)
        cz, lz = divmod(wz, CHUNK_SIZE)
        blocks = get_chunk_blocks((cx, cy, cz))
        if blocks is None:
            return None
        idx = lz + ly * CHUNK_SIZE + lx * CHUNK_SIZE * CHUNK_SIZE
        return blocks[idx]

    # --- LOD: 「近く」判定の準備 ---
    if near_center is not None:
        # 自由カメラモード: カメラの現在位置を中心にした単純な矩形判定
        # (エンティティ位置のサンプリングは不要なので、もっと軽い)
        ncx, ncz = near_center
        def is_near(wx, wz):
            return abs(wx - ncx) <= LOD_NEAR_RADIUS and abs(wz - ncz) <= LOD_NEAR_RADIUS
    elif LOD_ENABLED:
        positions = _sample_entity_positions(res, LOD_ENTITY_SAMPLE_STRIDE)
        near_cells = _build_near_cells(positions, LOD_NEAR_RADIUS, LOD_GRID_SIZE) if positions else None

        def is_near(wx, wz):
            if near_cells is None:
                return True  # LOD無効、またはエンティティ位置が取れなかった場合は常にフル解像度
            return (wx // LOD_GRID_SIZE, wz // LOD_GRID_SIZE) in near_cells
    else:
        def is_near(wx, wz):
            return True

    faces = []
    far_cells = {}  # (sx,sy,sz)スーパーセル座標 -> 代表のblockId(遠方=LOD用)
    minX = minY = minZ = None
    maxX = maxY = maxZ = None
    truncated = False

    def note_bounds(wx, wy, wz):
        nonlocal minX, maxX, minY, maxY, minZ, maxZ
        if minX is None or wx < minX: minX = wx
        if maxX is None or wx > maxX: maxX = wx
        if minY is None or wy < minY: minY = wy
        if maxY is None or wy > maxY: maxY = wy
        if minZ is None or wz < minZ: minZ = wz
        if maxZ is None or wz > maxZ: maxZ = wz

    def emit_faces_for(wx, wy, wz, bid, blocks_local, lx, ly, lz, reveal_tick):
        """このブロックの6方向を調べて、空気(または未記録)に面してる方向だけ
        facesに追加する(フル解像度)。可能な限り、同じチャンク内で完結する
        隣接は(divmodやチャンク検索を伴う)get_block_slowを使わず高速に判定する。"""
        aidx = palette_idx(bid)
        any_face = False
        for name, dx, dy, dz in VOXEL_MESH_DIRS:
            nlx, nly, nlz = lx + dx, ly + dy, lz + dz
            if 0 <= nlx < CHUNK_SIZE and 0 <= nly < CHUNK_SIZE and 0 <= nlz < CHUNK_SIZE:
                nwx, nwy, nwz = wx + dx, wy + dy, wz + dz
                if edits and (nwx, nwy, nwz) in edits:
                    nb = edits[(nwx, nwy, nwz)]
                else:
                    nidx = nlz + nly * CHUNK_SIZE + nlx * CHUNK_SIZE * CHUNK_SIZE
                    nb = blocks_local[nidx]
            else:
                nb = get_block_slow(wx + dx, wy + dy, wz + dz)
            if nb is None or nb == AIR_ID:
                faces.append((wx, wy, wz, VOXEL_MESH_DIR_CODE[name], aidx, 1, reveal_tick))
                any_face = True
        if any_face:
            note_bounds(wx, wy, wz)
        return len(faces) >= MAX_MESH_FACES

    def process_voxel(wx, wy, wz, bid, blocks_local, lx, ly, lz, chunk_key):
        """近く(フル解像度)か遠く(LOD)かを振り分ける。遠くはここでは
        スーパーセルに登録するだけで、面カリングは全部集め終わってからまとめて行う
        (隣のスーパーセルがまだ埋まってるかどうか、この時点では分からないため)。"""
        reveal_tick = edit_tick.get((wx, wy, wz), chunk_tick.get(chunk_key, 0))
        if not is_near(wx, wz):
            key = (wx // LOD_FACTOR_XZ, wy, wz // LOD_FACTOR_XZ)  # Yはまとめない(理由は上のLOD設定コメント参照)
            if key not in far_cells:
                far_cells[key] = (bid, reveal_tick)
            return False
        return emit_faces_for(wx, wy, wz, bid, blocks_local, lx, ly, lz, reveal_tick)

    # 1. 地形本体: 読み込まれてる全チャンクの全ブロックを振り分け
    for chunk_key in chunk_events:
        cx, cy, cz = chunk_key
        blocks = get_chunk_blocks(chunk_key)
        base_x, base_y, base_z = cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE
        for lx in range(CHUNK_SIZE):
            wx = base_x + lx
            for ly in range(CHUNK_SIZE):
                wy = base_y + ly
                row = lx * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE
                for lz in range(CHUNK_SIZE):
                    bid = blocks[row + lz]
                    if bid == AIR_ID:
                        continue
                    wz = base_z + lz
                    if (wx, wy, wz) in edits:
                        continue  # eP編集で上書き/削除済みなので、後段でまとめて処理する
                    if process_voxel(wx, wy, wz, bid, blocks, lx, ly, lz, chunk_key):
                        truncated = True
                        break
                if truncated: break
            if truncated: break
        if truncated: break

    # 2. eP編集(手動で置かれた/壊されたブロック)
    if not truncated:
        for (wx, wy, wz), bid in edits.items():
            if bid == AIR_ID:
                continue
            cx, lx = divmod(wx, CHUNK_SIZE)
            cy, ly = divmod(wy, CHUNK_SIZE)
            cz, lz = divmod(wz, CHUNK_SIZE)
            blocks = get_chunk_blocks((cx, cy, cz))
            if process_voxel(wx, wy, wz, bid, blocks, lx, ly, lz, (cx, cy, cz)):
                truncated = True
                break

    # 3. 遠方(LOD)のスーパーセルを、改めて面カリングする。
    #    (完全に他のスーパーセルに囲まれてる塊は、ここでもちゃんと出力されない)
    if not truncated:
        for (sx, sy, sz), (bid, reveal_tick) in far_cells.items():
            aidx = palette_idx(bid)
            any_face = False
            for name, dx, dy, dz in VOXEL_MESH_DIRS:
                if (sx + dx, sy + dy, sz + dz) in far_cells:
                    continue
                wx, wy, wz = sx * LOD_FACTOR_XZ, sy, sz * LOD_FACTOR_XZ
                faces.append((wx, wy, wz, VOXEL_MESH_DIR_CODE[name], aidx, LOD_FACTOR_XZ, reveal_tick))
                any_face = True
            if any_face:
                wx, wy, wz = sx * LOD_FACTOR_XZ, sy, sz * LOD_FACTOR_XZ
                note_bounds(wx, wy, wz)
                note_bounds(wx + LOD_FACTOR_XZ - 1, wy, wz + LOD_FACTOR_XZ - 1)
            if len(faces) >= MAX_MESH_FACES:
                truncated = True
                break

    bbox = [minX or 0, maxX or 0, minY or 0, maxY or 0, minZ or 0, maxZ or 0]

    if verbose:
        print(f"読み込んだチャンク数: {len(chunk_events)}")
        print(f"遠方(LOD)スーパーセル数: {len(far_cells)}")
        print(f"面(頂点用ポリゴン)数: {len(faces)}{'(上限到達により打ち切り)' if truncated else ''}")
        print(f"パレット(ユニークな見た目)数: {len(palette_list)}")

    return {'palette': palette_list, 'faces': faces, 'bbox': bbox, 'truncated': truncated}


# ============================================================
# 自由カメラのLOD再計算専用(チャンク単位キャッシュ版)
# ============================================================
#
# 自由カメラはカメラが約1チャンク動くたびにLODを再計算する(freecam.js参照)。
# 上のbuild_voxel_mesh_from_decoded()をそのまま毎回呼ぶと、近く/遠くの分類が
# 変わってないチャンクまで含めて、読み込み済みの全チャンクを毎回スキャンし
# 直すことになり無駄が大きい。
#
# この関数は、チャンクごとに「近くとして処理した場合の面」「遠くとして処理
# した場合のスーパーセルへの寄与」を別々にキャッシュしておき、呼び出しの
# たびに「このチャンクは今回どちらに分類されるか」だけ判定して、対応する
# キャッシュを使い回す。初めて見る(または初めてその分類になる)チャンクだけ
# 実際に計算される。
#
# 近く/遠くの判定は(build_voxel_mesh_from_decodedの既定パスと違って)
# チャンク単位で行う。境界の精度は多少甘くなる(最大チャンク1個ぶん)が、
# チャンクごとにキャッシュできるようになる方が実用上のメリットが大きい。
def build_voxel_mesh_near_camera(res, id_to_root_path, asset_master_path, near_center, cache, verbose=False):
    """cache: build_voxel_mesh_from_decoded()のchunk_cache引数と同じ辞書を
    そのまま渡す想定(web_glue.py側で1回だけ作って使い回す)。
    以下のキーを内部で使う(無ければ初回に作る):
      cache['blocks']      … チャンクのデコード済みブロック配列
      cache['near_faces']  … チャンクごとの「近く」処理結果(面のリスト)
      cache['far_cells']   … チャンクごとの「遠く」処理結果(スーパーセルへの寄与)
      cache['chunk_events'] / ['chunk_tick'] / ['edits'] / ['edit_tick']
      cache['palette_map'] / ['palette_list'] … パレットも使い回す(番号が
          呼び出しをまたいで安定するので、JS側の再構築コストも下がる)
    """
    id_to_root = load_id_to_root(id_to_root_path)
    asset_lookup = load_asset_lookup(asset_master_path)

    if 'palette_map' not in cache:
        cache['palette_map'], cache['palette_list'] = {}, []
    palette_map, palette_list = cache['palette_map'], cache['palette_list']

    def palette_idx(block_id):
        root, _ = id_to_root.get(str(block_id), (None, None))
        asset = asset_lookup.get(root, {'texture': '', 'model': '', 'asset_type': ''}) if root else {'texture': '', 'model': '', 'asset_type': ''}
        key = (root, asset['texture'], asset['model'], asset['asset_type'])
        if key not in palette_map:
            palette_map[key] = len(palette_list)
            palette_list.append({'root_name': root, 'texture': asset['texture'], 'model': asset['model'], 'asset_type': asset['asset_type']})
        return palette_map[key]

    if 'chunk_events' not in cache:
        chunk_events, chunk_tick = {}, {}
        for tick_num, t in enumerate(res['ticks']):
            for e in t['structuralEvents']:
                if e['type'] == 'chunkAdded':
                    key = (e['chunkX'], e['chunkY'], e['chunkZ'])
                    chunk_events[key] = e
                    if key not in chunk_tick:
                        chunk_tick[key] = tick_num
        edits, edit_tick = {}, {}
        for tick_num, t in enumerate(res['ticks']):
            for e in t['structuralEvents']:
                if e['type'] == 'eP':
                    x, y, z = e['pos']
                    edits[(x, y, z)] = e['toBlockId']
                    edit_tick[(x, y, z)] = tick_num
        cache['chunk_events'], cache['chunk_tick'] = chunk_events, chunk_tick
        cache['edits'], cache['edit_tick'] = edits, edit_tick
    chunk_events, chunk_tick = cache['chunk_events'], cache['chunk_tick']
    edits, edit_tick = cache['edits'], cache['edit_tick']

    blocks_cache = cache.setdefault('blocks', {})
    def get_chunk_blocks(key):
        if key not in blocks_cache:
            blocks_cache[key] = decode_rle(chunk_events[key]['rle']) if key in chunk_events else None
        return blocks_cache[key]

    def get_block_slow(wx, wy, wz):
        key3 = (wx, wy, wz)
        if key3 in edits:
            return edits[key3]
        cx, lx = divmod(wx, CHUNK_SIZE)
        cy, ly = divmod(wy, CHUNK_SIZE)
        cz, lz = divmod(wz, CHUNK_SIZE)
        blocks = get_chunk_blocks((cx, cy, cz))
        if blocks is None:
            return None
        idx = lz + ly * CHUNK_SIZE + lx * CHUNK_SIZE * CHUNK_SIZE
        return blocks[idx]

    # このチャンクに属するeP編集だけを毎回全件スキャンせずに済むよう、
    # 一度だけチャンクごとに振り分けておく
    if 'edits_by_chunk' not in cache:
        edits_by_chunk = {}
        for (wx, wy, wz) in edits:
            ck = (wx // CHUNK_SIZE, wy // CHUNK_SIZE, wz // CHUNK_SIZE)
            edits_by_chunk.setdefault(ck, []).append((wx, wy, wz))
        cache['edits_by_chunk'] = edits_by_chunk
    edits_by_chunk = cache['edits_by_chunk']

    def compute_near_faces(chunk_key):
        blocks = get_chunk_blocks(chunk_key)
        cx, cy, cz = chunk_key
        base_x, base_y, base_z = cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE
        out = []
        for lx in range(CHUNK_SIZE):
            wx = base_x + lx
            for ly in range(CHUNK_SIZE):
                wy = base_y + ly
                row = lx * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE
                for lz in range(CHUNK_SIZE):
                    bid = blocks[row + lz]
                    if bid == AIR_ID:
                        continue
                    wz = base_z + lz
                    if (wx, wy, wz) in edits:
                        continue
                    aidx = palette_idx(bid)
                    reveal_tick = chunk_tick.get(chunk_key, 0)
                    for name, dx, dy, dz in VOXEL_MESH_DIRS:
                        nlx, nly, nlz = lx + dx, ly + dy, lz + dz
                        if 0 <= nlx < CHUNK_SIZE and 0 <= nly < CHUNK_SIZE and 0 <= nlz < CHUNK_SIZE:
                            nwx, nwy, nwz = wx + dx, wy + dy, wz + dz
                            if edits and (nwx, nwy, nwz) in edits:
                                nb = edits[(nwx, nwy, nwz)]
                            else:
                                nidx = nlz + nly * CHUNK_SIZE + nlx * CHUNK_SIZE * CHUNK_SIZE
                                nb = blocks[nidx]
                        else:
                            nb = get_block_slow(wx + dx, wy + dy, wz + dz)
                        if nb is None or nb == AIR_ID:
                            out.append((wx, wy, wz, VOXEL_MESH_DIR_CODE[name], aidx, 1, reveal_tick))
        for (wx, wy, wz) in edits_by_chunk.get(chunk_key, []):
            bid = edits[(wx, wy, wz)]
            if bid == AIR_ID:
                continue
            aidx = palette_idx(bid)
            reveal_tick = edit_tick[(wx, wy, wz)]
            for name, dx, dy, dz in VOXEL_MESH_DIRS:
                nb = get_block_slow(wx + dx, wy + dy, wz + dz)
                if nb is None or nb == AIR_ID:
                    out.append((wx, wy, wz, VOXEL_MESH_DIR_CODE[name], aidx, 1, reveal_tick))
        return out

    def compute_far_cells(chunk_key):
        blocks = get_chunk_blocks(chunk_key)
        cx, cy, cz = chunk_key
        base_x, base_y, base_z = cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE
        contrib = {}
        reveal_tick = chunk_tick.get(chunk_key, 0)
        for lx in range(CHUNK_SIZE):
            wx = base_x + lx
            for ly in range(CHUNK_SIZE):
                wy = base_y + ly
                row = lx * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE
                for lz in range(CHUNK_SIZE):
                    bid = blocks[row + lz]
                    if bid == AIR_ID:
                        continue
                    wz = base_z + lz
                    if (wx, wy, wz) in edits:
                        continue
                    key = (wx // LOD_FACTOR_XZ, wy, wz // LOD_FACTOR_XZ)
                    if key not in contrib:
                        contrib[key] = (bid, reveal_tick)
        for (wx, wy, wz) in edits_by_chunk.get(chunk_key, []):
            bid = edits[(wx, wy, wz)]
            if bid == AIR_ID:
                continue
            key = (wx // LOD_FACTOR_XZ, wy, wz // LOD_FACTOR_XZ)
            contrib[key] = (bid, edit_tick[(wx, wy, wz)])
        return contrib

    ncx, ncz = near_center
    def chunk_is_near(chunk_key):
        cx, cy, cz = chunk_key
        base_x, base_z = cx * CHUNK_SIZE, cz * CHUNK_SIZE
        closest_x = min(max(ncx, base_x), base_x + CHUNK_SIZE - 1)
        closest_z = min(max(ncz, base_z), base_z + CHUNK_SIZE - 1)
        return abs(closest_x - ncx) <= LOD_NEAR_RADIUS and abs(closest_z - ncz) <= LOD_NEAR_RADIUS

    near_faces_cache = cache.setdefault('near_faces', {})
    far_cells_cache = cache.setdefault('far_cells', {})

    faces = []
    far_cells = {}
    truncated = False
    for chunk_key in chunk_events:
        if chunk_is_near(chunk_key):
            if chunk_key not in near_faces_cache:
                near_faces_cache[chunk_key] = compute_near_faces(chunk_key)
            faces.extend(near_faces_cache[chunk_key])
        else:
            if chunk_key not in far_cells_cache:
                far_cells_cache[chunk_key] = compute_far_cells(chunk_key)
            far_cells.update(far_cells_cache[chunk_key])
        if len(faces) >= MAX_MESH_FACES:
            truncated = True
            break

    if not truncated:
        for (sx, sy, sz), (bid, reveal_tick) in far_cells.items():
            aidx = palette_idx(bid)
            for name, dx, dy, dz in VOXEL_MESH_DIRS:
                if (sx + dx, sy + dy, sz + dz) in far_cells:
                    continue
                wx, wy, wz = sx * LOD_FACTOR_XZ, sy, sz * LOD_FACTOR_XZ
                faces.append((wx, wy, wz, VOXEL_MESH_DIR_CODE[name], aidx, LOD_FACTOR_XZ, reveal_tick))
            if len(faces) >= MAX_MESH_FACES:
                truncated = True
                break

    minX=minY=minZ=None; maxX=maxY=maxZ=None
    for f in faces:
        wx, wy, wz = f[0], f[1], f[2]
        if minX is None or wx < minX: minX = wx
        if maxX is None or wx > maxX: maxX = wx
        if minY is None or wy < minY: minY = wy
        if maxY is None or wy > maxY: maxY = wy
        if minZ is None or wz < minZ: minZ = wz
        if maxZ is None or wz > maxZ: maxZ = wz
    bbox = [minX or 0, maxX or 0, minY or 0, maxY or 0, minZ or 0, maxZ or 0]

    if verbose:
        print(f"[自由カメラ用再計算] near_center=({ncx},{ncz}) 面数={len(faces)} "
              f"(キャッシュ済みチャンク: 近く{len(near_faces_cache)}件・遠く{len(far_cells_cache)}件)")

    return {'palette': palette_list, 'faces': faces, 'bbox': bbox, 'truncated': truncated}


def build_voxel_mesh(replay_path, id_to_root_path, asset_master_path, out_path):
    res = make_decoder(replay_path)
    result = build_voxel_mesh_from_decoded(res, id_to_root_path, asset_master_path, verbose=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"書き出し: {out_path}")


if __name__ == '__main__':
    if len(sys.argv) < 5:
        print("使い方: python3 build_2d_map.py <replay.bloxdreplay> <block_id_to_root.csv> <asset_master.csv> <output.json>")
        sys.exit(1)
    build_map(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
