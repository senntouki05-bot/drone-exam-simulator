// ============================================
// drone-exam-sim シネマ・プレビュー（drone_simulator_v4.html を参考に再構築）
// - 外部CDN禁止 → バンドル版 three 0.178 / three/addons を使用
// - v4の print(...) 除去・</script>分割を単一モジュールへ統合
// - デモの自動旋回操作は使わず、静止カメラ（?view=hero|pov）
// - 試験コースは実寸（13m×5m スクエア・コーンA/B/C/D・H着陸円）
// - PMREMで手続きHDRIを環境マップ化・SSAO/Bloom/影オン（見た目優先）
// - 描画統計(ドローコール/三角形)と実測fps(ヘッドレスは保守値)を window.__STATS に出す
// URLパラメータ: ?scene=indoor|outdoor & view=hero|pov
// ============================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'hero';
const sceneMode = params.get('scene') || 'indoor';
const SHADOW = parseInt(params.get('shadow') || '2048', 10); // 影マップ解像度（4096で更に高品位）

const container = document.body;
const canvas = document.getElementById('c');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ---- Post-processing ----
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 16;
ssaoPass.minDistance = 0.004;
ssaoPass.maxDistance = 0.12;
composer.addPass(ssaoPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.28, 0.7, 0.92);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.01;
controls.target.set(0, 1.2, 0);

// ============================================
// 手続きHDRI → PMREM 環境マップ
// ============================================
function createHDRI() {
  const size = 512;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = y / size;
      const u = x / size;
      const horizon = [0.4, 0.5, 0.65];
      const zenith = [0.15, 0.25, 0.5];
      const ground = [0.08, 0.06, 0.04];
      let r, g, b;
      if (v < 0.5) {
        const t = v * 2;
        r = ground[0] * (1 - t) + horizon[0] * t;
        g = ground[1] * (1 - t) + horizon[1] * t;
        b = ground[2] * (1 - t) + horizon[2] * t;
      } else {
        const t = (v - 0.5) * 2;
        r = horizon[0] * (1 - t) + zenith[0] * t;
        g = horizon[1] * (1 - t) + zenith[1] * t;
        b = horizon[2] * (1 - t) + zenith[2] * t;
      }
      const sunU = 0.65, sunV = 0.72;
      const dist = Math.sqrt((u - sunU) ** 2 + (v - sunV) ** 2);
      const sun = Math.exp(-dist * dist * 300) * 14;
      data[i] = r * 1.0 + sun * 1.4;
      data[i + 1] = g * 1.0 + sun * 1.3;
      data[i + 2] = b * 1.0 + sun * 1.1;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromEquirectangular(createHDRI());
scene.environment = envRT.texture;
scene.environmentIntensity = 0.55;

// ============================================
// PBRマテリアル（v4）
// ============================================
const matBody = new THREE.MeshPhysicalMaterial({ color: 0xe8e8ec, metalness: 0.2, roughness: 0.15, clearcoat: 1.0, clearcoatRoughness: 0.05, reflectivity: 0.7, ior: 1.5 });
const matDark = new THREE.MeshPhysicalMaterial({ color: 0x1a1a20, metalness: 0.75, roughness: 0.2, clearcoat: 0.5 });
const matNose = new THREE.MeshPhysicalMaterial({ color: 0xc02020, metalness: 0.1, roughness: 0.1, clearcoat: 1.0, emissive: 0x301010, emissiveIntensity: 0.15 });
const matProp = new THREE.MeshPhysicalMaterial({ color: 0x101418, metalness: 0.5, roughness: 0.3, transparent: true, opacity: 0.85 });
const matLED = new THREE.MeshPhysicalMaterial({ color: 0x40a0ff, emissive: 0x40a0ff, emissiveIntensity: 2.4, roughness: 0.02, toneMapped: false });
const matLEDRed = new THREE.MeshPhysicalMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 2.4, roughness: 0.02, toneMapped: false });
const matMotor = new THREE.MeshPhysicalMaterial({ color: 0x282830, metalness: 0.9, roughness: 0.1, clearcoat: 0.7 });
const matGlass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 0.97, thickness: 0.5, ior: 1.5, transparent: true, opacity: 0.2 });
const matCarbon = new THREE.MeshPhysicalMaterial({ color: 0x151518, metalness: 0.3, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.1 });

