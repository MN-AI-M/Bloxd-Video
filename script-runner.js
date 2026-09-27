// script-runner.js
// ============================================================
// カメラスクリプト(生成型)の実行環境。
//
// ユーザーが書いた(または他の人から受け取った)JavaScriptを、ページから
// 切り離された場所で動かし、「カメラを足す・直す・消す」などの“操作の一覧”
// だけを受け取って、エディタに反映する(Ctrl+Z 1回で全部元に戻せる)。
//
// 隔離のしかた:
//   ページ ─ <iframe sandbox="allow-scripts">(別オリジン扱い・通信禁止のCSP)
//            └ Web Worker(ここでスクリプトを実行)
//   - スクリプトからは、このページの中身・保存データ・ネットワークに一切触れない
//   - 無限ループしても画面は固まらない。時間切れになったら iframe ごと捨てる
//   - 受け取った操作は、ページ側で全部チェックしてから反映する
//
// スクリプトに渡す材料(スナップショット)は実行のたびに作る:
//   プレイヤー全員の動き(全tick)、地形のブロック、今のカメラ・テキスト、再生ヘッドなど。
// 座標は Bloxd のワールド座標(画面左上に出ているのと同じ)、角度は「度」。
// ============================================================

const SCRIPT_TIMEOUT_MS = 15000;          // 実行の制限時間
const SCRIPT_DESCRIBE_TIMEOUT_MS = 4000;  // 設定項目を調べるだけの時の制限時間
const SCRIPT_MAX_OPS = 20000;
const SCRIPT_MAX_KEYS = 5000;


// ============================================================
// Worker の中で動くコード(この関数の中身だけが文字列として Worker に渡る。
// 外側の変数は一切使えないので、必要な計算はこの中に全部書いてある)
// ============================================================

