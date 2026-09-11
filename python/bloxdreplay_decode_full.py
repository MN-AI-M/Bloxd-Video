import sys
sys.path.insert(0, '/home/claude')
from avro_reader import AvroReader
import json

def make_decoder(path):
    data = open(path, "rb").read()
    r = AvroReader(data)
    r.pos = 4

    result = {}
    meta = {}
    meta['formatVersion'] = r.read_int()
    meta['recordedAt'] = r.read_string()
    meta['gG'] = r.read_int()
    meta['keyframeIntervalTicks'] = r.read_int()
    meta['gameNameWithVariation'] = r.read_string()
    meta['lobbyName'] = r.read_string()
    meta['gameName'] = r.read_string()
    meta['variation'] = r.read_union([lambda: None, r.read_string])
    meta['lobbyType'] = r.read_int()
    meta['localPlayerEntityId'] = r.read_string()
    meta['serverPlayerEntityId'] = r.read_string()
    result['meta'] = meta

    fv = meta['formatVersion']
    includeBlockData = fv >= 7

    # initialChunks
    def read_initial_chunk():
        c = {}
        c['chunkPos'] = r.read_array(r.read_int)
        c['rle'] = r.read_bytes()
        if includeBlockData:
            c['sharedBlockData'] = r.read_string()
        return c
    result['initialChunks'] = r.read_array(read_initial_chunk)

    # entity delta value union (8 branches incl null)
    def read_armour_piece():
        return {'itemName': r.read_string(), 'enchantmentTier': r.read_union([lambda: None, r.read_string])}
    Bm_reader = lambda: r.read_map(read_armour_piece)
    wm_reader = lambda: r.read_array(r.read_double)

    vm_reader = lambda: r.read_map(wm_reader)  # map<string, array<double>> (乗り物の座席位置など)

    def read_other_entity_delta_entry():
        i = r.read_int()
        v = r.read_union([
            lambda: None,
            r.read_boolean,
            r.read_int,
            r.read_double,
            r.read_string,
            lambda: r.read_array(r.read_string),
            vm_reader,
        ])
        return {'i': i, 'v': v}
    dm_reader = lambda: r.read_array(read_other_entity_delta_entry)

    def read_entity_delta_entry():
        i = r.read_int()
        v = r.read_union([
            lambda: None,
            r.read_boolean,
            r.read_double,
            r.read_string,
            wm_reader,
            Bm_reader,
            dm_reader,
            lambda: r.read_map(r.read_string),
        ])
        return {'i': i, 'v': v}
    Am_reader = lambda: r.read_array(read_entity_delta_entry)

    def read_item_delta_entry():
        i = r.read_int()
        v = r.read_union([
            lambda: None,
            r.read_int,
            r.read_string,
            r.read_double,
            wm_reader,
        ])
        return {'i': i, 'v': v}
    pm_reader = lambda: r.read_array(read_item_delta_entry)

    camera_fields_v7 = ['position','direction','firstPerson','aiming','reloading','charging']
    def read_camera():
        cam = {}
        cam['position'] = wm_reader()
        cam['direction'] = wm_reader()
        cam['firstPerson'] = r.read_boolean()
        cam['aiming'] = r.read_boolean()
        cam['reloading'] = r.read_boolean()
        cam['charging'] = r.read_boolean()
        return cam

    def read_hotbar_slot():
        return {'name': r.read_string(), 'amount': r.read_union([lambda: None, r.read_int]), 'attributes': r.read_string()}
    Tm_reader = lambda: r.read_map(lambda: r.read_union([lambda: None, read_hotbar_slot]))

    def read_hotbar_delta_entry():
        i = r.read_int()
        v = r.read_union([lambda: None, r.read_int, Tm_reader])
        return {'i': i, 'v': v}

    def read_hotbar_field_delta():
        return {'fullSlotsArray': r.read_boolean(), 'entries': r.read_array(read_hotbar_delta_entry)}

    def read_player_hud_entry():
        i = r.read_int()
        v = r.read_union([lambda: None, r.read_int, r.read_double])
        return {'i': i, 'v': v}
    Lm_reader = lambda: r.read_array(read_player_hud_entry)

    def read_active_effect():
        e = {}
        e['Bt'] = r.read_string()
        e['name'] = r.read_string()
        e['icon'] = r.read_string()
        e['level'] = r.read_float()
        e['displayName'] = r.read_union([lambda: None, r.read_string])
        e['endTick'] = r.read_union([lambda: None, r.read_int])
        e['showInNametag'] = r.read_boolean()
        return e

    def read_ui_elements_entry():
        i = r.read_int()
        v = r.read_union([lambda: None, r.read_string])
        return {'i': i, 'v': v}
    ym_reader = lambda: r.read_array(read_ui_elements_entry)

    def read_env_entry():
        i = r.read_int()
        v = r.read_union([lambda: None, r.read_string, r.read_double, wm_reader])
        return {'i': i, 'v': v}
    Km_reader = lambda: r.read_array(read_env_entry)

    Jm_reader = lambda: r.read_array(r.read_int)

    def read_structural_event():
        name = r.read_string()  # union-of-records is encoded as index; but here it's a named-union so let's branch
        return name

    # structuralEvents is a UNION of named records (lm for v7). Avro named-union: index selects the record.
    def read_structural_event_v7():
        idx = r.read_long()
        if idx == 0:  # eP
            pos = Jm_reader()
            fromBlockId = r.read_int()
            toBlockId = r.read_int()
            fromBlockData = r.read_union([lambda: None, r.read_string])
            toBlockData = r.read_union([lambda: None, r.read_string])
            return {'type':'eP','pos':pos,'fromBlockId':fromBlockId,'toBlockId':toBlockId,'fromBlockData':fromBlockData,'toBlockData':toBlockData}
        elif idx == 1:  # setBlockData
            pos = Jm_reader()
            fromBlockData = r.read_union([lambda: None, r.read_string])
            toBlockData = r.read_union([lambda: None, r.read_string])
            return {'type':'setBlockData','pos':pos,'fromBlockData':fromBlockData,'toBlockData':toBlockData}
        elif idx == 2:  # chunkAdded
            chunkX=r.read_int(); chunkY=r.read_int(); chunkZ=r.read_int(); rle=r.read_bytes(); shared=r.read_string()
            return {'type':'chunkAdded','chunkX':chunkX,'chunkY':chunkY,'chunkZ':chunkZ,'rleLen':len(rle),'rle':rle,'sharedBlockData':shared}
        elif idx == 3:  # chunkRemoved
            chunkX=r.read_int(); chunkY=r.read_int(); chunkZ=r.read_int(); rle=r.read_bytes(); shared=r.read_string()
            return {'type':'chunkRemoved','chunkX':chunkX,'chunkY':chunkY,'chunkZ':chunkZ,'rleLen':len(rle),'rle':rle,'sharedBlockData':shared}
        else:
            raise ValueError(f"unknown structuralEvent idx {idx} @ {r.tell()}")

    def read_ephemeral_event():
        idx = r.read_long()
        if idx == 0:  # playSound
            name = r.read_string(); volume = r.read_double(); rate = r.read_double()
            def read_sound_pos():
                return {
                    'fi': r.read_union([lambda: None, r.read_string, wm_reader]),
                    'li': r.read_union([lambda: None, r.read_double]),
                    'Fi': r.read_union([lambda: None, r.read_double]),
                }
            pos = r.read_union([lambda: None, read_sound_pos])
            return {'type': 'playSound', 'name': name, 'volume': volume, 'rate': rate, 'pos': pos}
        elif idx == 1:  # animateEntity
            wt = r.read_string(); un = r.read_int()
            script = r.read_union([lambda: None, r.read_string])
            mn = r.read_double(); dn = r.read_double()
            return {'type': 'animateEntity', 'entityId': wt, 'un': un, 'script': script, 'mn': mn, 'dn': dn}
        elif idx == 2:  # bullet
            ha = r.read_string()
            dirs = r.read_array(wm_reader)
            return {'type': 'bullet', 'id': ha, 'directions': dirs}
        elif idx == 3:  # lifeformHealth
            bt = r.read_string()
            ba = r.read_union([lambda: None, r.read_double])
            va = r.read_union([lambda: None, r.read_double])
            return {'type': 'lifeformHealth', 'entityId': bt, 'a': ba, 'b': va}
        elif idx == 4:  # particleEffectPlayed
            opts = r.read_string()
            return {'type': 'particleEffectPlayed', 'opts': opts}
        elif idx == 5:  # flyingMiddleText
            content = r.read_string(); wmv = r.read_double(); angle = r.read_double(); jm = r.read_int()
            return {'type': 'flyingMiddleText', 'content': content, 'w': wmv, 'angle': angle, 'jm': jm}
        elif idx == 6:  # playerKilled
            dead = r.read_string(); killer = r.read_string(); item = r.read_string(); streak = r.read_int()
            return {'type': 'playerKilled', 'dead': dead, 'killer': killer, 'item': item, 'streak': streak}
        elif idx == 7:  # customKillfeed
            def read_party():
                return {
                    'eId': r.read_union([lambda: None, r.read_string]),
                    'name': r.read_union([lambda: None, r.read_string]),
                    'colour': r.read_union([lambda: None, r.read_string]),
                }
            killer = read_party(); victim = read_party(); item = r.read_string()
            return {'type': 'customKillfeed', 'killer': killer, 'victim': victim, 'item': item}
        else:
            raise ValueError(f"unknown ephemeralEvent idx {idx} @ {r.tell()}")

    def read_tick():
        t = {}
        t['entities'] = r.read_map(Am_reader)
        t['items'] = r.read_map(pm_reader)
        t['camera'] = read_camera()
        t['hotbar'] = r.read_union([lambda: None, read_hotbar_field_delta])
        t['playerHud'] = r.read_union([lambda: None, Lm_reader])
        t['effects'] = r.read_union([lambda: None, lambda: r.read_array(read_active_effect)])
        t['uiElements'] = ym_reader()
        t['environment'] = Km_reader()
        t['structuralEvents'] = r.read_array(read_structural_event_v7)
        return t

    ticks = []
    count_pos_before = r.tell()
    try:
        n_blocks_total = 0
        while True:
            count = r.read_long()
            if count == 0:
                break
            if count < 0:
                count = -count
                r.read_long()
            for _ in range(count):
                t = {}
                t['entities'] = r.read_map(Am_reader)
                t['items'] = r.read_map(pm_reader)
                t['camera'] = read_camera()
                t['hotbar'] = r.read_union([lambda: None, read_hotbar_field_delta])
                t['playerHud'] = r.read_union([lambda: None, Lm_reader])
                t['effects'] = r.read_union([lambda: None, lambda: r.read_array(read_active_effect)])
                t['uiElements'] = ym_reader()
                t['environment'] = Km_reader()
                t['structuralEvents'] = r.read_array(read_structural_event_v7)
                t['ephemeralEvents'] = r.read_array(read_ephemeral_event)
                ticks.append(t)
    except Exception as e:
        result['_error'] = f"{type(e).__name__}: {e} at byte {r.tell()}"
    result['ticks'] = ticks
    result['_bytes_consumed'] = r.tell()
    result['_total_bytes'] = len(data)
    return result

if __name__ == '__main__':
    res = make_decoder(sys.argv[1])
    def _bytes_safe(o):
        if isinstance(o, (bytes, bytearray)):
            return f"<{len(o)} bytes>"
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")
    print(json.dumps(res, indent=2, ensure_ascii=False, default=_bytes_safe)[:6000])
