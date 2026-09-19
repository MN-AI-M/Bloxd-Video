"""
web_glue.py
===========
Pyodide(ブラウザ内Python)から呼び出すための「つなぎ役」。
JS側は process_replay_bytes(バイト列) を1回呼ぶだけで、
{ mesh: {...}, timelines: {...} } のJSON文字列を受け取れる。

v3: 地形の受け渡しを「列ごとの高さマップ」から「ボクセルの面カリング
    メッシュ」に変更した(build_2d_map.build_voxel_mesh_from_decoded)。
    縦に離れた複数の構造物も正しく表現でき、装飾ノイズ除去の閾値調整も
    不要になった。

v5: 自由カメラモード用に、デコード済みのres(重い処理:Avro/RLEデコード)を
    キャッシュしておき、rebuild_mesh_near()でカメラ位置を中心にした
    メッシュだけを軽く作り直せるようにした。

v6: rebuild_mesh_near()を、チャンク単位キャッシュ版(build_voxel_mesh_
    near_camera)に切り替えた。カメラが動くたびに読み込み済みの全チャンクを
    スキャンし直していたのをやめ、「近く/遠くの分類が変わったチャンクだけ」
    実際に計算するようにした(一度計算した場所に戻ってくれば、計算し直さず
    キャッシュがそのまま使われる)。

v7: 自由カメラを常にフル解像度(LOD無し)にすることにしたので、
    build_full_res_mesh()を追加。カメラが動いてもnear/farの分類自体が
    変わらないため、rebuild_mesh_nearの呼び出しがそもそも不要になった
    (アイソメ表示側は引き続きLODありのまま、影響しない)。

v8: アイソメ表示側(メインの読み込みフロー)も、全部読み終わるまで
    何も見せないのをやめて、ストリーミング処理(StreamingMeshProcessor)に
    切り替えた。少しずつtickを処理しては、その時点で新しく分かった地形の面・
    タイムラインのフレームだけを返す(YouTubeの動画処理のように、できた分
    から見せる方式)。これに伴い、LODも自由カメラ側と同じく無効化した
    (LODの基準=プレイヤーの通った場所は全体を見ないと決まらず、
    ストリーミングと相性が悪いため)。
    start_streaming_replay()で開始し、process_next_streaming_batch()を
    doneになるまで繰り返し呼ぶ。process_replay_bytes()(一括処理版)は
    今は使ってないが、参考用に残してある。

今まで作った build_2d_map.py / build_all_timelines.py の処理を、
ファイルへの書き込み無し(全部メモリ上)で呼べるようにまとめてある。
"""
import io
import json

from bloxdreplay_decode_full import make_decoder
from build_2d_map import build_voxel_mesh_from_decoded, build_voxel_mesh_near_camera, StreamingMeshProcessor
from build_all_timelines import build_all_timelines_from_decoded

BLOCK_ID_TO_ROOT_PATH = "block_id_to_root.csv"
ASSET_MASTER_PATH = "asset_master.csv"

_cached_res = None    # 一度デコードしたresを覚えておく(再デコード回避用。rebuild_mesh_near/build_full_res_meshが使う)
_chunk_cache = {}     # チャンクのデコード結果・自由カメラLODの計算結果をセッション全体で使い回すキャッシュ
_fullres_chunk_cache = {}  # 自由カメラのフル解像度メッシュ専用のキャッシュ(_chunk_cacheとは別物)
_streaming_processor = None  # StreamingMeshProcessorのインスタンス(start_streaming_replay()で作る)


def start_streaming_replay(data: bytes) -> None:
    """.bloxdreplayの中身(バイト列)を受け取って、ストリーミング処理を
    開始する(まだ何もtickは処理しない)。この後、process_next_streaming_
    batch()をdoneになるまで繰り返し呼ぶ。"""
    global _cached_res, _chunk_cache, _fullres_chunk_cache, _streaming_processor
    res = make_decoder_from_bytes(data)
    _cached_res = res  # rebuild_mesh_near()/build_full_res_mesh()用に覚えておく
    _chunk_cache = {}  # 新しいファイルを読み込んだので、キャッシュは作り直す
    _fullres_chunk_cache = {}
    _streaming_processor = StreamingMeshProcessor(res, BLOCK_ID_TO_ROOT_PATH, ASSET_MASTER_PATH)