// ============================================
// 機体（v4 フライトシム品質）
// ============================================
function createDrone() {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';

  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(0, 0.08); bodyShape.lineTo(0.12, 0.06); bodyShape.lineTo(0.14, 0.02);
  bodyShape.lineTo(0.12, -0.02); bodyShape.lineTo(0, -0.04); bodyShape.lineTo(-0.12, -0.02);
  bodyShape.lineTo(-0.14, 0.02); bodyShape.lineTo(-0.12, 0.06); bodyShape.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, { depth: 0.28, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 3 });
  const body = new THREE.Mesh(bodyGeo, matBody);
  body.rotation.y = Math.PI / 2; body.position.y = 0.13; body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  const topPanel = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.008, 0.26), matCarbon);
  topPanel.position.y = 0.185; group.add(topPanel);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 12), matNose);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.14, -0.16); group.add(nose);

  const ledGeo = new THREE.SphereGeometry(0.008, 12, 12);
  const frontLED = new THREE.Mesh(ledGeo, matLEDRed); frontLED.position.set(0, 0.14, -0.18); group.add(frontLED);
  for (const [lx, ly, lz] of [[-0.06, 0.14, 0.14], [0.06, 0.14, 0.14]]) {
    const led = new THREE.Mesh(ledGeo, matLED); led.position.set(lx, ly, lz); group.add(led);
  }

  const armGeo = new THREE.BoxGeometry(0.58, 0.015, 0.04);
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(armGeo, matCarbon); arm.position.y = 0.14; arm.rotation.y = angle; arm.castShadow = true; group.add(arm);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.5, 6), matDark);
    strut.position.y = 0.14; strut.rotation.y = angle; strut.rotation.z = Math.PI / 6; group.add(strut);
  }

  for (const side of [-1, 1]) {
    const legGroup = new THREE.Group();
    const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.12, 8), matCarbon); s1.position.set(0, 0.06, 0.03); s1.rotation.x = 0.15; legGroup.add(s1);
    const s2 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.12, 8), matCarbon); s2.position.set(0, 0.06, -0.03); s2.rotation.x = -0.15; legGroup.add(s2);
    const skidCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.12, 0, 0), new THREE.Vector3(-0.06, -0.01, 0), new THREE.Vector3(0, -0.015, 0),
      new THREE.Vector3(0.06, -0.01, 0), new THREE.Vector3(0.12, 0, 0)]);
    const skid = new THREE.Mesh(new THREE.TubeGeometry(skidCurve, 20, 0.005, 8, false), matDark); legGroup.add(skid);
    const footGeo = new THREE.SphereGeometry(0.012, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const footMat = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.95, metalness: 0 });
    const fL = new THREE.Mesh(footGeo, footMat); fL.position.set(-0.12, 0, 0); fL.rotation.z = Math.PI / 2; legGroup.add(fL);
    const fR = new THREE.Mesh(footGeo, footMat); fR.position.set(0.12, 0, 0); fR.rotation.z = -Math.PI / 2; legGroup.add(fR);
    legGroup.position.set(side * 0.1, 0, 0); group.add(legGroup);
  }

  const props = [];
  const motorGeo = new THREE.CylinderGeometry(0.028, 0.032, 0.055, 16);
  const propGeo = new THREE.BoxGeometry(0.32, 0.002, 0.025);
  let i = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const mg = new THREE.Group();
      const motor = new THREE.Mesh(motorGeo, matMotor); motor.position.y = 0.17; motor.castShadow = true; mg.add(motor);
      for (let fin = 0; fin < 8; fin++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.01, 0.002), matDark);
        f.position.y = 0.195; f.rotation.y = (fin / 8) * Math.PI * 2; f.translateX(0.018); mg.add(f);
      }
      const mLed = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 8), i % 2 === 0 ? matLED : matLEDRed);
      mLed.position.set(sx * 0.03, 0.2, sz * 0.03); mg.add(mLed);
      const prop = new THREE.Mesh(propGeo, matProp); prop.position.set(0, 0.2, 0); prop.rotation.y = i * 0.7;
      prop.userData.spinDir = i % 2 === 0 ? 1 : -1; props.push(prop); mg.add(prop);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), i % 2 === 0 ? matLED : matLEDRed); tip.position.set(0.14, 0, 0); prop.add(tip);
      const guard = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.002, 6, 32),
        new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2, transparent: true, opacity: 0.3 }));
      guard.rotation.x = Math.PI / 2; guard.position.y = 0.2; mg.add(guard);
      mg.position.set(sx * 0.21, 0, sz * 0.21); group.add(mg); i++;
    }
  }

  // カメラジンバル
  const gimbal = new THREE.Group();
  const housing = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), matDark); housing.rotation.x = Math.PI; gimbal.add(housing);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.02, 12), matDark); barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.015; gimbal.add(barrel);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 16), matGlass); lens.position.z = 0.025; gimbal.add(lens);
  const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.01, 0.0015, 8, 16), new THREE.MeshPhysicalMaterial({ color: 0x444444, metalness: 0.9, roughness: 0.1 })); lensRing.position.z = 0.022; gimbal.add(lensRing);
  gimbal.position.set(0, 0.09, 0.06); group.add(gimbal);

  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.06, 4), matDark); ant.position.set(0, 0.22, -0.08); group.add(ant);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.003, 6, 6), new THREE.MeshPhysicalMaterial({ color: 0xff8800, emissive: 0xff4400, emissiveIntensity: 0.5 })); antTip.position.set(0, 0.25, -0.08); group.add(antTip);
  const statusLED = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), new THREE.MeshPhysicalMaterial({ color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 2.0, roughness: 0.05 })); statusLED.position.set(0, 0.09, -0.04); group.add(statusLED);

  return { group, props };
}

// ============================================
// 試験コース（実寸 13m×5m スクエア・A/B/C/D・H）— v4のパイロン意匠
// ============================================
const CORNERS = { A: [-6.5, 2.5], B: [6.5, 2.5], C: [6.5, -2.5], D: [-6.5, -2.5] };

function labelSprite(text) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 92px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,.72)'; g.strokeText(text, 64, 68);
  g.fillStyle = '#ffffff'; g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
  s.scale.set(1.5, 1.5, 1); return s;
}

