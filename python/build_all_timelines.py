"""
build_all_timelines.py
=======================
build_timeline.py を拡張し、指定した1体だけでなく、
録画に映ってる全エンティティ(全プレイヤー・全モブ・装飾メッシュ)の
時系列データを一括で取り出す。API化する時のバックエンド処理で使う。
"""
import sys
sys.path.insert(0, '.')
from bloxdreplay_decode_full import make_decoder

FIELD_NAMES = {
    0: 'name', 1: 'displayName', 2: 'position', 3: 'rotation',
    6: 'jumping', 7: 'crouching', 8: 'cameraPitch', 9: 'armSwinging',
    10: 'heldItemName', 12: 'pose', 20: 'cosmetics',
}


def build_all_timelines(replay_path):
    """戻り値:
    {
      'ticksPerSecond': int,
      'totalTicks': int,
      'durationSeconds': float,
      'localPlayerEntityId': str,
      'entities': {
        entityId: {
          'name': ...,            # そのエンティティの種類(例: "Player", "Draugr Zombie")
          'displayName': ...,     # プレイヤーの表示名(モブは空文字のことが多い)
          'frames': [ {tick, time, position, rotation, jumping, ...}, ... ]
        },
        ...
      }
    }
    """
    res = make_decoder(replay_path)
    return build_all_timelines_from_decoded(res)


def build_all_timelines_from_decoded(res):
    """既にmake_decoder()でデコード済みの res を受け取って、上と同じ辞書を返す。
    Pyodide(ブラウザ内実行)から呼ぶ時など、2重デコードを避けたい場合用。"""
    ticks_per_second = res['meta']['gG'] or 30
    total_ticks = len(res['ticks'])

    states = {}   # entityId -> 現在の状態(差分を積み重ねる)
    entities_out = {}

    for tick_num, t in enumerate(res['ticks']):
        for entity_id, deltas in t['entities'].items():
            state = states.setdefault(entity_id, {})
            for d in deltas:
                state[d['i']] = d['v']

            if entity_id not in entities_out:
                entities_out[entity_id] = {'name': None, 'displayName': None, 'frames': []}

            frame = {'tick': tick_num, 'time': round(tick_num / ticks_per_second, 3)}
            for i, name in FIELD_NAMES.items():
                if i in state:
                    frame[name] = state[i]
            entities_out[entity_id]['frames'].append(frame)
            entities_out[entity_id]['name'] = state.get(0)
            entities_out[entity_id]['displayName'] = state.get(1)

    return {
        'ticksPerSecond': ticks_per_second,
        'totalTicks': total_ticks,
        'durationSeconds': round(total_ticks / ticks_per_second, 2),
        'localPlayerEntityId': res['meta']['localPlayerEntityId'],
        'entities': entities_out,
    }


if __name__ == '__main__':
    import json
    if len(sys.argv) < 3:
        print("使い方: python3 build_all_timelines.py <replay.bloxdreplay> <output.json>")
        sys.exit(1)
    result = build_all_timelines(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f"エンティティ数: {len(result['entities'])}")
    print(f"tick数: {result['totalTicks']}  再生時間: {result['durationSeconds']}秒")
    print(f"書き出し: {sys.argv[2]}")