def process_next_streaming_batch(batch_ticks: int = 500) -> str:
    """ストリーミング処理の続きをbatch_ticksぶんだけ進めて、今回新しく
    分かった地形の面・タイムラインのフレームなどをJSON文字列で返す。
    戻り値の中の'done'がtrueになるまで繰り返し呼ぶ想定。"""
    if _streaming_processor is None:
        raise RuntimeError("start_streaming_replayが先に呼ばれてないため、process_next_streaming_batchは使えません")
    result = _streaming_processor.process_batch(batch_ticks=batch_ticks)
    return json.dumps(result, ensure_ascii=False)


def process_replay_bytes(data: bytes) -> str:
    """.bloxdreplayの中身(バイト列)を受け取って、
    { mesh: {...}, timelines: {...} } のJSON文字列を返す。

    ※ 一括処理版。現在のメインの読み込みフローはstart_streaming_replay()に
    切り替えたので、こちらは今は使われていないが、参考用に残してある。"""
    global _cached_res, _chunk_cache, _fullres_chunk_cache
    res = make_decoder_from_bytes(data)
    _cached_res = res  # rebuild_mesh_near()用に覚えておく
    _chunk_cache = {}  # 新しいファイルを読み込んだので、キャッシュは作り直す
    _fullres_chunk_cache = {}
    mesh_data = build_voxel_mesh_from_decoded(
        res, BLOCK_ID_TO_ROOT_PATH, ASSET_MASTER_PATH, verbose=True, chunk_cache=_chunk_cache
    )
    timelines_data = build_all_timelines_from_decoded(res)
    return json.dumps({"mesh": mesh_data, "timelines": timelines_data}, ensure_ascii=False)


def rebuild_mesh_near(x: float, z: float) -> str:
    """自由カメラモード用。process_replay_bytes()で既にデコード済みのres
    (重いAvro/RLEデコードはやり直さない)を使って、(x,z)を中心にした
    LODでメッシュだけを再計算し、{ mesh: {...} } のJSON文字列を返す。
    カメラがおおよそ1チャンク分動くたびにJS側から呼ぶ想定。

    チャンク単位キャッシュ(_chunk_cache)を使い回すので、一度でも「近く」
    「遠く」どちらかとして計算したことのあるチャンクは、計算し直さずに
    そのまま使われる(=同じ場所を行き来しても軽い)。

    ※ 現在、自由カメラ側はLOD無し(build_full_res_mesh)に切り替えたため、
    この関数はもう自由カメラからは呼ばれていない。将来また距離に応じた
    軽量化をしたくなった時のために残してある。"""
    if _cached_res is None:
        raise RuntimeError("process_replay_bytesが先に呼ばれてないため、rebuild_mesh_nearは使えません")
    mesh_data = build_voxel_mesh_near_camera(
        _cached_res, BLOCK_ID_TO_ROOT_PATH, ASSET_MASTER_PATH,
        near_center=(x, z), cache=_chunk_cache, verbose=True
    )
    return json.dumps({"mesh": mesh_data}, ensure_ascii=False)


def build_full_res_mesh() -> str:

    global _fullres_chunk_cache
    if _cached_res is None:
        raise RuntimeError("process_replay_bytesが先に呼ばれてないため、build_full_res_meshは使えません")
    mesh_data = build_voxel_mesh_near_camera(
        _cached_res, BLOCK_ID_TO_ROOT_PATH, ASSET_MASTER_PATH,
        near_center=(0, 0), cache=_fullres_chunk_cache, verbose=True, near_radius=float('inf')
    )
    return json.dumps({"mesh": mesh_data}, ensure_ascii=False)


def make_decoder_from_bytes(data: bytes):
    """make_decoder() はファイルパスを受け取る作りなので、
    Pyodideの仮想ファイルシステム上に一時的に書き出してから呼ぶ。"""
    import os
    tmp_path = "/tmp/_input.bloxdreplay"
    os.makedirs("/tmp", exist_ok=True)
    with open(tmp_path, "wb") as f:
        f.write(bytes(data))
    return make_decoder(tmp_path)