function __cameraScriptWorkerMain() {
  const DEG = Math.PI / 180;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const STOP_DESCRIBE = { __stopDescribe: true };

  const CURVES = {
    linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3], smooth: [0.42, 0, 0.58, 1],
    easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1],
  };

  // ---------------- 数学 ----------------
  const vec = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 向き(度)→ 前向きのベクトル。yaw=0 が +Z、yaw=90 が +X
  function forward(yawDeg, pitchDeg) {
    const y = yawDeg * DEG, p = (pitchDeg || 0) * DEG;
    return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
  }
  function right(yawDeg) { const y = yawDeg * DEG; return [-Math.cos(y), 0, Math.sin(y)]; }
  function lookAt(from, to) {
    const d = vec.sub(to, from);
    return { yaw: Math.atan2(d[0], d[2]) / DEG, pitch: clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG, -88, 88) };
  }
  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeInOut(u) { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  // なめらかな揺れ(-1〜1)。t が 1 増えるごとに1回くらい揺れる
  function noise(t, seed) {
    const h = (i) => { const x = Math.sin((i + (seed || 0) * 131.7) * 127.1) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  }
  // 決まった順で出る乱数(seed が同じなら毎回同じ結果)
  function random(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // 速さのカーブ(エディタの scEase と同じ)
  function bez(p1, p2, t) { const u = 1 - t; return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t; }
  function ease(c, x) {
    if (!c) return x;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 40; i++) { const v = bez(c[0], c[2], t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return bez(c[1], c[3], t);
  }
  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  // カメラのキー(秒・度)から、ある秒数の姿勢を出す(エディタと同じ補間)
  function evalKeys(ks, time) {
    const cp = (k) => ({ pos: k.pos.slice(), yaw: k.yaw, pitch: k.pitch });
    if (ks.length === 1 || time <= ks[0].time) return cp(ks[0]);
    if (time >= ks[ks.length - 1].time) return cp(ks[ks.length - 1]);
    let i = 0;
    while (i < ks.length - 2 && time > ks[i + 1].time) i++;
    const a = ks[i], b = ks[i + 1];
    const t = ease(a.curve, clamp((time - a.time) / ((b.time - a.time) || 1), 0, 1));
    const P = (j) => ks[clamp(j, 0, ks.length - 1)].pos;
    const pos = [0, 1, 2].map(c => cr(P(i - 1)[c], P(i)[c], P(i + 1)[c], P(i + 2)[c], t));
    return { pos, yaw: a.yaw + angleDiff(a.yaw, b.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t };
  }

  // ---------------- 地形 ----------------
  let solid = null;   // "x,y,z" → 出現するtick
  let columns = null; // "x,z" → そこにあるブロックのy(昇順)
  function buildWorld(blocks) {
    solid = new Map(); columns = new Map();
    for (let i = 0; i < blocks.length; i += 4) {
      const x = blocks[i], y = blocks[i + 1], z = blocks[i + 2], r = blocks[i + 3];
      solid.set(x + ',' + y + ',' + z, r);
      const ck = x + ',' + z;
      let col = columns.get(ck);
      if (!col) { col = []; columns.set(ck, col); }
      col.push(y);
    }
    for (const col of columns.values()) col.sort((a, b) => a - b);
  }
  function isSolidBlock(bx, by, bz, tick) {
    const r = solid.get(bx + ',' + by + ',' + bz);
    if (r === undefined) return false;
    return tick == null || r <= tick;
  }
  // from → to の線分で最初にぶつかるブロック(3D DDA)
  function raycast(from, to, opts) {
    const tick = opts && opts.tick;
    const d = vec.sub(to, from);
    const maxDist = vec.len(d);
    if (maxDist < 1e-9) return null;
    const dir = vec.scale(d, 1 / maxDist);
    let x = Math.floor(from[0]), y = Math.floor(from[1]), z = Math.floor(from[2]);
    const step = dir.map(v => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tDelta = dir.map(v => (v !== 0 ? Math.abs(1 / v) : Infinity));
    const cell = [x, y, z];
    const tMax = [0, 1, 2].map(i => {
      if (dir[i] === 0) return Infinity;
      const edge = step[i] > 0 ? cell[i] + 1 : cell[i];
      return (edge - from[i]) / dir[i];
    });
    let t = 0, normal = [0, 0, 0];
    if (opts && opts.ignoreStart) { /* 出発点のブロックは見ない */ }
    else if (isSolidBlock(x, y, z, tick)) return { pos: from.slice(), block: [x, y, z], normal: [0, 0, 0], dist: 0 };
    for (let n = 0; n < 4096; n++) {
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      t = tMax[axis];
      if (t > maxDist) return null;
      if (axis === 0) x += step[0]; else if (axis === 1) y += step[1]; else z += step[2];
      tMax[axis] += tDelta[axis];
      normal = [0, 0, 0]; normal[axis] = -step[axis];
      if (isSolidBlock(x, y, z, tick)) return { pos: vec.add(from, vec.scale(dir, t)), block: [x, y, z], normal, dist: t };
    }
    return null;
  }
  // (x,z) の列で、fromY 以下にある一番上のブロックの上面の高さ(無ければ null)
  function groundY(x, z, fromY, tick) {
    const col = columns.get(Math.floor(x) + ',' + Math.floor(z));
    if (!col) return null;
    for (let i = col.length - 1; i >= 0; i--) {
      const y = col[i];
      if (fromY != null && y > fromY) continue;
      if (isSolidBlock(Math.floor(x), y, Math.floor(z), tick)) return y + 1;
    }
    return null;
  }

  // ---------------- 実行 ----------------
  self.onmessage = async (ev) => {
    const { mode, code, params, snapshot: S } = ev.data;
    const ops = [];
    const logs = [];
    let defs = null, info = null, newId = 0;
    const out = (type, extra) => postMessage(Object.assign({ type, ops, logs, defs, info }, extra || {}));
    const fail = (message) => { const e = new Error(message); e.__userFail = true; throw e; };
    const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })());
    const pushOp = (op) => { if (ops.length >= 20000) fail('操作が多すぎます(20000個まで)'); ops.push(op); };

    try {
      if (mode === 'run') buildWorld(S.blocks);

      // プレイヤー
      const entities = S.entities || [];
      const findEntity = (id) => entities.find(e => String(e.id) === String(id));
      function makePlayer(e) {
        const n = e.count;
        return {
          id: e.id, name: e.name, isMe: e.isMe, ticks: n,
          at(tick) {
            if (!n) return null;
            const i = clamp(Math.round(tick), 0, n - 1);
            const pos = [e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]];
            return {
              tick: i, pos, head: [pos[0], pos[1] + 1.5, pos[2]],
              yaw: e.rot[i * 2 + 1] / DEG, pitch: e.rot[i * 2] / DEG,
              pose: e.pose[i], held: e.held[i], jumping: !!e.jump[i], crouching: !!e.crouch[i],
            };
          },
        };
      }
      const cams = (S.cameras || []).map(c => Object.assign({}, c, { poseAt(tick) { return evalKeys(c.keys, (tick - c.start) / S.tps); } }));

      const api = {
        version: 1,
        tps: S.tps, totalTicks: S.totalTicks, playhead: S.playhead,
        toTick: (sec) => sec * S.tps, toSec: (tick) => tick / S.tps,
        view: S.view,
        info(o) { info = { name: o && o.name ? String(o.name) : null, description: o && o.description ? String(o.description) : null }; },
        params(d) {
          defs = d || {};
          if (mode === 'describe') throw STOP_DESCRIBE;
          const v = {};
          for (const k of Object.keys(defs)) v[k] = (params && k in params) ? params[k] : defs[k].default;
          return v;
        },
        players: () => entities.map(e => ({ id: e.id, name: e.name, isMe: e.isMe })),
        player(id) {
          const e = id == null ? (findEntity(S.focusId) || entities[0]) : findEntity(id);
          if (!e) fail(id == null ? 'プレイヤーの情報がありません' : `プレイヤー ${id} が見つかりません`);
          return makePlayer(e);
        },
        world: {
          isSolid: (x, y, z, tick) => isSolidBlock(Math.floor(x), Math.floor(y), Math.floor(z), tick),
          raycast, groundY,
        },
        math: { vec, clamp, lerp: (a, b, t) => a + (b - a) * t, forward, right, lookAt, angleDiff, smoothstep, easeInOut, noise, random, DEG },
        cameras: () => cams,
        camera: (id) => cams.find(c => String(c.id) === String(id)) || null,
        selectedCamera: () => cams.find(c => c.id === S.selectedCameraId) || null,
        texts: () => S.texts || [],
        addCamera(spec) { const id = 'new' + (++newId); pushOp({ op: 'addCamera', id, spec }); return id; },
        updateCamera(id, patch) { pushOp({ op: 'updateCamera', id, patch }); },
        removeCamera(id) { pushOp({ op: 'removeCamera', id }); },
        addText(spec) { pushOp({ op: 'addText', spec }); },
        select(id) { pushOp({ op: 'select', id }); },
        seek(tick) { pushOp({ op: 'seek', tick }); },
        log(...a) { if (logs.length < 500) logs.push(a.map(fmt).join(' ')); },
        toast(msg) { pushOp({ op: 'toast', text: String(msg) }); },
        progress(p) { postMessage({ type: 'progress', value: clamp(+p || 0, 0, 1) }); },
        fail,
        curves: CURVES,
        evalKeys,
      };
      const fn = new AsyncFunction('api', '"use strict";\n' + code);
      await fn(api);
      out('done');
    } catch (err) {
      if (err === STOP_DESCRIBE) { out('done'); return; }
      if (err && err.__userFail) { out('fail', { message: err.message }); return; }
      // 行番号(関数の頭の2行+"use strict"の1行ぶんずらす)
      let line = null;
      const m = err && err.stack && /<anonymous>:(\d+):(\d+)/.exec(err.stack);
      if (m) line = Math.max(1, parseInt(m[1], 10) - 3);
      out('error', { message: (err && err.message) || String(err), line });
    }
  };
}


// ============================================================
// 隔離した場所での実行
// ============================================================

const SANDBOX_HTML = `<!DOCTYPE html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">
<script>
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  try {
    const url = URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (m) => parent.postMessage(m.data, '*');
    w.onerror = (err) => { err.preventDefault(); parent.postMessage({ type: 'error', message: err.message || 'スクリプトの読み込みに失敗しました', line: null, ops: [], logs: [] }, '*'); };
    w.postMessage(e.data.payload);
  } catch (err) {
    parent.postMessage({ type: 'error', message: 'スクリプトを動かす準備に失敗しました: ' + err, line: null, ops: [], logs: [] }, '*');
  }
});
parent.postMessage({ type: 'sandboxReady' }, '*');
<\/script>`;

const WORKER_SRC = `(${__cameraScriptWorkerMain.toString()})();`;

let _scriptRunSeq = 0;

// 戻り値: Promise<{ type:'done'|'fail'|'error'|'timeout', ops, logs, defs, info, message, line }>
function runScriptSandboxed(code, mode, params, onProgress) {
  const snapshot = buildScriptSnapshot(mode);
  const timeoutMs = mode === 'describe' ? SCRIPT_DESCRIBE_TIMEOUT_MS : SCRIPT_TIMEOUT_MS;
  const seq = ++_scriptRunSeq;
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = SANDBOX_HTML;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      frame.remove(); // Worker ごと止まる
      resolve(Object.assign({ ops: [], logs: [], defs: null, info: null }, result));
    };
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
      const d = e.data;
      if (d.type === 'sandboxReady') {
        frame.contentWindow.postMessage({ src: WORKER_SRC, payload: { mode, code, params, snapshot } }, '*');
      } else if (d.type === 'progress') {
        if (onProgress) onProgress(+d.value || 0);
      } else if (d.type === 'done' || d.type === 'fail' || d.type === 'error') {
        finish({
          type: d.type,
          ops: Array.isArray(d.ops) ? d.ops : [],
          logs: Array.isArray(d.logs) ? d.logs.map(String) : [],
          defs: d.defs && typeof d.defs === 'object' ? d.defs : null,
          info: d.info && typeof d.info === 'object' ? d.info : null,
          message: d.message != null ? String(d.message) : null,
          line: Number.isFinite(d.line) ? d.line : null,
        });
      }
    };
    const timer = setTimeout(() => finish({ type: 'timeout', message: `${timeoutMs / 1000}秒たっても終わらなかったので止めました(無限ループになっていませんか?)` }), timeoutMs);
    window.addEventListener('message', onMsg);
    document.body.appendChild(frame);
    void seq;
  });
}