function createCourseMarkers() {
  const group = new THREE.Group();
  const orangeMat = new THREE.MeshPhysicalMaterial({ color: 0xff5a1f, roughness: 0.3, metalness: 0.1, clearcoat: 0.4, clearcoatRoughness: 0.2 });
  const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xf5f5f0, roughness: 0.2, metalness: 0.05, clearcoat: 0.3 });

  function pylon(x, z, name) {
    const p = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.0, 24), orangeMat); cone.position.y = 0.5; cone.castShadow = true; p.add(cone);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 24), orangeMat); base.position.y = 0.02; base.castShadow = true; p.add(base);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.2, 24, 1, true), whiteMat); band.position.y = 0.5; p.add(band);
    const refl = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.05, 24, 1, true),
      new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.14, roughness: 0.1 }));
    refl.position.y = 0.35; p.add(refl);
    const lab = labelSprite(name); lab.position.set(0, 1.7, 0); p.add(lab);
    p.position.set(x, 0, z); return p;
  }
  for (const [name, [x, z]] of Object.entries(CORNERS)) group.add(pylon(x, z, name));

  // ガイド線（矩形 A-B-C-D）
  const guideMat = new THREE.MeshPhysicalMaterial({ color: 0xf5f2e8, transparent: true, opacity: 0.6, roughness: 0.3, metalness: 0.05, emissive: 0xf5f2e8, emissiveIntensity: 0.06 });
  const seq = [CORNERS.A, CORNERS.B, CORNERS.C, CORNERS.D, CORNERS.A];
  for (let i = 0; i < 4; i++) {
    const [x1, z1] = seq[i], [x2, z2] = seq[i + 1];
    const len = Math.hypot(x2 - x1, z2 - z1);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.06), guideMat);
    line.rotation.x = -Math.PI / 2; line.position.set((x1 + x2) / 2, 0.015, (z1 + z2) / 2);
    line.rotation.z = Math.atan2(z2 - z1, x2 - x1); line.receiveShadow = true; group.add(line);
  }

  // H 着陸円（中央）
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.05, 20, 64),
    new THREE.MeshPhysicalMaterial({ color: 0xf5f2e8, emissive: 0xf5f2e8, emissiveIntensity: 0.2, roughness: 0.2, metalness: 0.1, clearcoat: 0.5 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; group.add(ring);
  const hc = document.createElement('canvas'); hc.width = hc.height = 128;
  const hg = hc.getContext('2d'); hg.fillStyle = '#f5f2e8';
  hg.fillRect(34, 24, 14, 80); hg.fillRect(80, 24, 14, 80); hg.fillRect(34, 57, 60, 14);
  const ht = new THREE.CanvasTexture(hc); ht.colorSpace = THREE.SRGBColorSpace;
  const hmark = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2),
    new THREE.MeshBasicMaterial({ map: ht, transparent: true }));
  hmark.rotation.x = -Math.PI / 2; hmark.position.y = 0.022; group.add(hmark);

  return group;
}

// ============================================
// 体育館（v4 シネマ品質）
// ============================================
const GYM = { halfX: 18, halfZ: 14, height: 12 };

