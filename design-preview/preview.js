// ============================================
// drone-exam-sim デザインプレビュー・ハーネス
// 同一の試験コース（コーンA/B/C/D・H着陸円・ガイド線・機体）を
// 10種の環境テーマで描画し、見た目を比較できるようにする。
// 参考: night_city_environment.js（three 0.178の現行APIに置換）
// URLパラメータ: ?theme=<0..9 または id> & view=<hero|pov>
// ============================================
import * as THREE from 'three';

// ---- 決定論的乱数（スクショを安定させる） ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(20260719);
const rr = (a, b) => a + (b - a) * rand();

// ============================================
// レンダラ / シーン / カメラ
// ============================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 2000);

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'hero';

// ============================================
// 汎用ヘルパー
// ============================================
function gradientSky(top, bottom, { size = 800, offset = 20, exponent = 0.7 } = {}) {
  const uniforms = {
    topColor: { value: new THREE.Color(top) },
    bottomColor: { value: new THREE.Color(bottom) },
    offset: { value: offset },
    exponent: { value: exponent },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vP; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vP = wp.xyz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; uniform float offset; uniform float exponent; varying vec3 vP;
      void main(){ float h = normalize(vP + vec3(0.0, offset, 0.0)).y; float t = pow(max(h,0.0), exponent); gl_FragColor = vec4(mix(bottomColor, topColor, clamp(t,0.0,1.0)), 1.0); }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 16), mat);
  return mesh;
}

function windowTexture(warm) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0a14'; g.fillRect(0, 0, c.width, c.height);
  const warmCols = ['#ffeebb', '#ffdd88', '#ffcc66', '#ffe0a0'];
  const coolCols = ['#aaddff', '#88ccff', '#bfe4ff', '#d0f0ff'];
  const cols = warm ? warmCols : [...warmCols, ...coolCols, ...coolCols];
  const cw = 10, ch = 14, gapx = 6, gapy = 8;
  for (let y = gapy; y < c.height - ch; y += ch + gapy) {
    for (let x = gapx; x < c.width - cw; x += cw + gapx) {
      if (rand() > 0.32) {
        g.fillStyle = cols[Math.floor(rand() * cols.length)];
        g.globalAlpha = 0.65 + rand() * 0.35;
        g.fillRect(x, y, cw, ch);
        g.globalAlpha = 1;
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildingsRing(opts = {}) {
  const { count = 46, rMin = 34, rMax = 165, hMin = 18, hMax = 120, warm = true, baseColor = 0x161628, beacons = true } = opts;
  const winTex = windowTexture(warm);
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2;
    const radius = rr(rMin, rMax);
    const x = Math.cos(ang) * radius, z = Math.sin(ang) * radius;
    const w = rr(8, 20), d = rr(8, 20), h = rr(hMin, hMax) * (radius > 110 ? 0.5 : 1);
    const tex = winTex.clone(); tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 8)));
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor, roughness: 0.75, metalness: 0.25,
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: warm ? 0.9 : 1.05,
    });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    b.position.set(x, h / 2, z);
    b.castShadow = false; b.receiveShadow = true;
    scene.add(b);
    if (beacons && h > 60) {
      const bm = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 4 }));
      bm.position.set(x, h + 0.6, z); scene.add(bm);
    }
  }
}

function neonSigns(colors, count = 16, rMin = 38, rMax = 150) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2, radius = rr(rMin, rMax);
    const col = colors[i % colors.length];
    const vertical = rand() > 0.6;
    const geo = vertical ? new THREE.BoxGeometry(0.4, rr(5, 12), 0.3) : new THREE.BoxGeometry(rr(5, 11), 0.5, 0.3);
    const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 3.5, roughness: 0.4 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(ang) * radius, rr(8, 34), Math.sin(ang) * radius);
    scene.add(m);
    const pl = new THREE.PointLight(col, 6, 18, 2); pl.position.copy(m.position); scene.add(pl);
    out.push({ mat, base: 3.5, phase: rand() * Math.PI * 2 });
  }
  return out;
}

function starfield(count, spread, color, opacity, size = 1.4) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1), r = spread * (0.7 + rand() * 0.3);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = Math.abs(r * Math.cos(ph)) + 40;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color, size, transparent: true, opacity, sizeAttenuation: true });
  const p = new THREE.Points(geo, m); scene.add(p); return p;
}