// ============================================================
// スクリプトに渡す材料(スナップショット)
// ============================================================

let _scriptBlocksCache = { faces: null, len: -1, data: null };

// 地形: 面のデータから「ブロックがある場所」を取り出す([x,y,z,出現tick] の並び)
function _scriptWorldBlocks() {
  const faces = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces : [];
  const c = _scriptBlocksCache;
  if (c.faces === faces && c.len === faces.length && c.data) return c.data;
  const map = new Map();
  for (const f of faces) {
    const s = Math.max(1, Math.round(f[5] || 1));
    const r = f[6] || 0;
    for (let dx = 0; dx < s; dx++) for (let dz = 0; dz < s; dz++) {
      const k = (f[0] + dx) + ',' + f[1] + ',' + (f[2] + dz);
      const prev = map.get(k);
      if (prev === undefined || r < prev) map.set(k, r);
    }
  }
  const data = new Int32Array(map.size * 4);
  let i = 0;
  for (const [k, r] of map) {
    const [x, y, z] = k.split(',');
    data[i++] = +x; data[i++] = +y; data[i++] = +z; data[i++] = r;
  }
  _scriptBlocksCache = { faces, len: faces.length, data };
  return data;
}

function _scriptEntities() {
  if (typeof allTimelines === 'undefined' || !allTimelines) return [];
  const out = [];
  for (const [eid, ent] of Object.entries(allTimelines.entities)) {
    const fr = ent.frames || [];
    const n = fr.length;
    const pos = new Float64Array(n * 3), rot = new Float64Array(n * 2);
    const pose = new Array(n), held = new Array(n), jump = new Uint8Array(n), crouch = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = fr[i] || {};
      const p = f.position || [0, 0, 0], r = f.rotation || [0, 0];
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      rot[i * 2] = r[0] || 0; rot[i * 2 + 1] = r.length > 1 ? r[1] : 0;
      pose[i] = f.pose == null ? null : String(f.pose);
      held[i] = f.heldItemName == null ? null : String(f.heldItemName);
      jump[i] = f.jumping ? 1 : 0; crouch[i] = f.crouching ? 1 : 0;
    }
    out.push({ id: eid, name: ent.displayName || ent.name || ('ID ' + eid), isMe: eid === allTimelines.localPlayerEntityId,
               count: n, pos, rot, pose, held, jump, crouch });
  }
  return out;
}