function createWoodTexture() {
  const size = 1024;
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b89060'; ctx.fillRect(0, 0, size, size);
  const plankH = 40;
  for (let row = 0; row < size / plankH; row++) {
    const tone = 10 * Math.sin(row * 12.9898) - 5;
    const r = 184 + tone, g = 144 + tone, b = 96 + tone * 0.5;
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, row * plankH, size, plankH - 2);
    ctx.strokeStyle = `rgba(${r - 35},${g - 45},${b - 55},0.2)`; ctx.lineWidth = 0.4;
    for (let gg = 0; gg < 4; gg++) {
      ctx.beginPath();
      const startX = (row * 137 + gg * 300) % size; ctx.moveTo(startX, row * plankH);
      for (let step = 0; step < 10; step++) {
        ctx.bezierCurveTo(startX + 40 + Math.sin(step * 1.3) * 30, row * plankH + plankH * (step + 1) / 10,
          startX - 30 + Math.cos(step * 0.7) * 25, row * plankH + plankH * (step + 1) / 10,
          startX + 15 + Math.sin(step * 1.7) * 35, row * plankH + plankH * (step + 1) / 10);
      }
      ctx.stroke();
    }
    if (row % 3 === 0) {
      const kx = ((row * 293) % 8) * (size / 8) + size / 16, ky = row * plankH + plankH / 2;
      ctx.fillStyle = `rgba(${r - 50},${g - 60},${b - 40},0.4)`;
      ctx.beginPath(); ctx.ellipse(kx, ky, 10, 6, 0.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(50,30,15,0.55)'; const joint = ((row * 97) % 8) * (size / 8); ctx.fillRect(joint, row * plankH, 4, plankH);
    ctx.fillStyle = 'rgba(30,18,10,0.7)'; ctx.fillRect(0, row * plankH + plankH - 2, size, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(10, 8); tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function createGymScene() {
  const g = new THREE.Group();
  scene.background = new THREE.Color(0x39332b);
  scene.fog = new THREE.FogExp2(0x39332b, 0.005);

  const mainSpot = new THREE.SpotLight(0xfff4e0, 40, 60, Math.PI / 5.5, 0.6, 1);
  mainSpot.position.set(0, 11, 0); mainSpot.target.position.set(0, 0, 0);
  mainSpot.castShadow = true; mainSpot.shadow.mapSize.set(SHADOW, SHADOW);
  mainSpot.shadow.camera.near = 0.5; mainSpot.shadow.camera.far = 40; mainSpot.shadow.bias = -0.00005; mainSpot.shadow.radius = 8; mainSpot.shadow.normalBias = 0.02;
  g.add(mainSpot, mainSpot.target);

  const rim1 = new THREE.SpotLight(0xd0e8ff, 34, 45, Math.PI / 6, 0.5, 1); rim1.position.set(-12, 10, 6); rim1.target.position.set(0, 0, 0); g.add(rim1, rim1.target);
  const rim2 = new THREE.SpotLight(0xffe8d0, 30, 45, Math.PI / 6, 0.5, 1); rim2.position.set(12, 10, -6); rim2.target.position.set(0, 0, 0); g.add(rim2, rim2.target);
  const bounce = new THREE.PointLight(0xfff0e0, 6, 22, 2); bounce.position.set(0, 0.5, 0); g.add(bounce);
  g.add(new THREE.HemisphereLight(0xfff4e0, 0x6a5d48, 0.95));
  g.add(new THREE.AmbientLight(0xfff3e8, 0.42)); // 室内を全体に明るく（暗い隅をなくす）

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2),
    new THREE.MeshStandardMaterial({ map: createWoodTexture(), roughness: 0.4, metalness: 0.03, envMapIntensity: 0.8 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);

  // コートライン
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf5f2e8, roughness: 0.15, metalness: 0.05, emissive: 0xf5f2e8, emissiveIntensity: 0.08 });
  const cW = 30, cD = 18, lw = 0.1;
  const addLine = (w, d, x, z) => { const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat); l.rotation.x = -Math.PI / 2; l.position.set(x, 0.008, z); g.add(l); };
  addLine(cW, lw, 0, -cD / 2); addLine(cW, lw, 0, cD / 2); addLine(lw, cD, -cW / 2, 0); addLine(lw, cD, cW / 2, 0);
  const centerCircle = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.9, 64), lineMat); centerCircle.rotation.x = -Math.PI / 2; centerCircle.position.y = 0.008; g.add(centerCircle);

  // 壁
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.85, side: THREE.DoubleSide });
  const wainscotMat = new THREE.MeshStandardMaterial({ color: 0x7a6a4a, roughness: 0.6, metalness: 0.08, side: THREE.DoubleSide });
  const walls = [
    { w: GYM.halfX * 2, x: 0, z: -GYM.halfZ, ry: 0 }, { w: GYM.halfX * 2, x: 0, z: GYM.halfZ, ry: Math.PI },
    { w: GYM.halfZ * 2, x: -GYM.halfX, z: 0, ry: Math.PI / 2 }, { w: GYM.halfZ * 2, x: GYM.halfX, z: 0, ry: -Math.PI / 2 }];
  for (const d of walls) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(d.w, GYM.height), wallMat); wall.position.set(d.x, GYM.height / 2, d.z); wall.rotation.y = d.ry; wall.receiveShadow = true; g.add(wall);
    const wain = new THREE.Mesh(new THREE.PlaneGeometry(d.w, 2.8), wainscotMat); wain.position.set(d.x, 1.4, d.z); wain.rotation.y = d.ry; wain.translateZ(0.04); g.add(wain);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(d.w, 0.08, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.3, metalness: 0.3 }));
    trim.position.set(d.x, 2.8, d.z); trim.rotation.y = d.ry; trim.translateZ(0.02); g.add(trim);
  }

  // 窓＋ボリューメトリック光
  // 窓＝発光しない不透明のすりガラス窓（Basic=ライティング非依存で黒穴にならない・壁を光源にしない）
  const windowMat = new THREE.MeshBasicMaterial({ color: 0x9aa2ac, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.3, metalness: 0.4 });
  for (const zSide of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.0), windowMat); win.position.set(i * 5.5, 7.5, zSide * (GYM.halfZ - 0.06)); win.rotation.y = zSide > 0 ? Math.PI : 0; g.add(win);
      // 枠は中空の4辺（塗りつぶしBoxでガラスを覆っていた不具合を修正）
      for (const [fw, fh, fx, fy] of [[3.2, 0.12, 0, 1.06], [3.2, 0.12, 0, -1.06], [0.12, 2.2, -1.56, 0], [0.12, 2.2, 1.56, 0]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.08), frameMat);
        bar.position.set(i * 5.5 + fx, 7.5 + fy, zSide * (GYM.halfZ - 0.04)); bar.rotation.y = zSide > 0 ? Math.PI : 0; g.add(bar);
      }
      for (let m = -1; m <= 1; m += 2) {
        const mul = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.0, 0.08), frameMat); mul.position.set(i * 5.5 + m * 0.5, 7.5, zSide * (GYM.halfZ - 0.03)); mul.rotation.y = zSide > 0 ? Math.PI : 0; g.add(mul);
      }
      // 窓からのボリューメトリック光錐＝壁光源は削除（要望により）
    }
  }

  // 天井＋トラス＋LEDパネル
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2), new THREE.MeshStandardMaterial({ color: 0xc0bcb0, roughness: 0.9 }));
  ceiling.rotation.x = Math.PI / 2; ceiling.position.y = GYM.height; g.add(ceiling);
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x5a5040, roughness: 0.5, metalness: 0.4 });
  for (let ix = -2; ix <= 2; ix++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, GYM.halfZ * 2), trussMat); b.position.set(ix * 7, GYM.height - 0.2, 0); b.castShadow = true; g.add(b); }
  for (let iz = -1; iz <= 1; iz++) { const b = new THREE.Mesh(new THREE.BoxGeometry(GYM.halfX * 2, 0.3, 0.3), trussMat); b.position.set(0, GYM.height - 0.15, iz * 5); b.castShadow = true; g.add(b); }
  const panelMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.05 });
  for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz += 2) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 2.0), panelMat); panel.rotation.x = Math.PI / 2; panel.position.set(ix * 10, GYM.height - 0.5, iz * 5); g.add(panel);
    const pl = new THREE.PointLight(0xfffff0, 12, 24, 2); pl.position.set(ix * 10, GYM.height - 0.8, iz * 5); g.add(pl);
  }

  // 柱
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6a6050, roughness: 0.5, metalness: 0.15 });
  for (const px of [-12, 0, 12]) for (const pz of [-10, 10]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, GYM.height, 16), pillarMat); pillar.position.set(px, GYM.height / 2, pz); pillar.castShadow = true; pillar.receiveShadow = true; g.add(pillar);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.3, 16), pillarMat); base.position.set(px, 0.15, pz); g.add(base);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.3, 16), pillarMat); cap.position.set(px, GYM.height - 0.15, pz); g.add(cap);
  }

  // バスケットゴール
  function hoop(x, z, rotY) {
    const grp = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.3, metalness: 0.8 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.8, 12), poleMat); pole.position.y = 1.9; pole.castShadow = true; grp.add(pole);
    const bb = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.04), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.75, transmission: 0.3, ior: 1.5 })); bb.position.set(0, 3.5, 0.15); bb.castShadow = true; grp.add(bb);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.012, 12, 32), new THREE.MeshStandardMaterial({ color: 0xff4000, roughness: 0.2, metalness: 0.7 })); rim.rotation.x = Math.PI / 2; rim.position.set(0, 3.05, 0.4); grp.add(rim);
    const net = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.15, 0.4, 16, 4, true), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.9, transparent: true, opacity: 0.3, side: THREE.DoubleSide })); net.position.set(0, 2.85, 0.4); grp.add(net);
    grp.position.set(x, 0, z); grp.rotation.y = rotY; return grp;
  }
  g.add(hoop(0, -GYM.halfZ + 1.5, 0)); g.add(hoop(0, GYM.halfZ - 1.5, Math.PI));

  // 観客席
  const blMat = new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 0.8 });
  for (let row = 0; row < 5; row++) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(20, 0.08, 0.6), blMat); bench.position.set(0, 0.4 + row * 0.4, -GYM.halfZ + 2 + row * 0.8); bench.castShadow = true; bench.receiveShadow = true; g.add(bench);
    for (const sxp of [-8, 8]) { const sup = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4 + row * 0.4, 0.5), blMat); sup.position.set(sxp, (0.4 + row * 0.4) / 2, -GYM.halfZ + 2 + row * 0.8); g.add(sup); }
  }

  return g;
}