function moonWithHalo(pos, color = 0xdfe6f2) {
  const moon = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 32),
    new THREE.MeshStandardMaterial({ color, emissive: 0x556688, emissiveIntensity: 0.7, roughness: 0.9 }));
  moon.position.copy(pos); scene.add(moon);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x99aadd, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }));
  halo.position.copy(pos); scene.add(halo);
}

function cityGlow(count = 380) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2, radius = rr(45, 240), h = rand() * 55;
    pos[i * 3] = Math.cos(ang) * radius; pos[i * 3 + 1] = h; pos[i * 3 + 2] = Math.sin(ang) * radius;
    const t = rand();
    if (t < 0.5) { col[i * 3] = 1; col[i * 3 + 1] = 0.8 + rand() * 0.2; col[i * 3 + 2] = 0.4 + rand() * 0.3; }
    else if (t < 0.8) { col[i * 3] = 0.4 + rand() * 0.3; col[i * 3 + 1] = 0.6 + rand() * 0.3; col[i * 3 + 2] = 1; }
    else { col[i * 3] = 0.9; col[i * 3 + 1] = 0.9; col[i * 3 + 2] = 1; }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 2.2, transparent: true, opacity: 0.32, vertexColors: true, sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const p = new THREE.Points(geo, m); scene.add(p); return p;
}

function distantHills(color = 0x243042, count = 7, dist = 260) {
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rr(-0.2, 0.2);
    const r = dist + rr(-30, 30);
    const s = rr(60, 130);
    const g = new THREE.Mesh(new THREE.SphereGeometry(s, 20, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }));
    g.position.set(Math.cos(ang) * r, -s * 0.55, Math.sin(ang) * r);
    scene.add(g);
  }
}

function mesas(color = 0x3a2438, count = 8, dist = 200) {
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2, r = dist + rr(-40, 60);
    const w = rr(25, 70), h = rr(18, 55);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * rr(0.6, 1.2)),
      new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    m.position.set(Math.cos(ang) * r, h / 2, Math.sin(ang) * r);
    scene.add(m);
  }
}

function clouds(count = 16, color = 0xffffff, opacity = 0.5, yMin = 45, yMax = 90) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(rr(40, 90), rr(14, 30)),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: opacity * (0.5 + rand() * 0.6), side: THREE.DoubleSide, depthWrite: false }));
    m.position.set(rr(-260, 260), rr(yMin, yMax), rr(-260, 260));
    m.rotation.x = -Math.PI / 2 + rr(-0.2, 0.2);
    scene.add(m);
    list.push({ m, sp: rr(0.02, 0.06) });
  }
  return list;
}

function sunDisk(pos, color = 0xffd090, size = 14) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 32),
    new THREE.MeshBasicMaterial({ color }));
  s.position.copy(pos); scene.add(s);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 2.4, 32, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false }));
  halo.position.copy(pos); scene.add(halo);
}

function precipitation(count, color, size, spread, fallSpeed, stretch) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rr(-spread, spread);
    pos[i * 3 + 1] = rr(0, 90);
    pos[i * 3 + 2] = rr(-spread, spread);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.7, sizeAttenuation: true, depthWrite: false });
  const p = new THREE.Points(geo, m); scene.add(p);
  return { p, pos, count, fallSpeed, spread, stretch };
}