const _r2d = (r) => r * 180 / Math.PI;

function _scriptCameras() {
  const o = [worldOriginX, worldOriginY, worldOriginZ];
  return sceneCameras.map(c => ({
    id: c.id, name: scCamName(c), start: c.startTick, end: c.endTick, layer: c.layer, fov: c.fov,
    display: c.display ? { ...c.display } : null,
    keys: c.keys.map(k => {
      const kk = { time: k.time, pos: [k.pos[0] + o[0], k.pos[1] + o[1], k.pos[2] + o[2]], yaw: _r2d(k.yaw), pitch: _r2d(k.pitch) };
      if (k.curve) kk.curve = k.curve.slice();
      return kk;
    }),
  }));
}

function buildScriptSnapshot(mode) {
  const focus = document.getElementById('entitySelect');
  const base = {
    tps: scTps(), totalTicks: scMaxTick() + 1, playhead: curTick,
    focusId: focus ? focus.value : null,
    selectedCameraId: (typeof selectedCameraId !== 'undefined') ? selectedCameraId : null,
    view: { pos: [fcPos[0] + worldOriginX, fcPos[1] + worldOriginY, fcPos[2] + worldOriginZ], yaw: _r2d(fcYaw), pitch: _r2d(fcPitch), fov: fcFovDeg },
  };
  if (mode === 'describe') return { ...base, entities: [], cameras: [], texts: [], blocks: new Int32Array(0) };
  return {
    ...base,
    entities: _scriptEntities(),
    cameras: _scriptCameras(),
    texts: (typeof textBlocks !== 'undefined' ? textBlocks : []).map(t => ({ id: t.id, content: t.content, start: t.startTick, end: t.endTick })),
    blocks: _scriptWorldBlocks(),
  };
}