// ============================================
// 屋外（v4 フライトシム品質）
// ============================================
function createOutdoorScene() {
  const g = new THREE.Group();
  scene.background = new THREE.Color(0x4a7aaa);
  scene.fog = new THREE.FogExp2(0x6a8aaa, 0.004);

  const sun = new THREE.DirectionalLight(0xfff4d8, 2.5);
  sun.position.set(-40, 50, 30); sun.castShadow = true; sun.shadow.mapSize.set(SHADOW, SHADOW);
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -60; sun.shadow.camera.right = 60; sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
  sun.shadow.bias = -0.00005; sun.shadow.radius = 6; sun.shadow.normalBias = 0.02; g.add(sun);

  const sunPos = sun.position.clone().normalize().multiplyScalar(150);
  const sunCore = new THREE.Mesh(new THREE.SphereGeometry(3, 32, 32), new THREE.MeshBasicMaterial({ color: 0xfff8e0 })); sunCore.position.copy(sunPos); g.add(sunCore);
  for (let i = 1; i <= 6; i++) {
    const corona = new THREE.Mesh(new THREE.SphereGeometry(3 + i * 3, 24, 24), new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0.06 / i, blending: THREE.AdditiveBlending, depthWrite: false }));
    corona.position.copy(sunPos); g.add(corona);
  }
  g.add(new THREE.HemisphereLight(0x87b8d8, 0x3a5a2a, 0.5));
  const fill = new THREE.DirectionalLight(0xa8c8f0, 0.35); fill.position.set(30, 30, -30); g.add(fill);
  const rim = new THREE.DirectionalLight(0xffd8a0, 0.22); rim.position.set(50, 15, -50); g.add(rim);

  // 地形
  const tGeo = new THREE.PlaneGeometry(400, 400, 120, 120);
  const pos = tGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getY(i);
    let h = Math.sin(x * 0.01) * Math.cos(z * 0.01) * 2 + Math.sin(x * 0.03 + 1.5) * Math.cos(z * 0.02 + 0.7) + Math.sin(x * 0.05) * Math.sin(z * 0.04) * 0.5;
    const d = Math.sqrt(x * x + z * z);
    h *= Math.min(1, Math.max(0, (d - 15) / 20));
    pos.setZ(i, h);
  }
  tGeo.computeVertexNormals();
  const tCanvas = document.createElement('canvas'); tCanvas.width = tCanvas.height = 1024;
  const tctx = tCanvas.getContext('2d'); tctx.fillStyle = '#5a8a3a'; tctx.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 12000; i++) {
    const px = Math.random() * 1024, py = Math.random() * 1024, h = 2 + Math.random() * 5, tilt = (Math.random() - 0.5) * 2;
    const br = Math.random() > 0.5 ? 1.0 : 0.85;
    tctx.strokeStyle = `rgba(${Math.floor(80 * br)},${Math.floor(130 * br)},${Math.floor(40 * br)},0.5)`; tctx.lineWidth = 0.5 + Math.random();
    tctx.beginPath(); tctx.moveTo(px, py); tctx.lineTo(px + tilt, py - h); tctx.stroke();
  }
  const tTex = new THREE.CanvasTexture(tCanvas); tTex.wrapS = tTex.wrapT = THREE.RepeatWrapping; tTex.repeat.set(20, 20); tTex.colorSpace = THREE.SRGBColorSpace; tTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardMaterial({ map: tTex, roughness: 0.9, color: 0x5a8a3a }));
  terrain.rotation.x = -Math.PI / 2; terrain.receiveShadow = true; g.add(terrain);

  // 湖
  const lake = new THREE.Mesh(new THREE.PlaneGeometry(50, 35, 32, 32),
    new THREE.MeshPhysicalMaterial({ color: 0x1a5a8a, roughness: 0.02, metalness: 0.1, transparent: true, opacity: 0.85, transmission: 0.4, clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 2.0 }));
  lake.rotation.x = -Math.PI / 2; lake.position.set(-50, -0.3, -40); g.add(lake);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 0.9, metalness: 0.1 });
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + Math.random() * 0.6, 0), rockMat);
    rock.position.set(-50 + Math.cos(a) * (26 + Math.random() * 4), 0.1, -40 + Math.sin(a) * (26 + Math.random() * 4));
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3); rock.castShadow = true; g.add(rock);
  }

  // 山
  const mtColors = [0x3a4a5a, 0x4a5a6a, 0x5a6a5a, 0x6a7a6a];
  const mtPos = [[-80, -80, 60, 25], [-60, -90, 50, 22], [-100, -60, 70, 28], [80, -90, 55, 24], [100, -70, 65, 26], [60, -100, 45, 20], [-90, 60, 50, 23], [90, 80, 55, 25], [70, 90, 40, 18]];
  for (const [mx, mz, h, r] of mtPos) {
    const mt = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), new THREE.MeshStandardMaterial({ color: mtColors[Math.floor(Math.random() * 4)], roughness: 0.95 }));
    mt.position.set(mx, h / 2 - 2, mz); mt.castShadow = true; g.add(mt);
    if (h > 50) { const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.35, h * 0.25, 8), new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.1 })); cap.position.set(mx, h * 0.85 - 2, mz); g.add(cap); }
  }
  for (let layer = 0; layer < 4; layer++) {
    const mr = new THREE.Mesh(new THREE.CylinderGeometry(180 - layer * 20, 180 - layer * 20, 20 + layer * 5, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.6, 0.2, 0.3 + layer * 0.1), roughness: 0.95, side: THREE.BackSide, transparent: true, opacity: 0.8 - layer * 0.15 }));
    mr.position.y = 8 + layer * 3; g.add(mr);
  }

  // 木
  function tree(x, z, scale, type) {
    const t = new THREE.Group();
    const trunkCols = [0x4a3525, 0x5a4030, 0x3a2a1a, 0x6a5040];
    const trunkMat = new THREE.MeshStandardMaterial({ color: trunkCols[type % 4], roughness: 0.9 });
    const th = (3 + Math.random() * 2) * scale;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * scale, 0.14 * scale, th, 10), trunkMat); trunk.position.y = th / 2; trunk.castShadow = true; t.add(trunk);
    const branchN = 3 + Math.floor(Math.random() * 3);
    for (let b = 0; b < branchN; b++) {
      const bl = (0.8 + Math.random() * 0.8) * scale, ba = (b / branchN) * Math.PI * 2 + Math.random() * 0.5;
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.015 * scale, 0.03 * scale, bl, 6), trunkMat);
      br.position.set(Math.cos(ba) * 0.3 * scale, th * 0.5 + b * th * 0.15, Math.sin(ba) * 0.3 * scale); br.rotation.z = Math.cos(ba) * 0.6; br.rotation.x = Math.sin(ba) * 0.6; br.castShadow = true; t.add(br);
    }
    const palettes = [[0x2a5a1a, 0x3a6a2a, 0x1a4a10, 0x4a7a3a], [0x3a5a2a, 0x4a6a3a, 0x2a4a20, 0x5a7a4a], [0x1a4a1a, 0x2a5a2a, 0x0a3a0a, 0x3a6a3a], [0x4a6a2a, 0x5a7a3a, 0x3a5a1a, 0x6a8a4a]];
    const pal = palettes[type % 4];
    const folN = 7 + Math.floor(Math.random() * 6);
    for (let l = 0; l < folN; l++) {
      const lm = new THREE.MeshStandardMaterial({ color: pal[l % pal.length], roughness: 0.7 });
      const sz = (0.5 + Math.random() * 0.8) * scale;
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(sz, 0), lm);
      leaf.position.set((Math.random() - 0.5) * 2 * scale, (th + Math.random() * 2.5) * scale, (Math.random() - 0.5) * 2 * scale);
      leaf.castShadow = true; leaf.userData.isFoliage = true; leaf.userData.basePos = leaf.position.clone(); leaf.userData.phase = Math.random() * Math.PI * 2; t.add(leaf);
    }
    t.position.set(x, 0, z); return t;
  }
  const forests = [{ x: -35, z: -30, c: 8, s: 1.2 }, { x: 40, z: -35, c: 6, s: 1.0 }, { x: -45, z: 25, c: 9, s: 1.1 }, { x: 50, z: 30, c: 5, s: 0.9 }, { x: -25, z: 45, c: 7, s: 1.3 }, { x: 35, z: 45, c: 6, s: 1.1 }, { x: -55, z: -10, c: 5, s: 1.0 }, { x: 55, z: -15, c: 4, s: 0.8 }, { x: -15, z: -55, c: 6, s: 1.1 }, { x: 25, z: -50, c: 5, s: 1.0 }];
  let tt = 0;
  for (const f of forests) for (let i = 0; i < f.c; i++) {
    const a = (i / f.c) * Math.PI * 2 + Math.random() * 0.5, d = 3 + Math.random() * 8;
    g.add(tree(f.x + Math.cos(a) * d, f.z + Math.sin(a) * d, f.s * (0.8 + Math.random() * 0.4), tt++));
  }

  // 風車
  const wm = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.0, 14, 8), new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.8 })); tower.position.y = 7; tower.castShadow = true; wm.add(tower);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.5, 8), new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.6 })); cap.position.y = 14.5; wm.add(cap);
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.2 })); hub.position.set(0, 13.5, 0.8); wm.add(hub);
  const bladeGroup = new THREE.Group(); bladeGroup.position.set(0, 13.5, 0.8);
  for (let i = 0; i < 3; i++) { const blade = new THREE.Mesh(new THREE.BoxGeometry(0.25, 9, 0.04), new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.3 })); blade.position.y = 4.5; const bc = new THREE.Group(); bc.add(blade); bc.rotation.z = (i / 3) * Math.PI * 2; bladeGroup.add(bc); }
  wm.add(bladeGroup); wm.userData.bladeGroup = bladeGroup; wm.position.set(60, 0, -20); g.add(wm);

  // 雲
  function cloud(x, y, z, scale) {
    const c = new THREE.Group();
    const cm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, transparent: true, opacity: 0.9, emissive: 0xffffff, emissiveIntensity: 0.15, depthWrite: false });
    for (const [cx, cy, cz, cr] of [[0, 0, 0, 2.5], [1.8, 0.4, 0.3, 1.8], [-1.5, -0.1, 0.4, 2.0], [0.5, 0.8, -0.3, 1.4], [1.3, -0.4, 0.6, 1.2], [-0.7, 0.5, -0.4, 1.6], [2.2, 0.2, -0.2, 1.0], [-2.0, 0.3, 0.2, 1.3]]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(cr * scale, 10, 10), cm); b.position.set(cx * scale, cy * scale, cz * scale); c.add(b);
    }
    c.position.set(x, y, z); return c;
  }
  for (const [cx, cy, cz, cs] of [[-30, 28, -50, 2.0], [40, 32, -60, 1.6], [10, 26, -70, 2.2], [-50, 30, -40, 1.4], [60, 28, -55, 1.8], [-20, 34, -65, 1.5], [30, 30, -45, 1.3], [-60, 26, -60, 1.7]]) g.add(cloud(cx, cy, cz, cs));

  // 花
  function flower(x, z, type) {
    const f = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.004, 0.25, 6), new THREE.MeshStandardMaterial({ color: 0x3a6a2a, roughness: 0.8 })); stem.position.y = 0.125; f.add(stem);
    const colors = [[0xff6b9d, 0xff8fab], [0xffd93d, 0xffe066], [0xffffff, 0xf0f0f0], [0x9b59b6, 0xb07cc6], [0xe74c3c, 0xec7063], [0x3498db, 0x5dade2]];
    const [c1, c2] = colors[type % colors.length];
    for (let p = 0; p < 6; p++) { const petal = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), new THREE.MeshStandardMaterial({ color: c1, roughness: 0.5 })); const a = (p / 6) * Math.PI * 2; petal.position.set(Math.cos(a) * 0.03, 0.28, Math.sin(a) * 0.03); petal.scale.set(1, 0.5, 1); f.add(petal); }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 8), new THREE.MeshStandardMaterial({ color: c2, roughness: 0.4 })); center.position.y = 0.28; f.add(center);
    f.position.set(x, 0, z); return f;
  }
  for (let i = 0; i < 60; i++) { const a = Math.random() * Math.PI * 2, d = 5 + Math.random() * 35; g.add(flower(Math.cos(a) * d, Math.sin(a) * d, i)); }

  // 草
  function grassTuft(x, z) {
    const tuft = new THREE.Group();
    const gm = new THREE.MeshStandardMaterial({ color: 0x4a7a2a, roughness: 0.9, side: THREE.DoubleSide });
    for (let gg = 0; gg < 5; gg++) { const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.15 + Math.random() * 0.1), gm); blade.position.set((Math.random() - 0.5) * 0.08, 0.05 + Math.random() * 0.05, (Math.random() - 0.5) * 0.08); blade.rotation.y = Math.random() * Math.PI; blade.userData.isGrass = true; blade.userData.phase = Math.random() * Math.PI * 2; tuft.add(blade); }
    tuft.position.set(x, 0, z); return tuft;
  }
  for (let i = 0; i < 140; i++) { const a = Math.random() * Math.PI * 2, d = 3 + Math.random() * 40; g.add(grassTuft(Math.cos(a) * d, Math.sin(a) * d)); }

  // フェンス
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.8 });
  for (let i = -20; i <= 20; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), fenceMat); post.position.set(i * 2, 0.3, 30); post.castShadow = true; g.add(post);
    if (i < 20) { const rail = new THREE.Mesh(new THREE.BoxGeometry(2, 0.04, 0.03), fenceMat); rail.position.set(i * 2 + 1, 0.45, 30); g.add(rail); const rail2 = rail.clone(); rail2.position.y = 0.25; g.add(rail2); }
  }

  return g;
}

