// The 3D system twin. It draws whatever topology the latest graph snapshot event carries (services, CALLS edges,
// retries, capacity) and paints the event-derived view state onto it: the amplification path and the committed
// attack propagate hop by hop to their root failure, probes and locked decisions mark their targets, hardening
// sweeps the changed edges, and live WORLD ticks drive node load. Nothing moves unless the state says it changed;
// timing is anchored to the moment the corresponding event was presented.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* DISPLAY CONSTANTS — palette, layout spacing and motion timings. Not system-model data. */
const C = {
  core: 0x34405a, cool: 0x9db7e2, edge: 0x5a6b88, risk: 0xf2a33a, red: 0xff4a55, mint: 0x5fdcb2, blue: 0x5b9eff,
  green: 0x46c08a, grid: 0x23324b, fog: 0x0a0f17,
};
const LAYOUT = { DX: 10.5, DZ: 9.6 };
const NODE_R = [0.8, 1.32];
const STEP_MS = 620;                 // propagation: time for the signal to cross one hop
const SHOCK_MS = 900;                // a node's reaction when the signal reaches it
const FLASH_MS = 3000;               // a configuration change stays called out this long
const FRAME = { X: 0.78, NODE_PAD: 0.1, LABEL_PAD: 0.24 };
/* END DISPLAY CONSTANTS */