// ============================================================
// 受け取った操作をチェックして反映する(取り消し1回ぶん)
// ============================================================

function _num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function _vec3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const a = [Number(v[0]), Number(v[1]), Number(v[2])];
  return a.every(Number.isFinite) ? a : null;
}

// スクリプトのキー(ワールド座標・度)→ エディタのキー(ローカル座標・ラジアン)
function _scriptKeyToEditor(k, i) {
  if (!k || typeof k !== 'object') throw new Error(`キー${i + 1}が正しくありません`);
  const pos = _vec3(k.pos);
  if (!pos) throw new Error(`キー${i + 1}の pos は [x, y, z] の数で指定してください`);
  let yaw = _num(k.yaw, null), pitch = _num(k.pitch, null);
  const target = _vec3(k.lookAt);
  if (target) {
    const d = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
    yaw = Math.atan2(d[0], d[2]) * 180 / Math.PI;
    pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI;
  }
  if (yaw == null) yaw = 0;
  if (pitch == null) pitch = 0;
  const out = {
    time: Math.max(0, _num(k.time, 0)),
    pos: [pos[0] - worldOriginX, pos[1] - worldOriginY, pos[2] - worldOriginZ],
    yaw: yaw * Math.PI / 180,
    pitch: Math.max(-88, Math.min(88, pitch)) * Math.PI / 180,
  };
  let c = k.curve;
  if (typeof c === 'string') c = CURVE_PRESETS[c] ? CURVE_PRESETS[c].c : null;
  if (Array.isArray(c) && c.length === 4 && c.every(v => Number.isFinite(Number(v)))) {
    const cc = c.map(Number);
    cc[0] = Math.max(0, Math.min(1, cc[0])); cc[2] = Math.max(0, Math.min(1, cc[2]));
    if (scCurvePresetId(cc) !== 'linear') out.curve = cc;
  }
  return out;
}