// ============================================
// 組み立て
// ============================================
let activeGroup, foliageWind = false;
try {
  activeGroup = sceneMode === 'outdoor' ? createOutdoorScene() : createGymScene();
  scene.add(activeGroup);
  foliageWind = sceneMode === 'outdoor';
  const course = createCourseMarkers(); scene.add(course);
  const drone = createDrone();
  drone.group.position.set(0, 1.55, 0); drone.group.rotation.set(0.03, 0.5, -0.02);
  scene.add(drone.group);
  window.__DRONE = drone;
  document.getElementById('label').innerHTML =
    `シネマ・プレビュー（v4参考）<span class="sub">　${sceneMode === 'outdoor' ? '屋外' : '体育館'} / ${view}</span>`;
  window.__READY_BUILD = true;
} catch (e) {
  console.error('BUILD ERROR', e); window.__ERR = String(e && e.stack || e);
}

// ブロブ影（v4）
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
blob.rotation.x = -Math.PI / 2; blob.position.set(0, 0.014, 0); scene.add(blob);

// カメラ
if (view === 'pov') {
  if (sceneMode === 'outdoor') { camera.position.set(0, 1.65, 10.5); controls.target.set(0, 1.4, -1.5); }
  else { camera.position.set(0, 1.65, 8.8); controls.target.set(0, 1.35, -1.5); } // 柱(z=10)の手前に立つ
} else if (sceneMode === 'outdoor') { camera.position.set(13, 8.5, 16); controls.target.set(0, 1.1, 0); }
else { camera.position.set(9, 6, 12); controls.target.set(0, 0.9, -0.5); }
camera.lookAt(controls.target);
controls.update();