function auroraBands() {
  const list = [];
  const cols = [0x33ff99, 0x22ddcc, 0x8866ff];
  for (let b = 0; b < 3; b++) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    const col = new THREE.Color(cols[b]);
    grad.addColorStop(0, `rgba(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0},0)`);
    grad.addColorStop(0.5, `rgba(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0},0.55)`);
    grad.addColorStop(1, `rgba(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, 256, 128);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(420, 90, 40, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, Math.sin(x * 0.03 + b) * 18);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(rr(-40, 40), rr(70, 120), -150 - b * 30);
    m.rotation.x = rr(-0.15, 0.05);
    scene.add(m);
    list.push({ m, phase: b });
  }
  return list;
}

function roomBox(wall = 0x14161c, size = 130, height = 55) {
  const mat = new THREE.MeshStandardMaterial({ color: wall, roughness: 0.9, metalness: 0.1, side: THREE.BackSide });
  const room = new THREE.Mesh(new THREE.BoxGeometry(size, height, size), mat);
  room.position.y = height / 2 - 0.2; room.receiveShadow = true; scene.add(room);
  // 天井トラス風の暗い格子
  const truss = new THREE.GridHelper(size, 20, 0x2a2e38, 0x1c1f27);
  truss.position.y = height - 1; scene.add(truss);
  return room;
}

function overheadSpots(color = 0xcfe0ff, cols = 3, rows = 3, spanX = 26, spanZ = 16, y = 30) {
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = (i - (cols - 1) / 2) * (spanX / cols);
      const z = (j - (rows - 1) / 2) * (spanZ / rows);
      const s = new THREE.SpotLight(color, 60, 80, Math.PI / 6, 0.6, 1.6);
      s.position.set(x, y, z); s.target.position.set(x, 0, z);
      s.castShadow = i === 1 && j === 1;
      scene.add(s); scene.add(s.target);
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 0.8, 12),
        new THREE.MeshStandardMaterial({ color: 0x0c0d10, emissive: color, emissiveIntensity: 0.8 }));
      housing.position.set(x, y, z); scene.add(housing);
    }
  }
}

function glowGridFloor(color = 0x00e5ff, size = 140, div = 56) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#02040a'; g.fillRect(0, 0, 512, 512);
  const col = new THREE.Color(color);
  g.strokeStyle = `rgb(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0})`;
  g.lineWidth = 2; g.globalAlpha = 0.9;
  const step = 512 / 16;
  for (let i = 0; i <= 16; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(512, i * step); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(div / 4, div / 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0x05070e, map: tex, emissiveMap: tex, emissive: color, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.2 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.01; scene.add(floor);
  return floor;
}

function risingParticles(count = 200, color = 0x00e5ff) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { pos[i * 3] = rr(-60, 60); pos[i * 3 + 1] = rr(0, 50); pos[i * 3 + 2] = rr(-60, 60); }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color, size: 0.5, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
  const p = new THREE.Points(geo, m); scene.add(p);
  return { p, pos, count };
}

// ============================================
// 地面
// ============================================
function makeGround(color, roughness, metalness, { displace = 0, y = 0 } = {}) {
  const geo = new THREE.PlaneGeometry(600, 600, displace ? 160 : 1, displace ? 160 : 1);
  if (displace) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), yy = pos.getY(i);
      const d = Math.sin(x * 0.05) * Math.cos(yy * 0.05) * displace +
                Math.sin(x * 0.13 + 1.4) * Math.cos(yy * 0.11) * displace * 0.4;
      // コース周辺は平らに（試験エリアを保つ）
      const flat = Math.min(1, Math.hypot(x, yy) / 18);
      pos.setZ(i, d * flat);
    }
    geo.computeVertexNormals();
  }
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2; m.position.y = y; m.receiveShadow = true;
  scene.add(m); return m;
}

// ============================================
// 試験コース（コーン・H・ガイド線・機体）
// ============================================
function labelSprite(text, color = '#ffffff') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 92px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(text, 64, 68);
  g.fillStyle = color; g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
  s.scale.set(1.6, 1.6, 1); return s;
}

// 4-1 スクエア飛行相当：13m(x) × 5m(z) の矩形、四隅にコーン、中央前にH
const CORNERS = { A: [-6.5, 2.5], B: [6.5, 2.5], C: [6.5, -2.5], D: [-6.5, -2.5] };

function buildCourse(markerEmissive) {
  const group = new THREE.Group();
  // コーン
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a1e, roughness: 0.6, emissive: 0xff3300, emissiveIntensity: markerEmissive ? 0.5 : 0.08 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: markerEmissive ? 0.4 : 0.05 });
  for (const [name, [x, z]] of Object.entries(CORNERS)) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.05, 22), coneMat);
    cone.position.set(x, 0.55, z); cone.castShadow = true; group.add(cone);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.16, 22), stripeMat);
    stripe.position.set(x, 0.5, z); group.add(stripe);
    const lab = labelSprite(name); lab.position.set(x, 1.9, z); group.add(lab);
  }
  // ガイド線（矩形＋中央十字）
  const lineCol = markerEmissive ? 0x9fe8ff : 0xffffff;
  const lineMat = new THREE.LineBasicMaterial({ color: lineCol, transparent: true, opacity: markerEmissive ? 0.9 : 0.55 });
  const rectPts = [CORNERS.A, CORNERS.B, CORNERS.C, CORNERS.D, CORNERS.A].map(([x, z]) => new THREE.Vector3(x, 0.03, z));
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rectPts), lineMat));
  // H 着陸円（中央）
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.12, 48),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: markerEmissive ? 0.6 : 0.1, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; group.add(ring);
  // H マーク（キャンバス）
  const hc = document.createElement('canvas'); hc.width = hc.height = 128;
  const hg = hc.getContext('2d');
  hg.fillStyle = markerEmissive ? '#ffffff' : '#f0f0f0';
  hg.fillRect(30, 24, 16, 80); hg.fillRect(82, 24, 16, 80); hg.fillRect(30, 56, 68, 16);
  const ht = new THREE.CanvasTexture(hc); ht.colorSpace = THREE.SRGBColorSpace;
  const hmark = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4),
    new THREE.MeshStandardMaterial({ map: ht, transparent: true, emissive: 0xffffff, emissiveMap: ht, emissiveIntensity: markerEmissive ? 0.5 : 0.12 }));
  hmark.rotation.x = -Math.PI / 2; hmark.position.y = 0.05; group.add(hmark);
  scene.add(group);
  return group;
}

function buildDrone() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.5, metalness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), bodyMat);
  body.castShadow = true; g.add(body);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.6 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.4, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const arms = [[0.42, 0.42], [-0.42, 0.42], [0.42, -0.42], [-0.42, -0.42]];
  arms.forEach(([x, z], i) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.08), armMat);
    arm.position.set(x / 2, 0, z / 2); arm.rotation.y = Math.atan2(z, x); g.add(arm);
    const rotor = new THREE.Mesh(new THREE.CircleGeometry(0.34, 24), rotorMat);
    rotor.rotation.x = -Math.PI / 2; rotor.position.set(x, 0.09, z); g.add(rotor);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshStandardMaterial({ color: i < 2 ? 0x33ff55 : 0xff3344, emissive: i < 2 ? 0x33ff55 : 0xff3344, emissiveIntensity: 4 }));
    led.position.set(x, 0.02, z); g.add(led);
  });
  g.position.set(0, 1.55, 0); g.rotation.set(0.04, 0.5, -0.03);
  scene.add(g); return g;
}

// ============================================
// テーマ定義（10種）
// ============================================
const THEMES = [
  {
    id: 'neon-city', name: 'ネオン・ナイトシティ', markerEmissive: true, exposure: 0.95,
    concept: '参考JS直系。漆黒の空・摩天楼の窓明かり・ネオン・月。最もドラマチックで“魅せる”方向。',
    palette: ['#05050f', '#ff2f6e', '#00e5ff', '#8899cc'],
    build() {
      scene.background = new THREE.Color(0x05050f);
      scene.fog = new THREE.FogExp2(0x08081a, 0.006);
      makeGround(0x12121f, 0.28, 0.5);
      const grid = new THREE.GridHelper(600, 120, 0x1a2a4a, 0x0f1525); grid.position.y = 0.02;
      grid.material.opacity = 0.18; grid.material.transparent = true; scene.add(grid);
      scene.add(new THREE.AmbientLight(0x1a1a3e, 0.5));
      scene.add(new THREE.HemisphereLight(0x0a1a4a, 0x0a0a1a, 0.5));
      const moon = new THREE.DirectionalLight(0x8899cc, 1.4); moon.position.set(80, 150, 60);
      moon.castShadow = true; moon.shadow.mapSize.set(2048, 2048);
      moon.shadow.camera.left = -30; moon.shadow.camera.right = 30; moon.shadow.camera.top = 30; moon.shadow.camera.bottom = -30;
      moon.shadow.bias = -0.0004; scene.add(moon);
      const rim = new THREE.DirectionalLight(0xff5533, 0.4); rim.position.set(-60, 40, -80); scene.add(rim);
      buildingsRing({ warm: true });
      const neon = neonSigns([0xff0066, 0x00ffcc, 0xffaa00, 0xcc00ff, 0x00ccff]);
      starfield(300, 500, 0xffffff, 0.9); starfield(1200, 480, 0xaaaaff, 0.4, 0.8);
      moonWithHalo(new THREE.Vector3(100, 200, 80));
      const glow = cityGlow();
      return { neon, glow };
    },
  },
  {
    id: 'rainy-blade', name: 'レイン・ブレードランナー', markerEmissive: true, exposure: 1.0,
    concept: '濡れた路面の強反射＋雨＋濃い霧、ティール×マゼンタのサイバーパンク。重く湿った没入感。',
    palette: ['#04060c', '#00b4c8', '#c030a0', '#0c0f18'],
    build() {
      scene.background = new THREE.Color(0x04060c);
      scene.fog = new THREE.FogExp2(0x0a0e18, 0.013);
      makeGround(0x0c0f18, 0.08, 0.75);
      scene.add(new THREE.AmbientLight(0x101830, 0.6));
      scene.add(new THREE.HemisphereLight(0x0a1830, 0x08080f, 0.4));
      const key = new THREE.DirectionalLight(0x2aa0c0, 1.0); key.position.set(60, 90, 40);
      key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -30; key.shadow.camera.right = 30; key.shadow.camera.top = 30; key.shadow.camera.bottom = -30;
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xc030a0, 0.6); rim.position.set(-50, 40, -60); scene.add(rim);
      buildingsRing({ warm: false, baseColor: 0x0e1020 });
      const neon = neonSigns([0x00ffcc, 0xff2f9e, 0xffaa00, 0x00ccff], 20);
      starfield(500, 480, 0x88aacc, 0.25, 0.7);
      const rain = precipitation(2600, 0xbfe4ff, 0.35, 120, 55, true);
      cityGlow(320);
      return { neon, rain };
    },
  },
  {
    id: 'dawn-mist', name: '夜明けの霧', markerEmissive: false, exposure: 1.0,
    concept: '藍から桃色へ滲む夜明けの空、地表の薄霧、遠景の山影。静かで視認性◎の穏やか系。',
    palette: ['#24406e', '#f2b48a', '#a9bcd6', '#6f7a72'],
    build() {
      scene.add(gradientSky('#24406e', '#f6c79a', { exponent: 0.55 }));
      scene.fog = new THREE.Fog(0xdcc3ab, 25, 240);
      makeGround(0x6f7a72, 0.92, 0.0);
      scene.add(new THREE.AmbientLight(0x3a4a66, 0.7));
      scene.add(new THREE.HemisphereLight(0x9fb8e0, 0x6b5540, 1.1));
      const sun = new THREE.DirectionalLight(0xffd0a0, 1.6); sun.position.set(-80, 34, 90);
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -30; sun.shadow.camera.right = 30; sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
      scene.add(sun);
      distantHills(0x5a6478, 8, 230);
      clouds(10, 0xf0cdb0, 0.28, 40, 70);
      sunDisk(new THREE.Vector3(-150, 24, 170), 0xffe0b0, 10);
      // 地表の霧レイヤ
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(rr(60, 120), rr(20, 40)),
          new THREE.MeshBasicMaterial({ color: 0xe6d2bd, transparent: true, opacity: 0.12, depthWrite: false }));
        m.position.set(rr(-70, 70), rr(2, 7), rr(-70, 70)); m.rotation.x = -Math.PI / 2 + rr(-0.1, 0.1); scene.add(m);
      }
      return {};
    },
  },
  {
    id: 'golden-sunset', name: 'ゴールデンアワー', markerEmissive: false, exposure: 1.05,
    concept: 'オレンジ〜ピンクの夕景と長い影、暖色のリムライト。ドローンPVのような映画的暖かさ。',
    palette: ['#3a2a5a', '#ff8a3a', '#ff6030', '#6a5a3a'],
    build() {
      scene.add(gradientSky('#3a2a6a', '#ff9a4a', { exponent: 0.6 }));
      scene.fog = new THREE.Fog(0xc9743a, 35, 300);
      makeGround(0x6a5a3a, 0.9, 0.0);
      scene.add(new THREE.AmbientLight(0x4a2f2a, 0.6));
      scene.add(new THREE.HemisphereLight(0xffb070, 0x4a3020, 0.9));
      const sun = new THREE.DirectionalLight(0xffb060, 2.4); sun.position.set(-120, 22, 60);
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -32; sun.shadow.camera.right = 32; sun.shadow.camera.top = 32; sun.shadow.camera.bottom = -32;
      scene.add(sun);
      const rim = new THREE.DirectionalLight(0xff5020, 0.5); rim.position.set(40, 20, -80); scene.add(rim);
      distantHills(0x4a3550, 7, 250);
      clouds(14, 0xffb98a, 0.55, 40, 85);
      sunDisk(new THREE.Vector3(-190, 16, 95), 0xff9a3c, 16);
      return {};
    },
  },
  {
    id: 'clear-day', name: 'クリアデイ（実用）', markerEmissive: false, exposure: 1.0,
    concept: '澄んだ青空・芝・淡い雲。要素が最も見やすい“実用/既定”寄り。屋外現行の正統進化。',
    palette: ['#2b6fd0', '#bfe0ff', '#4a6b38', '#ffffff'],
    build() {
      scene.add(gradientSky('#2b6fd0', '#cfe8ff', { exponent: 0.5 }));
      scene.fog = new THREE.Fog(0xd6ecff, 70, 420);
      makeGround(0x4a6b38, 0.95, 0.0);
      scene.add(new THREE.AmbientLight(0x88a0c0, 0.6));
      scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x4a5a3a, 1.2));
      const sun = new THREE.DirectionalLight(0xfff6e0, 2.2); sun.position.set(60, 120, 40);
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -30; sun.shadow.camera.right = 30; sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
      sun.shadow.bias = -0.0003; scene.add(sun);
      distantHills(0x3f5a34, 8, 300);
      clouds(16, 0xffffff, 0.65, 55, 95);
      return {};
    },
  },
  {
    id: 'overcast-fog', name: '曇天フォグ', markerEmissive: false, exposure: 1.0,
    concept: 'フラットな灰色光と霧。影が弱く落ち着いた現実の“訓練日和”。地味だが最も実試験に近い。',
    palette: ['#8a929c', '#aab0b8', '#55605a', '#c0c6cc'],
    build() {
      scene.add(gradientSky('#8a929c', '#b4bac2', { exponent: 0.9 }));
      scene.fog = new THREE.FogExp2(0xa5abb3, 0.010);
      makeGround(0x55605a, 1.0, 0.0);
      scene.add(new THREE.AmbientLight(0x8a8f95, 0.8));
      scene.add(new THREE.HemisphereLight(0xc0c6cc, 0x5a5e58, 1.5));
      const sun = new THREE.DirectionalLight(0xc8ccd0, 0.7); sun.position.set(40, 110, 50);
      sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -30; sun.shadow.camera.right = 30; sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
      scene.add(sun);
      distantHills(0x6a7068, 6, 210);
      return {};
    },
  },
  {
    id: 'hangar', name: 'ドローン格納庫', markerEmissive: true, exposure: 1.0,
    concept: '暗い屋内＋天井スポット格子＋発光する床ガイド＋テック壁面。体育館の“強化版”。',
    palette: ['#0a0b0e', '#00e5ff', '#cfe0ff', '#1a1d24'],
    build() {
      scene.background = new THREE.Color(0x07080b);
      scene.fog = new THREE.FogExp2(0x07080b, 0.007);
      roomBox(0x14161c, 140, 55);
      makeGround(0x1a1d24, 0.3, 0.35);
      scene.add(new THREE.AmbientLight(0x20242c, 0.9));
      overheadSpots(0xcfe0ff, 3, 3, 30, 18, 34);
      // 発光する床ガイドライン（コース外周に）
      const lineGeo = new THREE.BufferGeometry().setFromPoints(
        [[-20, 0.02, -12], [20, 0.02, -12], [20, 0.02, 12], [-20, 0.02, 12], [-20, 0.02, -12]].map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00e5ff })));
      // テック壁パネル（発光ストリップ）
      for (let i = 0; i < 8; i++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 0.3),
          new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 2.5 }));
        const ang = (i / 8) * Math.PI * 2;
        strip.position.set(Math.cos(ang) * 62, 8, Math.sin(ang) * 62); scene.add(strip);
      }
      return {};
    },
  },
  {
    id: 'tron-grid', name: 'サイバーグリッド', markerEmissive: true, exposure: 1.15,
    concept: '漆黒の虚空に発光グリッド床、ネオンのコース線、上昇パーティクル。抽象・高コントラストで要素最優先。',
    palette: ['#01030a', '#00e5ff', '#ff7a1e', '#02040c'],
    build() {
      scene.background = new THREE.Color(0x01030a);
      scene.fog = new THREE.FogExp2(0x02040c, 0.009);
      glowGridFloor(0x00e5ff, 160, 64);
      scene.add(new THREE.AmbientLight(0x0a1030, 0.8));
      const p1 = new THREE.PointLight(0x00e5ff, 40, 60, 2); p1.position.set(0, 12, 0); scene.add(p1);
      const p2 = new THREE.PointLight(0xff7a1e, 25, 50, 2); p2.position.set(10, 6, 8); scene.add(p2);
      starfield(400, 500, 0x66aaff, 0.4, 0.7);
      const rise = risingParticles(220, 0x00e5ff);
      return { rise };
    },
  },
  {
    id: 'desert-dusk', name: '砂漠のたそがれ', markerEmissive: false, exposure: 1.05,
    concept: '砂丘の起伏、紫〜橙の残照、遠くのメサ（卓状台地）、砂塵の靄。開放的でエキゾチック。',
    palette: ['#3a2a6a', '#e8895a', '#c2a06a', '#4a3550'],
    build() {
      scene.add(gradientSky('#3a2a6a', '#ec9a5a', { exponent: 0.62 }));
      scene.fog = new THREE.Fog(0xb0663a, 40, 340);
      makeGround(0xc2a06a, 1.0, 0.0, { displace: 3 });
      scene.add(new THREE.AmbientLight(0x4a3a5a, 0.7));
      scene.add(new THREE.HemisphereLight(0xc8a0d0, 0x5a3a2a, 0.9));
      const sun = new THREE.DirectionalLight(0xffa060, 2.0); sun.position.set(-140, 20, 40);
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -32; sun.shadow.camera.right = 32; sun.shadow.camera.top = 32; sun.shadow.camera.bottom = -32;
      scene.add(sun);
      mesas(0x6a4a3a, 9, 210);
      sunDisk(new THREE.Vector3(-210, 14, 60), 0xff8a4a, 15);
      starfield(200, 500, 0xffe0c0, 0.3, 0.8);
      // 砂塵の靄
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(rr(70, 130), rr(18, 34)),
          new THREE.MeshBasicMaterial({ color: 0xd0a070, transparent: true, opacity: 0.1, depthWrite: false }));
        m.position.set(rr(-80, 80), rr(3, 9), rr(-80, 80)); m.rotation.x = -Math.PI / 2 + rr(-0.1, 0.1); scene.add(m);
      }
      return {};
    },
  },
  {
    id: 'snow-aurora', name: '雪原のオーロラ', markerEmissive: true, exposure: 1.0,
    concept: '白い雪原、夜空に揺れるオーロラ、冷たい月光、舞う雪。寒色の際立つ幻想的な一枚。',
    palette: ['#04060f', '#33ff99', '#a0c0ff', '#dfe8f2'],
    build() {
      scene.background = new THREE.Color(0x04060f);
      scene.fog = new THREE.FogExp2(0x08101c, 0.006);
      const snow = makeGround(0xdfe8f2, 0.8, 0.0);
      snow.material.emissive = new THREE.Color(0x223046); snow.material.emissiveIntensity = 0.3;
      scene.add(new THREE.AmbientLight(0x1a2540, 0.7));
      scene.add(new THREE.HemisphereLight(0x2a4a70, 0x0a1420, 0.7));
      const moon = new THREE.DirectionalLight(0xa0c0ff, 1.3); moon.position.set(70, 120, -40);
      moon.castShadow = true; moon.shadow.mapSize.set(2048, 2048);
      moon.shadow.camera.left = -30; moon.shadow.camera.right = 30; moon.shadow.camera.top = 30; moon.shadow.camera.bottom = -30;
      scene.add(moon);
      const aurora = auroraBands();
      starfield(500, 500, 0xffffff, 0.8); starfield(1000, 480, 0xaaccff, 0.4, 0.7);
      moonWithHalo(new THREE.Vector3(90, 180, -60), 0xdfeaff);
      const snowfall = precipitation(1800, 0xffffff, 0.5, 110, 8, false);
      return { aurora, snowfall };
    },
  },
];

// ============================================
// テーマ選択・組み立て
// ============================================
const themeParam = params.get('theme') || '0';
let theme = /^\d+$/.test(themeParam) ? THEMES[parseInt(themeParam, 10)] : THEMES.find((t) => t.id === themeParam);
if (!theme) theme = THEMES[0];

let dyn = {};
try {
  rand = mulberry32(20260719); // 各テーマで同じ乱数列
  renderer.toneMappingExposure = theme.exposure;
  dyn = theme.build() || {};
  buildCourse(theme.markerEmissive);
  buildDrone();
  document.getElementById('label').innerHTML = `${theme.name}　<span class="id">${theme.id}</span>`;
  window.__THEME = theme.id;
} catch (e) {
  console.error('THEME BUILD ERROR', e);
  window.__ERR = String(e && e.stack || e);
}

// ============================================
// カメラ
// ============================================
if (view === 'pov') {
  camera.position.set(0, 1.65, 10.5);
  camera.lookAt(0, 1.4, -1);
} else {
  camera.position.set(12.5, 8.5, 14.5);
  camera.lookAt(0, 1.1, 0);
}

// ============================================
// アニメーション（数フレーム回して降水・ネオン等を馴染ませる）
// ============================================
let t0 = 0;
function tick() {
  const time = (t0 += 1 / 60);
  if (dyn.neon) dyn.neon.forEach((n) => { const f = Math.sin(time * 3 + n.phase) > 0.95 ? 0.35 : 1; n.mat.emissiveIntensity = n.base * f; });
  if (dyn.rain) { const { pos, count, fallSpeed, spread } = dyn.rain; for (let i = 0; i < count; i++) { pos[i * 3 + 1] -= fallSpeed / 60; pos[i * 3] += 0.06; if (pos[i * 3 + 1] < 0) { pos[i * 3 + 1] = 90; pos[i * 3] = rr(-spread, spread); } } dyn.rain.p.geometry.attributes.position.needsUpdate = true; }
  if (dyn.snowfall) { const { pos, count, fallSpeed, spread } = dyn.snowfall; for (let i = 0; i < count; i++) { pos[i * 3 + 1] -= fallSpeed / 60; pos[i * 3] += Math.sin(time + i) * 0.01; if (pos[i * 3 + 1] < 0) pos[i * 3 + 1] = 90; } dyn.snowfall.p.geometry.attributes.position.needsUpdate = true; }
  if (dyn.rise) { const { pos, count } = dyn.rise; for (let i = 0; i < count; i++) { pos[i * 3 + 1] += 0.08; if (pos[i * 3 + 1] > 50) pos[i * 3 + 1] = 0; } dyn.rise.p.geometry.attributes.position.needsUpdate = true; }
  if (dyn.aurora) dyn.aurora.forEach((a) => { a.m.material.opacity = 0.45 + Math.sin(time * 0.6 + a.phase) * 0.2; });
  renderer.render(scene, camera);
  if (t0 < 3) requestAnimationFrame(tick); else window.__READY = true;
}
// 降水を数十フレーム進めてから READY にする
for (let i = 0; i < 90; i++) {
  if (dyn.rain) { const { pos, count, fallSpeed, spread } = dyn.rain; for (let k = 0; k < count; k++) { pos[k * 3 + 1] -= fallSpeed / 60; pos[k * 3] += 0.06; if (pos[k * 3 + 1] < 0) { pos[k * 3 + 1] = 90; pos[k * 3] = rr(-spread, spread); } } dyn.rain.p.geometry.attributes.position.needsUpdate = true; }
  if (dyn.snowfall) { const { pos, count, fallSpeed } = dyn.snowfall; for (let k = 0; k < count; k++) { pos[k * 3 + 1] -= fallSpeed / 60; if (pos[k * 3 + 1] < 0) pos[k * 3 + 1] = 90; } dyn.snowfall.p.geometry.attributes.position.needsUpdate = true; }
}
renderer.render(scene, camera);
requestAnimationFrame(tick);
window.__READY = true;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