function _scriptKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('keys に1つ以上のキーを入れてください');
  if (keys.length > SCRIPT_MAX_KEYS) throw new Error(`キーが多すぎます(${SCRIPT_MAX_KEYS}個まで)`);
  const out = keys.map(_scriptKeyToEditor);
  out.sort((a, b) => a.time - b.time);
  return out;
}

function _scriptDisplay(d) {
  if (d == null) return null;
  if (typeof d !== 'object') return null;
  return scClampDisplay({ x: _num(d.x, 0), y: _num(d.y, 0), w: _num(d.w, 1) });
}

function _fitCamToKeys(cam) {
  const tps = scTps();
  const last = cam.keys[cam.keys.length - 1].time;
  const maxTick = scMaxTick();
  const need = Math.ceil(cam.startTick + last * tps) + (cam.keys.length > 1 ? 0 : 1);
  if (need > cam.endTick) cam.endTick = maxTick > 0 ? Math.min(maxTick, need) : need;
  if (cam.endTick <= cam.startTick) cam.endTick = cam.startTick + 1;
}

// 戻り値: { summary, error }
function applyScriptOps(ops) {
  if (!ops.length) return { summary: '変更はありませんでした' };
  if (ops.length > SCRIPT_MAX_OPS) return { error: '操作が多すぎます' };
  commitEdit();
  const before = _editorStateJson();
  const tps = scTps();
  const maxTick = scMaxTick();
  const idMap = new Map(); // スクリプト内のID → カメラ
  const count = { add: 0, update: 0, remove: 0, text: 0 };
  const toasts = [];
  let selectId = null, seekTick = null;
  const findCam = (id) => {
    if (idMap.has(String(id))) return idMap.get(String(id));
    return sceneCameras.find(c => String(c.id) === String(id)) || null;
  };
  try {
    ops.forEach((op, i) => {
      const where = `${i + 1}番目の操作(${op && op.op})`;
      try {
        if (!op || typeof op !== 'object') throw new Error('形が正しくありません');
        if (op.op === 'addCamera') {
          const s = op.spec || {};
          const keys = _scriptKeys(s.keys);
          const start = Math.max(0, Math.min(Math.max(0, maxTick - 1), Math.round(_num(s.start, curTick))));
          let end = s.end != null ? Math.round(_num(s.end, start + tps * DEFAULT_BLOCK_SECONDS))
            : Math.round(start + tps * Math.max(0.05, _num(s.seconds, Math.max(DEFAULT_BLOCK_SECONDS, keys[keys.length - 1].time))));
          if (maxTick > 0) end = Math.min(end, maxTick);
          const cam = scCreateCamera(keys[0], Math.max(10, Math.min(120, _num(s.fov, fcFovDeg))), start, 1);
          cam.keys = keys;
          cam.endTick = Math.max(start + 1, end);
          if (s.name != null) cam.name = String(s.name).slice(0, 60);
          cam.display = _scriptDisplay(s.display);
          cam.layer = scFindFreeLayerFrom(Math.max(0, Math.round(_num(s.layer, 0))), cam.startTick, cam.endTick, cam.id);
          idMap.set(String(op.id), cam);
          count.add++;
        } else if (op.op === 'updateCamera') {
          const cam = findCam(op.id);
          if (!cam) throw new Error(`カメラ ${op.id} が見つかりません`);
          const p = op.patch || {};
          if (p.keys !== undefined) { cam.keys = _scriptKeys(p.keys); }
          if (p.start !== undefined) {
            const ns = Math.max(0, Math.round(_num(p.start, cam.startTick)));
            const len = cam.endTick - cam.startTick;
            cam.startTick = ns;
            if (p.end === undefined) cam.endTick = ns + len;
          }
          if (p.end !== undefined) cam.endTick = Math.max(cam.startTick + 1, Math.round(_num(p.end, cam.endTick)));
          if (maxTick > 0) cam.endTick = Math.min(cam.endTick, maxTick);
          if (p.name !== undefined) cam.name = String(p.name).slice(0, 60);
          if (p.fov !== undefined) cam.fov = Math.max(10, Math.min(120, _num(p.fov, cam.fov)));
          if (p.display !== undefined) cam.display = _scriptDisplay(p.display);
          if (p.keys !== undefined && p.end === undefined) _fitCamToKeys(cam);
          if (p.layer !== undefined) cam.layer = Math.max(0, Math.round(_num(p.layer, cam.layer)));
          cam.layer = scFindFreeLayerFrom(cam.layer, cam.startTick, cam.endTick, cam.id);
          count.update++;
        } else if (op.op === 'removeCamera') {
          const cam = findCam(op.id);
          if (!cam) throw new Error(`カメラ ${op.id} が見つかりません`);
          sceneCameras = sceneCameras.filter(c => c !== cam);
          count.remove++;
        } else if (op.op === 'addText') {
          const s = op.spec || {};
          const props = {};
          for (const k of TEXT_STYLE_KEYS) if (s[k] !== undefined) props[k] = s[k];
          props.content = s.content != null ? String(s.content).slice(0, 500) : 'テキスト';
          if (s.x !== undefined) props.x = Math.max(0, Math.min(1, _num(s.x, 0.5)));
          if (s.y !== undefined) props.y = Math.max(0, Math.min(1, _num(s.y, 0.82)));
          if (s.seconds !== undefined) props.seconds = Math.max(0.05, _num(s.seconds, 2));
          const start = Math.round(_num(s.start, curTick));
          const b = ctAddTextBlock(start, props);
          if (s.end !== undefined) b.endTick = Math.max(b.startTick + 1, Math.min(maxTick || Infinity, Math.round(_num(s.end, b.endTick))));
          count.text++;
        } else if (op.op === 'select') {
          selectId = op.id;
        } else if (op.op === 'seek') {
          seekTick = _num(op.tick, null);
        } else if (op.op === 'toast') {
          toasts.push(String(op.text).slice(0, 200));
        } else {
          throw new Error('知らない操作です');
        }
      } catch (e) {
        throw new Error(`${where}: ${e.message}`);
      }
    });
  } catch (e) {
    _restoreEditorState(before); // 途中で失敗したら、何も反映しない
    return { error: e.message };
  }
  scCompactLayers();
  // 取り消し1回ぶんとして履歴に積む(実行前の状態を保存)
  if (_editorStateJson() !== before) _pushHistory(before);
  if (selectId != null) {
    const c = findCam(selectId);
    if (c) { selectedCameraId = c.id; selectedKeyIndex = 0; selectedKeyExplicit = false; if (typeof selectedTextBlockId !== 'undefined') selectedTextBlockId = null; }
  }
  if (!scGetSelected()) { selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false; }
  if (typeof pilot !== 'undefined' && pilot && !scGetCamera(pilot.camId)) exitPilot(true);
  if (seekTick != null) seekTo(seekTick);
  if (typeof previewIsMain !== 'undefined' && sceneCameras.length === 0) previewIsMain = false;
  editorChanged();
  const parts = [];
  if (count.add) parts.push(`カメラを${count.add}台追加`);
  if (count.update) parts.push(`${count.update}台を変更`);
  if (count.remove) parts.push(`${count.remove}台を削除`);
  if (count.text) parts.push(`テキストを${count.text}個追加`);
  return { summary: parts.length ? parts.join('・') + 'しました' : '変更はありませんでした', toasts };
}