// ============================================
// アニメーション＋実測fps＋描画統計
// ============================================
let t = 0, last = performance.now(), fpsSamples = [];
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;

  const drone = window.__DRONE;
  if (drone) for (const p of drone.props) p.rotation.y = t * 15 * p.userData.spinDir;

  if (foliageWind && activeGroup) {
    activeGroup.traverse((o) => {
      if (o.userData.isFoliage && o.userData.basePos) { o.position.x = o.userData.basePos.x + Math.sin(t * 2 + o.userData.phase) * 0.05; o.position.z = o.userData.basePos.z + Math.cos(t * 1.5 + o.userData.phase) * 0.03; }
      if (o.userData.isGrass) o.rotation.z = Math.sin(t * 3 + o.userData.phase) * 0.1;
      if (o.userData.bladeGroup) o.userData.bladeGroup.rotation.z += dt * 0.5;
    });
  }

  controls.update();
  composer.render();

  if (t > 1.0) { fpsSamples.push(1 / dt); if (fpsSamples.length > 120) fpsSamples.shift(); }
  if (t > 2.2 && !window.__STATS) {
    const sorted = [...fpsSamples].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    let meshes = 0, tris = 0;
    scene.traverse((o) => {
      if (o.isMesh && o.geometry) {
        meshes++;
        const gp = o.geometry;
        if (gp.index) tris += gp.index.count / 3;
        else if (gp.attributes.position) tris += gp.attributes.position.count / 3;
      }
    });
    window.__STATS = {
      fpsMedian: Math.round(median),
      meshes,
      triangles: Math.round(tris),
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    };
    window.__READY = true;
  }
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight); ssaoPass.setSize(window.innerWidth, window.innerHeight);
});