const pairs = (path) => (path ?? []).slice(1).map((b, k) => `${path[k]}>${b}`);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, color] of stops) grad.addColorStop(o, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// graphite body with a view-dependent rim light whose colour carries the node's state
function rimMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: C.core, metalness: 0.35, roughness: 0.46, envMapIntensity: 0.32 });
  const uniforms = { uRim: { value: new THREE.Color(C.cool) }, uRimStrength: { value: 0.6 } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = `uniform vec3 uRim;\nuniform float uRimStrength;\n${sh.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.2);
      totalEmissiveRadiance += uRim * rimF * uRimStrength;`)}`;
  };
  return m;
}

// layered layout from the CALLS graph: depth = longest call chain from an entry service
function computeLayout(graph) {
  const names = graph.services.map((s) => s.name).sort();
  const entries = new Set(graph.services.filter((s) => s.entry).map((s) => s.name));
  const depth = Object.fromEntries(names.map((n) => [n, entries.has(n) ? 0 : null]));
  for (let k = 0; k < names.length; k++) {
    for (const c of graph.calls) {
      if (depth[c.caller] === null) continue;
      const d = depth[c.caller] + 1;
      if (depth[c.callee] === null || d > depth[c.callee]) depth[c.callee] = Math.min(d, names.length);
    }
  }
  for (const n of names) if (depth[n] === null) depth[n] = 0;
  const maxD = Math.max(...Object.values(depth));
  const pos = {};
  for (let d = 0; d <= maxD; d++) {
    const layer = names.filter((n) => depth[n] === d);
    const bary = (n) => {
      const parents = graph.calls.filter((c) => c.callee === n && pos[c.caller]).map((c) => pos[c.caller].z);
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0;
    };
    layer.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    layer.forEach((n, i) => {
      pos[n] = new THREE.Vector3((d - maxD / 2) * LAYOUT.DX, 0.4 + (d % 2) * 1.1, (i - (layer.length - 1) / 2) * LAYOUT.DZ);
    });
  }
  return pos;
}

export function createGraphView(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels-layer';
  host.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.fog, 46, 150);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xc0d4ff, 0x06080c, 0.42));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(16, 34, 22); scene.add(key);
  const fill = new THREE.DirectionalLight(0x6f8dff, 0.5); fill.position.set(-26, 12, -18); scene.add(fill);

  // floor: perspective grid fading into fog, a soft pool of light under the system
  const grid = new THREE.GridHelper(220, 88, C.grid, C.grid);
  grid.material.transparent = true; grid.material.opacity = 0.42; grid.position.y = -2.8;
  scene.add(grid);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(46, 96), new THREE.MeshBasicMaterial({
    map: radialTexture([[0, 'rgba(90,120,175,0.30)'], [0.5, 'rgba(40,58,92,0.12)'], [1, 'rgba(10,15,23,0)']]), transparent: true, depthWrite: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = -2.78; scene.add(pool);
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 192), new THREE.MeshBasicMaterial({ color: C.mint, transparent: true, opacity: 0, depthWrite: false }));
  ripple.rotation.x = -Math.PI / 2; ripple.position.y = -2.7; scene.add(ripple);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 600);
  const rig = { target: new THREE.Vector3(), targetGoal: new THREE.Vector3(), r: 46, rGoal: 46, theta: -0.26, phi: 0.98,
    dragTheta: 0, dragPhi: 0, center: new THREE.Vector3(), yShift: 0, xShift: 0, zoom: 1 };

  const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.22, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
  const shadowTex = radialTexture([[0, 'rgba(0,0,0,0.7)'], [1, 'rgba(0,0,0,0)']]);
  const sphereGeo = new THREE.SphereGeometry(1, 64, 48);
  const nodes = new Map();
  const edges = new Map();
  const lineMaterials = new Set();
  let built = null;
  let state = null;
  let seqTime = () => 0;
  let insets = { top: 90, bottom: 40 };
  let lastRound = null, roundAt = 0, safeAt = 0;
  let minimal = false;                   // interactive judge mode: no floor grid, ripples, comets or halos

  function disposeAll() {
    // CSS2D elements are removed explicitly: removing a parent group does not detach its children's DOM nodes
    for (const v of nodes.values()) { scene.remove(v.group); scene.remove(v.floor); v.el.remove(); }
    for (const v of edges.values()) { scene.remove(v.line); scene.remove(v.arrow); scene.remove(v.chipObj); scene.remove(v.comet); v.chip.remove(); }
    nodes.clear(); edges.clear(); lineMaterials.clear();
  }

  // ---------------------------------------------------------------- build
  function build(graph) {
    disposeAll();
    const pos = computeLayout(graph);
    const caps = graph.services.map((s) => Math.log(s.cap_mean));
    const [lo, hi] = [Math.min(...caps), Math.max(...caps)];
    const born = performance.now();
    graph.services.forEach((svc, i) => {
      const group = new THREE.Group();
      group.position.copy(pos[svc.name]);
      const core = new THREE.Mesh(sphereGeo, rimMaterial());
      group.add(core);
      const band = new THREE.Mesh(new THREE.TorusGeometry(1.24, 0.05, 12, 160), new THREE.MeshBasicMaterial({ color: C.cool, transparent: true, opacity: 0 }));
      band.rotation.x = Math.PI / 2; group.add(band);
      const focal = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.035, 8, 180), new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0 }));
      focal.rotation.x = Math.PI / 2; group.add(focal);
      const shock = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 128), new THREE.MeshBasicMaterial({ color: C.risk, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      shock.rotation.x = -Math.PI / 2; group.add(shock);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: C.risk, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      group.add(halo);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6), new THREE.MeshBasicMaterial({ color: 0x8aa2c8, transparent: true, opacity: 0.22 }));
      group.add(stem);
      // floor marker: contact shadow + a ring on the grid carrying the node's state colour
      const floor = new THREE.Group();
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; floor.add(shadow);
      const mark = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 96), new THREE.MeshBasicMaterial({ color: C.cool, transparent: true, opacity: 0.12, depthWrite: false }));
      mark.rotation.x = -Math.PI / 2; mark.position.y = 0.01; floor.add(mark);
      floor.position.set(pos[svc.name].x, -2.77, pos[svc.name].z);
      scene.add(floor);
      const el = document.createElement('div');
      el.className = 'node-label';
      el.innerHTML = '<div class="nl-name"></div><div class="nl-sub"></div>';
      el.querySelector('.nl-name').textContent = svc.name;
      const label = new CSS2DObject(el);
      group.add(label);
      scene.add(group);
      nodes.set(svc.name, { group, core, band, focal, shock, halo, stem, floor, shadow, mark, label, el, home: pos[svc.name].clone(), lo, hi,
        born: born + i * 80, r: 0.01, rim: new THREE.Color(C.cool), bandColor: new THREE.Color(C.cool), emissive: new THREE.Color(0) });
    });
    graph.calls.forEach((c, i) => addEdge(c, pos, born + 350 + i * 60));
    const ps = Object.values(pos);
    rig.center.copy(ps.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / ps.length));
    rig.target.copy(rig.center);
  }

  function addEdge(c, pos, born) {
    const k = `${c.caller}>${c.callee}`;
    const a = pos[c.caller], b = pos[c.callee];
    if (!a || !b) return;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 1.4 + a.distanceTo(b) * 0.1;
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
    const geo = new LineGeometry();
    geo.setPositions(curve.getPoints(72).flatMap((p) => [p.x, p.y, p.z]));
    const mat = new LineMaterial({ color: C.edge, linewidth: 2, transparent: true, opacity: 0, worldUnits: false, depthWrite: false });
    lineMaterials.add(mat);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    scene.add(line);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.62, 16), new THREE.MeshBasicMaterial({ color: C.edge, transparent: true, opacity: 0 }));
    scene.add(arrow);
    const comet = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: C.risk, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    comet.scale.setScalar(1.5);
    scene.add(comet);
    const chip = document.createElement('div');
    chip.className = 'edge-chip empty';
    const chipObj = new CSS2DObject(chip);
    chipObj.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, 1.0, 0));
    scene.add(chipObj);
    edges.set(k, { key: k, curve, line, mat, arrow, comet, chip, chipObj, born, color: new THREE.Color(C.edge), width: 2, opacity: 0 });
  }

  // ---------------------------------------------------------------- state → per-frame targets
  function targets(now) {
    const s = state;
    const o = s.overlay;
    const nodeT = new Map(), edgeT = new Map();
    for (const [name, n] of Object.entries(s.nodes)) {
      nodeT.set(name, { rim: C.cool, rimS: 0.55, band: n.entry ? C.cool : null, bandO: n.entry ? 0.42 : 0, focal: null, focalO: 0, pulse: 0,
        emissive: 0x000000, emissiveI: 0, halo: null, haloO: 0, shockAt: null, shockColor: C.risk, mark: C.cool, markO: 0.05, sub: '', subCls: '' });
    }
    const retriesText = (n) => `${n} retr${n === 1 ? 'y' : 'ies'}`;
    for (const [k, e] of Object.entries(s.edges)) {
      edgeT.set(k, { color: C.edge, width: 1.8 + 0.85 * e.retries, opacity: 0.78, comet: null, chip: '', chipCls: '', retries: retriesText(e.retries), fast: false });
    }
    const paintNode = (n, f) => { const t = nodeT.get(n); if (t) f(t); };
    const paintEdge = (k, f) => { const t = edgeT.get(k); if (t) f(t); };

    // 1. live WORLD load (latest tick) — the realized state of the system
    const w = s.world;
    if (w.tick !== null && !s.result) {
      for (const [name, t] of nodeT) {
        const deg = w.degrade?.[name] ?? 1, q = w.queue?.[name] ?? 0;
        if (deg < 1) { t.emissive = C.red; t.emissiveI = 0.25 + 0.9 * (1 - deg); t.rim = C.red; t.rimS = 1.1; t.mark = C.red; t.markO = 0.35; }
        if (q > 0.5) { t.halo = C.risk; t.haloO = Math.min(0.5, 0.12 + q / 300); t.sub = `backlog ${Math.round(q)}`; t.subCls = 'risk'; }
      }
      for (const e of w.violatedEntries ?? []) paintNode(e, (t) => { t.band = C.red; t.bandO = 0.95; t.pulse = 1; t.sub = 'failing for users'; t.subCls = 'bad'; });
    }

    // 2. propagation along a path: the signal crosses hop by hop, each node reacts, the last node becomes the focus
    const propagate = (path, seq, color, { live = true, focus = [] } = {}) => {
      const hops = (now - seqTime(seq)) / STEP_MS;
      pairs(path).forEach((k, i) => paintEdge(k, (t) => {
        const lit = live ? clamp01(hops - i) : 1;
        if (lit <= 0) return;
        t.color = color; t.opacity = live ? 0.55 + 0.45 * lit : 0.5; t.width += live ? 2.2 * lit : 0.6; t.fast = true;
        if (live && lit < 1) t.comet = { u: lit, color };
        if (live) t.chip ||= t.retries;
        if (live) t.chipCls = color === C.red ? 'red' : 'risk';
      }));
      path.forEach((n, j) => paintNode(n, (t) => {
        if (live && hops < j) return;
        t.rim = color; t.rimS = live ? 1.05 : 0.7; t.band = color; t.bandO = live ? 0.85 : 0.35;
        if (live) { t.shockAt = seqTime(seq) + j * STEP_MS; t.shockColor = color; t.mark = color; t.markO = 0.32; }
      }));
      const end = [...focus, path.at(-1)];
      if (live && hops >= path.length - 1) for (const n of end) paintNode(n, (t) => { t.focal = color; t.focalO = 0.95; t.pulse = 1; t.emissive = color; t.emissiveI = Math.max(t.emissiveI, 0.32); t.rimS = 1.5; });
    };
    if (o.amp && !o.attack) propagate(o.amp.paths[0], o.amp.seq, C.risk);
    if (o.attack) {
      const live = !o.attack.resolved;
      if (o.attack.evidence?.length) propagate(o.attack.evidence, o.attack.seq, C.red, { live, focus: o.attack.services });
      for (const n of o.attack.services) paintNode(n, (t) => { t.rim = C.red; t.rimS = live ? 1.5 : 0.8; if (live) { t.focal = C.red; t.focalO = 0.95; t.pulse = 1; } });
      for (const k of o.attack.edges) paintEdge(k, (t) => { t.color = C.red; t.opacity = live ? 1 : 0.5; t.width += live ? 2.6 : 0.6; t.fast = true; });
    }

    // 3. configuration history: hardened / landed edges and scaled nodes persist across rounds
    for (const [k, e] of Object.entries(s.edges)) {
      const t = edgeT.get(k);
      const since = now - seqTime(e.changeSeq);
      if (e.change === 'hardened') { t.color = C.mint; t.opacity = 0.95; t.chip = `fixed · ${t.retries}`; t.chipCls = 'hardened'; }
      if (e.change === 'landed') { t.color = C.risk; t.opacity = 0.95; t.chip = `deploy landed · ${t.retries}`; t.chipCls = 'landed'; }
      if (e.change && since >= 0 && since < FLASH_MS) {
        t.chip = `${e.retriesFrom} → ${e.retries} retries`; t.chipCls += ' flash'; t.width += 2.4 * (1 - since / FLASH_MS); t.fast = true;
        t.comet = { u: (since / 1100) % 1, color: e.change === 'hardened' ? C.mint : C.risk };
      }
    }
    for (const [name, n] of Object.entries(s.nodes)) {
      const t = nodeT.get(name);
      if (n.hardened) { t.band = C.mint; t.bandO = Math.max(t.bandO, 0.75); t.mark = C.mint; t.markO = 0.3; }
      const since = now - seqTime(n.capSeq);
      // a scaled node keeps its capacity change on screen (like a hardened edge keeps its chip); it glows while new
      if (n.hardened && n.capFrom !== n.cap) { t.sub = `capacity ${Math.round(n.capFrom)} → ${Math.round(n.cap)}`; t.subCls = 'flash'; }
      if (n.capSeq && since >= 0 && since < FLASH_MS && n.capFrom !== n.cap) { t.rim = C.mint; t.rimS = 1.4; }
    }

    // 4. what is being evaluated now, and the committed decision (most specific last)
    if (o.probe) {
      const c = o.probe.role === 'red' ? C.red : C.blue;
      for (const n of o.probe.services) paintNode(n, (t) => { t.band = c; t.bandO = 1; t.pulse = 1; t.rim = c; t.rimS = 1.1; });
      for (const k of o.probe.edges) paintEdge(k, (t) => { t.color = c; t.opacity = 1; t.width += 2; t.fast = true; t.chip ||= t.retries; });
    }
    if (o.locked) {
      const since = now - seqTime(o.locked.seq);
      const snap = clamp01(since / 700);
      for (const n of o.locked.services) paintNode(n, (t) => { t.band = C.blue; t.bandO = 1; t.focal = C.blue; t.focalO = 0.9 * snap; t.rim = C.blue; t.rimS = 1.2; t.lockScale = 2 - snap; });
      for (const k of o.locked.edges) paintEdge(k, (t) => { t.color = C.blue; t.opacity = 1; t.width += 3; t.fast = true; t.chip = `chosen fix · ${t.retries}`; t.chipCls = 'locked'; });
    }
    if (s.result?.safe) {
      for (const t of nodeT.values()) { t.emissiveI = 0; t.halo = null; t.haloO = 0; t.pulse = 0; t.focal = null; t.focalO = 0; if (t.rim === C.red) { t.rim = C.cool; t.rimS = 0.55; } }
      // the final state is calm: hardened (mint) and landed (amber) edges stay coloured, their chips step back
      for (const t of edgeT.values()) { t.chip = ''; t.comet = null; }
    }
    return { nodeT, edgeT };
  }

  // ---------------------------------------------------------------- frame
  const tmpC = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  let lastNow = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = lastNow ? Math.min(1, (now - lastNow) / 1000) : 1 / 60;
    lastNow = now;
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    if (!state?.graph) { renderer.render(scene, camera); labels.render(scene, camera); return; }
    const sig = `${state.graph.services.map((s) => s.name).sort().join('|')}#${state.graph.calls.map((c) => `${c.caller}>${c.callee}`).sort().join('|')}`;
    if (sig !== built) { build(state.graph); built = sig; }
    if (state.round !== lastRound) { lastRound = state.round; roundAt = now; }
    if (state.result && !safeAt) safeAt = now;
    if (!state.result) safeAt = 0;

    const { nodeT, edgeT } = targets(now);
    const k = ease(5);
    const beat = 0.5 + 0.5 * Math.sin(now / 380);

    for (const [name, v] of nodes) {
      const t = nodeT.get(name), n = state.nodes[name];
      if (!t || !n) continue;
      const rise = 1 - Math.pow(1 - clamp01((now - v.born) / 1000), 3);
      const rGoal = NODE_R[0] + (NODE_R[1] - NODE_R[0]) * (v.hi > v.lo ? Math.min(1.3, (Math.log(n.cap) - v.lo) / (v.hi - v.lo)) : 0.5);
      v.r += (rGoal * rise - v.r) * ease(4);
      v.group.position.set(v.home.x, v.home.y - (1 - rise) * 3, v.home.z);
      v.core.scale.setScalar(v.r);
      const u = v.core.material.userData.uniforms;
      v.rim.lerp(tmpC.set(t.rim), k); u.uRim.value.copy(v.rim);
      u.uRimStrength.value += (t.rimS * (t.pulse ? 0.75 + 0.35 * beat : 1) - u.uRimStrength.value) * k;
      v.emissive.lerp(tmpC.set(t.emissive), k); v.core.material.emissive.copy(v.emissive);
      v.core.material.emissiveIntensity += (t.emissiveI - v.core.material.emissiveIntensity) * k;
      v.bandColor.lerp(tmpC.set(t.band ?? C.cool), k); v.band.material.color.copy(v.bandColor);
      v.band.material.opacity += (((t.band ? t.bandO : 0) * (t.pulse ? 0.6 + 0.4 * beat : 1)) * rise - v.band.material.opacity) * k;
      v.band.scale.setScalar(v.r);
      v.focal.material.color.set(t.focal ?? C.red);
      v.focal.material.opacity += ((t.focal ? t.focalO : 0) - v.focal.material.opacity) * ease(t.focal ? 6 : 3);
      v.focal.scale.setScalar(v.r * (t.lockScale ?? (1 + 0.05 * beat)));
      // shock: one ring expanding from the node at the moment the propagating signal reaches it
      const since = t.shockAt === null ? Infinity : now - t.shockAt;
      if (since >= 0 && since < SHOCK_MS) {
        const p = since / SHOCK_MS;
        v.shock.material.color.set(t.shockColor);
        v.shock.material.opacity = 0.75 * (1 - p);
        v.shock.scale.setScalar(v.r * (1.2 + 2.6 * p));
      } else v.shock.material.opacity = 0;
      v.halo.material.color.set(t.halo ?? C.risk);
      v.halo.material.opacity += ((t.halo && !minimal ? t.haloO : 0) - v.halo.material.opacity) * k;
      v.halo.scale.setScalar(v.r * 5);
      const h = v.group.position.y + 2.77;
      v.stem.scale.set(1, h, 1); v.stem.position.y = -h / 2 - v.r * 0.1;
      v.shadow.scale.setScalar(v.r * 3.4); v.shadow.material.opacity = 0.6 * rise;
      v.mark.material.color.lerp(tmpC.set(t.mark), k); v.mark.material.opacity += (t.markO * rise - v.mark.material.opacity) * k;
      v.mark.scale.setScalar(v.r * 1.25);
      v.label.position.set(0, -v.r - 1.05, 0);
      const sub = v.el.querySelector('.nl-sub');
      if (sub.textContent !== t.sub) sub.textContent = t.sub;
      const cls = `node-label ${n.entry ? 'nl-entry' : ''} ${t.subCls ? `nl-${t.subCls}` : ''}`;
      if (v.el.className !== cls) v.el.className = cls;
      v.el.style.opacity = String(rise);
    }

    for (const [key, v] of edges) {
      const t = edgeT.get(key);
      if (!t) continue;
      const grow = clamp01((now - v.born) / 700);
      const kk = t.fast ? ease(14) : k;
      v.color.lerp(tmpC.set(t.color), kk);
      v.mat.color.copy(v.color);
      v.width += (t.width - v.width) * kk;
      v.mat.linewidth = v.width;
      v.opacity += (t.opacity * grow - v.opacity) * kk;
      v.mat.opacity = v.opacity;
      v.arrow.material.color.copy(v.color); v.arrow.material.opacity = v.opacity;
      v.arrow.position.copy(v.curve.getPoint(0.82));
      v.arrow.quaternion.setFromUnitVectors(up, v.curve.getTangent(0.82).normalize());
      if (t.comet && !minimal) {
        v.comet.position.copy(v.curve.getPoint(t.comet.u));
        v.comet.material.color.set(t.comet.color);
        v.comet.material.opacity = 0.95 * Math.sin(Math.PI * clamp01(t.comet.u * 1.15));
      } else v.comet.material.opacity += (0 - v.comet.material.opacity) * ease(10);
      if (v.chip.textContent !== t.chip) v.chip.textContent = t.chip;
      const cls = `edge-chip ${t.chipCls} ${t.chip ? '' : 'empty'}`;
      if (v.chip.className !== cls) v.chip.className = cls;
    }

    // camera: frame the graph into the free screen band; drift toward the region an event is about, sparingly
    const o = state.overlay;
    const attackLive = o.attack && !o.attack.resolved;
    const focus = attackLive ? [...o.attack.evidence, ...o.attack.services] : o.amp && !o.attack ? o.amp.paths[0]
      : o.locked ? [...o.locked.services, ...o.locked.edges.flatMap((e) => e.split('>'))] : null;
    rig.targetGoal.copy(rig.center);
    let zoom = state.result ? 1.04 : 1;
    const fpts = (focus ?? []).map((n) => nodes.get(n)?.home).filter(Boolean);
    if (fpts.length) {
      const c = fpts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / fpts.length);
      rig.targetGoal.lerp(c, 0.28);
      zoom = 0.95;
    }
    rig.zoom += (zoom - rig.zoom) * ease(0.9);
    rig.targetGoal.y += rig.yShift;
    // horizontal offset (non-zero only when an overlay reserves a side column, e.g. the guided-demo card)
    rig.targetGoal.add(new THREE.Vector3(Math.cos(rig.theta), 0, -Math.sin(rig.theta)).multiplyScalar(rig.xShift));
    rig.target.lerp(rig.targetGoal, ease(0.9));
    rig.r += (rig.rGoal * rig.zoom - rig.r) * ease(1.4);
    const theta = rig.theta + rig.dragTheta;
    const phi = Math.min(1.35, Math.max(0.6, rig.phi + rig.dragPhi));
    camera.position.set(rig.target.x + rig.r * Math.sin(phi) * Math.sin(theta), rig.target.y + rig.r * Math.cos(phi), rig.target.z + rig.r * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(rig.target);
    camera.updateMatrixWorld();
    const H = Math.max(1, host.clientHeight);
    const TOP = 1 - (2 * insets.top) / H, BOTTOM = -1 + (2 * insets.bottom) / H;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const pv = new THREE.Vector3();
    for (const v of nodes.values()) {
      pv.copy(v.home).project(camera);
      minX = Math.min(minX, pv.x); maxX = Math.max(maxX, pv.x); minY = Math.min(minY, pv.y); maxY = Math.max(maxY, pv.y);
    }
    if (Number.isFinite(minX)) {
      const top = maxY + FRAME.NODE_PAD, bottom = minY - FRAME.LABEL_PAD;
      const W = Math.max(1, host.clientWidth);
      const LEFT = -FRAME.X + (2 * (insets.left ?? 0)) / W, RIGHT = FRAME.X - (2 * (insets.right ?? 0)) / W;
      const span = Math.max((maxX - minX) / Math.max(0.3, RIGHT - LEFT), (top - bottom) / Math.max(0.3, TOP - BOTTOM));
      rig.xShift += ((maxX + minX) / 2 - (RIGHT + LEFT) / 2) * rig.r * 0.25 * ease(3);
      rig.rGoal = (rig.r / rig.zoom) * span;
      rig.yShift += ((top + bottom) / 2 - (TOP + BOTTOM) / 2) * rig.r * 0.25 * ease(3);
    }

    // event-bound ripples across the floor: a new round, and the final verdict
    const rt = state.round > 1 ? (now - roundAt) / 2400 : 2;
    const st = safeAt ? (now - safeAt) / 3200 : 2;
    const p = Math.min(rt, st);
    if (p < 1 && !minimal) {
      ripple.material.color.set(st <= rt ? (state.result?.safe ? C.green : C.red) : C.mint);
      ripple.scale.setScalar(3 + p * 60);
      ripple.material.opacity = 0.4 * (1 - p);
    } else ripple.material.opacity = 0;

    renderer.render(scene, camera);
    labels.render(scene, camera);
  }

  // ---------------------------------------------------------------- input / size
  let drag = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, t: rig.dragTheta, p: rig.dragPhi }; });
  window.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    rig.dragTheta = drag.t - (e.clientX - drag.x) * 0.004;
    rig.dragPhi = drag.p - (e.clientY - drag.y) * 0.003;
  });
  renderer.domElement.addEventListener('dblclick', () => { rig.dragTheta = 0; rig.dragPhi = 0; });
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    labels.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    for (const m of lineMaterials) m.resolution.set(w, h);
  }
  new ResizeObserver(resize).observe(host);
  resize();
  requestAnimationFrame(frame);

  return {
    update(next, timeOf, nextInsets) {
      state = next; seqTime = timeOf;
      if (nextInsets) insets = nextInsets;
      for (const m of lineMaterials) m.resolution.set(host.clientWidth, host.clientHeight);
    },
    reset() { built = null; lastRound = null; safeAt = 0; disposeAll(); },
    setMinimal(on) { minimal = !!on; grid.visible = !minimal; },
  };
}
