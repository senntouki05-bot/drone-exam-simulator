/**
 * render/Scene.ts — シーン生成: 体育館（屋内・既定）と屋外（フライトシム調）。
 *
 * drone_simulator_v4.html を参考にした「シネマ品質」版（2026-07-20 デザイン刷新・代表承認）。
 * PBR材質＋シャドウマップ＋手続きHDRI環境マップ（PMREMはmain.tsで適用）＋情景（体育館=柱/
 * 観客席/ゴール/トラス、屋外=起伏地形/湖/山/並木/風車/雲/花/草）。ポストプロセス（SSAO/Bloom）
 * とトーンマッピングは main.ts の EffectComposer 側で行う。
 *
 * 見た目だけのモジュール。コース設置物（パイロン・H円・区画帯・ガイド線）は CourseMarkers が
 * data/courses/*.json 駆動で載せる（採点とは無関係）。地面はコース中心付近を平らに保つ（y=0）。
 * 草は InstancedMesh 1本にまとめて描画（ドローコール削減）。
 */

import * as THREE from 'three';

/** 体育館の内寸 [m] */
export const GYM = {
  halfX: 18,
  halfZ: 14,
  height: 12,
} as const;

// ============================================================
// 環境マップ用の手続きHDRI（PMREM化は main.ts）
// ============================================================
/** 空↔地のグラデーション＋太陽ハイライトの等距円筒HDRI（外部アセットなし）。 */
export function createEnvHDRI(): THREE.DataTexture {
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
      let r: number, g: number, b: number;
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
      const dist = Math.sqrt((u - 0.65) ** 2 + (v - 0.72) ** 2);
      const sun = Math.exp(-dist * dist * 300) * 14;
      data[i] = r + sun * 1.4;
      data[i + 1] = g + sun * 1.3;
      data[i + 2] = b + sun * 1.1;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================
// テクスチャ生成（Canvas・外部アセットなし）
// ============================================================
function createWoodTexture(anisotropy: number): THREE.Texture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b89060';
  ctx.fillRect(0, 0, size, size);
  const plankH = 40;
  for (let row = 0; row < size / plankH; row++) {
    const tone = 10 * Math.sin(row * 12.9898) - 5;
    const r = 184 + tone;
    const g = 144 + tone;
    const b = 96 + tone * 0.5;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, row * plankH, size, plankH - 2);
    ctx.strokeStyle = `rgba(${r - 35},${g - 45},${b - 55},0.2)`;
    ctx.lineWidth = 0.4;
    for (let gg = 0; gg < 4; gg++) {
      ctx.beginPath();
      const startX = (row * 137 + gg * 300) % size;
      ctx.moveTo(startX, row * plankH);
      for (let step = 0; step < 10; step++) {
        ctx.bezierCurveTo(
          startX + 40 + Math.sin(step * 1.3) * 30,
          row * plankH + (plankH * (step + 1)) / 10,
          startX - 30 + Math.cos(step * 0.7) * 25,
          row * plankH + (plankH * (step + 1)) / 10,
          startX + 15 + Math.sin(step * 1.7) * 35,
          row * plankH + (plankH * (step + 1)) / 10,
        );
      }
      ctx.stroke();
    }
    if (row % 3 === 0) {
      const kx = ((row * 293) % 8) * (size / 8) + size / 16;
      const ky = row * plankH + plankH / 2;
      ctx.fillStyle = `rgba(${r - 50},${g - 60},${b - 40},0.4)`;
      ctx.beginPath();
      ctx.ellipse(kx, ky, 10, 6, 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(50,30,15,0.55)';
    const joint = ((row * 97) % 8) * (size / 8);
    ctx.fillRect(joint, row * plankH, 4, plankH);
    ctx.fillStyle = 'rgba(30,18,10,0.7)';
    ctx.fillRect(0, row * plankH + plankH - 2, size, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function createTerrainTexture(anisotropy: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#5a8a3a';
  ctx.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 12000; i++) {
    const px = Math.random() * 1024;
    const py = Math.random() * 1024;
    const h = 2 + Math.random() * 5;
    const tilt = (Math.random() - 0.5) * 2;
    const br = Math.random() > 0.5 ? 1.0 : 0.85;
    ctx.strokeStyle = `rgba(${Math.floor(80 * br)},${Math.floor(130 * br)},${Math.floor(40 * br)},0.5)`;
    ctx.lineWidth = 0.5 + Math.random();
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + tilt, py - h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

// ============================================================
// 体育館（シネマ品質・明るい室内・壁は光源にしない）
// ============================================================
export function createGymScene(anisotropy = 4): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x39332b);
  scene.fog = new THREE.FogExp2(0x39332b, 0.005);

  // --- 照明（室内を全体に明るく・中央スポットは均一なダウンライト） ---
  const mainSpot = new THREE.SpotLight(0xfff4e0, 40, 60, Math.PI / 5.5, 0.6, 1);
  mainSpot.position.set(0, 11, 0);
  mainSpot.target.position.set(0, 0, 0);
  mainSpot.castShadow = true;
  mainSpot.shadow.mapSize.set(2048, 2048);
  mainSpot.shadow.camera.near = 0.5;
  mainSpot.shadow.camera.far = 40;
  mainSpot.shadow.bias = -0.00005;
  mainSpot.shadow.radius = 8;
  mainSpot.shadow.normalBias = 0.02;
  scene.add(mainSpot, mainSpot.target);

  const rim1 = new THREE.SpotLight(0xd0e8ff, 34, 45, Math.PI / 6, 0.5, 1);
  rim1.position.set(-12, 10, 6);
  rim1.target.position.set(0, 0, 0);
  scene.add(rim1, rim1.target);
  const rim2 = new THREE.SpotLight(0xffe8d0, 30, 45, Math.PI / 6, 0.5, 1);
  rim2.position.set(12, 10, -6);
  rim2.target.position.set(0, 0, 0);
  scene.add(rim2, rim2.target);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6a5d48, 0.95));
  scene.add(new THREE.AmbientLight(0xfff3e8, 0.42));

  // --- 床 ---
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2),
    new THREE.MeshStandardMaterial({
      map: createWoodTexture(anisotropy),
      roughness: 0.4,
      metalness: 0.03,
      envMapIntensity: 0.8,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- コートライン（装飾。H円・経路白線はCourseMarkersが描く） ---
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xf5f2e8,
    roughness: 0.15,
    metalness: 0.05,
    emissive: 0xf5f2e8,
    emissiveIntensity: 0.08,
  });
  const cW = 30;
  const cD = 18;
  const lw = 0.1;
  const addLine = (w: number, d: number, x: number, z: number): void => {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
    l.rotation.x = -Math.PI / 2;
    l.position.set(x, 0.008, z);
    scene.add(l);
  };
  addLine(cW, lw, 0, -cD / 2);
  addLine(cW, lw, 0, cD / 2);
  addLine(lw, cD, -cW / 2, 0);
  addLine(lw, cD, cW / 2, 0);
  const centerCircle = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.9, 64), lineMat);
  centerCircle.rotation.x = -Math.PI / 2;
  centerCircle.position.y = 0.008;
  scene.add(centerCircle);

  // --- 壁（腰壁つき） ---
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xd8d2c0,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const wainscotMat = new THREE.MeshStandardMaterial({
    color: 0x7a6a4a,
    roughness: 0.6,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  const walls = [
    { w: GYM.halfX * 2, x: 0, z: -GYM.halfZ, ry: 0 },
    { w: GYM.halfX * 2, x: 0, z: GYM.halfZ, ry: Math.PI },
    { w: GYM.halfZ * 2, x: -GYM.halfX, z: 0, ry: Math.PI / 2 },
    { w: GYM.halfZ * 2, x: GYM.halfX, z: 0, ry: -Math.PI / 2 },
  ];
  for (const d of walls) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(d.w, GYM.height), wallMat);
    wall.position.set(d.x, GYM.height / 2, d.z);
    wall.rotation.y = d.ry;
    wall.receiveShadow = true;
    scene.add(wall);
    const wain = new THREE.Mesh(new THREE.PlaneGeometry(d.w, 2.8), wainscotMat);
    wain.position.set(d.x, 1.4, d.z);
    wain.rotation.y = d.ry;
    wain.translateZ(0.04);
    scene.add(wain);
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(d.w, 0.08, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.3, metalness: 0.3 }),
    );
    trim.position.set(d.x, 2.8, d.z);
    trim.rotation.y = d.ry;
    trim.translateZ(0.02);
    scene.add(trim);
  }

  // --- 窓（発光しないすりガラス＝壁を光源にしない・中空フレーム＋桟） ---
  const windowMat = new THREE.MeshBasicMaterial({ color: 0x9aa2ac, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.3, metalness: 0.4 });
  for (const zSide of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.0), windowMat);
      win.position.set(i * 5.5, 7.5, zSide * (GYM.halfZ - 0.06));
      win.rotation.y = zSide > 0 ? Math.PI : 0;
      scene.add(win);
      for (const [fw, fh, fx, fy] of [
        [3.2, 0.12, 0, 1.06],
        [3.2, 0.12, 0, -1.06],
        [0.12, 2.2, -1.56, 0],
        [0.12, 2.2, 1.56, 0],
      ]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.08), frameMat);
        bar.position.set(i * 5.5 + fx, 7.5 + fy, zSide * (GYM.halfZ - 0.04));
        bar.rotation.y = zSide > 0 ? Math.PI : 0;
        scene.add(bar);
      }
      for (let m = -1; m <= 1; m += 2) {
        const mul = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.0, 0.08), frameMat);
        mul.position.set(i * 5.5 + m * 0.5, 7.5, zSide * (GYM.halfZ - 0.05));
        mul.rotation.y = zSide > 0 ? Math.PI : 0;
        scene.add(mul);
      }
    }
  }

  // --- 天井＋トラス＋LEDパネル ---
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2),
    new THREE.MeshStandardMaterial({ color: 0xc0bcb0, roughness: 0.9 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = GYM.height;
  scene.add(ceiling);
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x5a5040, roughness: 0.5, metalness: 0.4 });
  for (let ix = -2; ix <= 2; ix++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, GYM.halfZ * 2), trussMat);
    b.position.set(ix * 7, GYM.height - 0.2, 0);
    b.castShadow = true;
    scene.add(b);
  }
  for (let iz = -1; iz <= 1; iz++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(GYM.halfX * 2, 0.3, 0.3), trussMat);
    b.position.set(0, GYM.height - 0.15, iz * 5);
    b.castShadow = true;
    scene.add(b);
  }
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.3,
    roughness: 0.05,
  });
  for (let ix = -1; ix <= 1; ix++) {
    for (let iz = -1; iz <= 1; iz += 2) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 2.0), panelMat);
      panel.rotation.x = Math.PI / 2;
      panel.position.set(ix * 10, GYM.height - 0.5, iz * 5);
      scene.add(panel);
      const pl = new THREE.PointLight(0xfffff0, 12, 24, 2);
      pl.position.set(ix * 10, GYM.height - 0.8, iz * 5);
      scene.add(pl);
    }
  }

  // --- 柱 ---
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6a6050, roughness: 0.5, metalness: 0.15 });
  for (const px of [-12, 0, 12]) {
    for (const pz of [-10, 10]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, GYM.height, 16), pillarMat);
      pillar.position.set(px, GYM.height / 2, pz);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      scene.add(pillar);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.3, 16), pillarMat);
      base.position.set(px, 0.15, pz);
      scene.add(base);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.3, 16), pillarMat);
      cap.position.set(px, GYM.height - 0.15, pz);
      scene.add(cap);
    }
  }

  // --- バスケットゴール ---
  const hoop = (x: number, z: number, rotY: number): THREE.Group => {
    const grp = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.3, metalness: 0.8 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.8, 12), poleMat);
    pole.position.y = 1.9;
    pole.castShadow = true;
    grp.add(pole);
    const bb = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 1.05, 0.04),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.05,
        transparent: true,
        opacity: 0.75,
        transmission: 0.3,
        ior: 1.5,
      }),
    );
    bb.position.set(0, 3.5, 0.15);
    grp.add(bb);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.23, 0.012, 12, 32),
      new THREE.MeshStandardMaterial({ color: 0xff4000, roughness: 0.2, metalness: 0.7 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 3.05, 0.4);
    grp.add(rim);
    const net = new THREE.Mesh(
      new THREE.CylinderGeometry(0.23, 0.15, 0.4, 16, 4, true),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.9,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      }),
    );
    net.position.set(0, 2.85, 0.4);
    grp.add(net);
    grp.position.set(x, 0, z);
    grp.rotation.y = rotY;
    return grp;
  };
  scene.add(hoop(0, -GYM.halfZ + 1.5, 0));
  scene.add(hoop(0, GYM.halfZ - 1.5, Math.PI));

  // --- 観客席 ---
  const blMat = new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 0.8 });
  for (let row = 0; row < 5; row++) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(20, 0.08, 0.6), blMat);
    bench.position.set(0, 0.4 + row * 0.4, -GYM.halfZ + 2 + row * 0.8);
    bench.castShadow = true;
    bench.receiveShadow = true;
    scene.add(bench);
    for (const sxp of [-8, 8]) {
      const sup = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4 + row * 0.4, 0.5), blMat);
      sup.position.set(sxp, (0.4 + row * 0.4) / 2, -GYM.halfZ + 2 + row * 0.8);
      scene.add(sup);
    }
  }

  return scene;
}

// ============================================================
// 屋外（フライトシム調・起伏地形/湖/山/並木/風車/雲/花/草）
// ============================================================
export function createOutdoorScene(anisotropy = 4): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x4a7aaa);
  scene.fog = new THREE.FogExp2(0x6a8aaa, 0.006);

  const sun = new THREE.DirectionalLight(0xfff4d8, 2.5);
  sun.position.set(-40, 50, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.bias = -0.00005;
  sun.shadow.radius = 6;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const sunPos = sun.position.clone().normalize().multiplyScalar(150);
  const sunCore = new THREE.Mesh(
    new THREE.SphereGeometry(3, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff8e0 }),
  );
  sunCore.position.copy(sunPos);
  scene.add(sunCore);
  for (let i = 1; i <= 6; i++) {
    const corona = new THREE.Mesh(
      new THREE.SphereGeometry(3 + i * 3, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfff4d0,
        transparent: true,
        opacity: 0.06 / i,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    corona.position.copy(sunPos);
    scene.add(corona);
  }
  scene.add(new THREE.HemisphereLight(0x87b8d8, 0x3a5a2a, 0.5));
  const fill = new THREE.DirectionalLight(0xa8c8f0, 0.35);
  fill.position.set(30, 30, -30);
  scene.add(fill);
  const rimL = new THREE.DirectionalLight(0xffd8a0, 0.22);
  rimL.position.set(50, 15, -50);
  scene.add(rimL);

  // --- 起伏地形（中心はコース用に平ら） ---
  const tGeo = new THREE.PlaneGeometry(400, 400, 120, 120);
  const pos = tGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    let h =
      Math.sin(x * 0.01) * Math.cos(z * 0.01) * 2 +
      Math.sin(x * 0.03 + 1.5) * Math.cos(z * 0.02 + 0.7) +
      Math.sin(x * 0.05) * Math.sin(z * 0.04) * 0.5;
    const d = Math.sqrt(x * x + z * z);
    h *= Math.min(1, Math.max(0, (d - 15) / 20));
    pos.setZ(i, h);
  }
  tGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(
    tGeo,
    new THREE.MeshStandardMaterial({ map: createTerrainTexture(anisotropy), roughness: 0.9, color: 0x5a8a3a }),
  );
  terrain.rotation.x = -Math.PI / 2;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // --- 湖 ---
  const lake = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 35, 32, 32),
    new THREE.MeshPhysicalMaterial({
      color: 0x1a5a8a,
      roughness: 0.02,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
      transmission: 0.4,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      envMapIntensity: 2.0,
    }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(-50, -0.3, -40);
  scene.add(lake);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a7a7a, roughness: 0.9, metalness: 0.1 });
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + Math.random() * 0.6, 0), rockMat);
    rock.position.set(
      -50 + Math.cos(a) * (26 + Math.random() * 4),
      0.1,
      -40 + Math.sin(a) * (26 + Math.random() * 4),
    );
    rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    rock.castShadow = true;
    scene.add(rock);
  }

  // --- 山 ---
  const mtColors = [0x3a4a5a, 0x4a5a6a, 0x5a6a5a, 0x6a7a6a];
  const mtPos = [
    [-80, -80, 60, 25],
    [-60, -90, 50, 22],
    [-100, -60, 70, 28],
    [80, -90, 55, 24],
    [100, -70, 65, 26],
    [60, -100, 45, 20],
    [-90, 60, 50, 23],
    [90, 80, 55, 25],
    [70, 90, 40, 18],
  ];
  for (const [mx, mz, h, r] of mtPos) {
    const mt = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 8),
      new THREE.MeshStandardMaterial({ color: mtColors[Math.floor(Math.random() * 4)], roughness: 0.95 }),
    );
    mt.position.set(mx, h / 2 - 2, mz);
    mt.castShadow = true;
    scene.add(mt);
    if (h > 50) {
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.35, h * 0.25, 8),
        new THREE.MeshStandardMaterial({
          color: 0xf0f0f0,
          roughness: 0.4,
          emissive: 0xffffff,
          emissiveIntensity: 0.1,
        }),
      );
      cap.position.set(mx, h * 0.85 - 2, mz);
      scene.add(cap);
    }
  }
  for (let layer = 0; layer < 4; layer++) {
    const mr = new THREE.Mesh(
      new THREE.CylinderGeometry(180 - layer * 20, 180 - layer * 20, 20 + layer * 5, 48, 1, true),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.6, 0.2, 0.3 + layer * 0.1),
        roughness: 0.95,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.8 - layer * 0.15,
      }),
    );
    mr.position.y = 8 + layer * 3;
    scene.add(mr);
  }

  // --- 木（風で揺れる葉を userData でマーク） ---
  const tree = (x: number, z: number, scale: number, type: number): THREE.Group => {
    const t = new THREE.Group();
    const trunkCols = [0x4a3525, 0x5a4030, 0x3a2a1a, 0x6a5040];
    const trunkMat = new THREE.MeshStandardMaterial({ color: trunkCols[type % 4], roughness: 0.9 });
    const th = (3 + Math.random() * 2) * scale;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * scale, 0.14 * scale, th, 10), trunkMat);
    trunk.position.y = th / 2;
    trunk.castShadow = true;
    t.add(trunk);
    const branchN = 3 + Math.floor(Math.random() * 3);
    for (let b = 0; b < branchN; b++) {
      const bl = (0.8 + Math.random() * 0.8) * scale;
      const ba = (b / branchN) * Math.PI * 2 + Math.random() * 0.5;
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.015 * scale, 0.03 * scale, bl, 6), trunkMat);
      br.position.set(Math.cos(ba) * 0.3 * scale, th * 0.5 + b * th * 0.15, Math.sin(ba) * 0.3 * scale);
      br.rotation.z = Math.cos(ba) * 0.6;
      br.rotation.x = Math.sin(ba) * 0.6;
      br.castShadow = true;
      t.add(br);
    }
    const palettes = [
      [0x2a5a1a, 0x3a6a2a, 0x1a4a10, 0x4a7a3a],
      [0x3a5a2a, 0x4a6a3a, 0x2a4a20, 0x5a7a4a],
      [0x1a4a1a, 0x2a5a2a, 0x0a3a0a, 0x3a6a3a],
      [0x4a6a2a, 0x5a7a3a, 0x3a5a1a, 0x6a8a4a],
    ];
    const pal = palettes[type % 4];
    const folN = 7 + Math.floor(Math.random() * 6);
    for (let l = 0; l < folN; l++) {
      const lm = new THREE.MeshStandardMaterial({ color: pal[l % pal.length], roughness: 0.7 });
      const sz = (0.5 + Math.random() * 0.8) * scale;
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(sz, 0), lm);
      leaf.position.set(
        (Math.random() - 0.5) * 2 * scale,
        (th + Math.random() * 2.5) * scale,
        (Math.random() - 0.5) * 2 * scale,
      );
      leaf.castShadow = true;
      leaf.userData.isFoliage = true;
      leaf.userData.basePos = leaf.position.clone();
      leaf.userData.phase = Math.random() * Math.PI * 2;
      t.add(leaf);
    }
    t.position.set(x, 0, z);
    return t;
  };
  const forests = [
    { x: -35, z: -30, c: 8, s: 1.2 },
    { x: 40, z: -35, c: 6, s: 1.0 },
    { x: -45, z: 25, c: 9, s: 1.1 },
    { x: 50, z: 30, c: 5, s: 0.9 },
    { x: -25, z: 45, c: 7, s: 1.3 },
    { x: 35, z: 45, c: 6, s: 1.1 },
    { x: -55, z: -10, c: 5, s: 1.0 },
    { x: 55, z: -15, c: 4, s: 0.8 },
    { x: -15, z: -55, c: 6, s: 1.1 },
    { x: 25, z: -50, c: 5, s: 1.0 },
  ];
  let tt = 0;
  for (const f of forests) {
    for (let i = 0; i < f.c; i++) {
      const a = (i / f.c) * Math.PI * 2 + Math.random() * 0.5;
      const d = 3 + Math.random() * 8;
      scene.add(tree(f.x + Math.cos(a) * d, f.z + Math.sin(a) * d, f.s * (0.8 + Math.random() * 0.4), tt++));
    }
  }

  // --- 風車（羽は毎フレーム回す: userData.bladeGroup） ---
  const wm = new THREE.Group();
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 1.0, 14, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.8 }),
  );
  tower.position.y = 7;
  tower.castShadow = true;
  wm.add(tower);
  const wcap = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 2.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.6 }),
  );
  wcap.position.y = 14.5;
  wm.add(wcap);
  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.2 }),
  );
  hub.position.set(0, 13.5, 0.8);
  wm.add(hub);
  const bladeGroup = new THREE.Group();
  bladeGroup.position.set(0, 13.5, 0.8);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 9, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.3 }),
    );
    blade.position.y = 4.5;
    const bc = new THREE.Group();
    bc.add(blade);
    bc.rotation.z = (i / 3) * Math.PI * 2;
    bladeGroup.add(bc);
  }
  wm.add(bladeGroup);
  wm.userData.bladeGroup = bladeGroup;
  wm.position.set(60, 0, -20);
  scene.add(wm);

  // --- 雲 ---
  const cloud = (x: number, y: number, z: number, scale: number): THREE.Group => {
    const c = new THREE.Group();
    const cm = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      transparent: true,
      opacity: 0.9,
      emissive: 0xffffff,
      emissiveIntensity: 0.15,
      depthWrite: false,
    });
    for (const [cx, cy, cz, cr] of [
      [0, 0, 0, 2.5],
      [1.8, 0.4, 0.3, 1.8],
      [-1.5, -0.1, 0.4, 2.0],
      [0.5, 0.8, -0.3, 1.4],
      [1.3, -0.4, 0.6, 1.2],
      [-0.7, 0.5, -0.4, 1.6],
      [2.2, 0.2, -0.2, 1.0],
      [-2.0, 0.3, 0.2, 1.3],
    ]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(cr * scale, 10, 10), cm);
      b.position.set(cx * scale, cy * scale, cz * scale);
      c.add(b);
    }
    c.position.set(x, y, z);
    return c;
  };
  for (const [cx, cy, cz, cs] of [
    [-30, 28, -50, 2.0],
    [40, 32, -60, 1.6],
    [10, 26, -70, 2.2],
    [-50, 30, -40, 1.4],
    [60, 28, -55, 1.8],
    [-20, 34, -65, 1.5],
    [30, 30, -45, 1.3],
    [-60, 26, -60, 1.7],
  ]) {
    scene.add(cloud(cx, cy, cz, cs));
  }

  // --- 花 ---
  const flowerColors = [
    [0xff6b9d, 0xff8fab],
    [0xffd93d, 0xffe066],
    [0xffffff, 0xf0f0f0],
    [0x9b59b6, 0xb07cc6],
    [0xe74c3c, 0xec7063],
    [0x3498db, 0x5dade2],
  ];
  for (let n = 0; n < 45; n++) {
    const f = new THREE.Group();
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.003, 0.004, 0.25, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a6a2a, roughness: 0.8 }),
    );
    stem.position.y = 0.125;
    f.add(stem);
    const [c1, c2] = flowerColors[n % flowerColors.length];
    for (let p = 0; p < 6; p++) {
      const petal = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 6, 6),
        new THREE.MeshStandardMaterial({ color: c1, roughness: 0.5 }),
      );
      const a = (p / 6) * Math.PI * 2;
      petal.position.set(Math.cos(a) * 0.03, 0.28, Math.sin(a) * 0.03);
      petal.scale.set(1, 0.5, 1);
      f.add(petal);
    }
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 8, 8),
      new THREE.MeshStandardMaterial({ color: c2, roughness: 0.4 }),
    );
    center.position.y = 0.28;
    f.add(center);
    const a = Math.random() * Math.PI * 2;
    const d = 5 + Math.random() * 35;
    f.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    scene.add(f);
  }

  // --- 草（InstancedMesh 1本＝ドローコール削減） ---
  const bladeGeo = new THREE.PlaneGeometry(0.03, 0.2);
  bladeGeo.translate(0, 0.1, 0); // 基部を原点に
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0x4a7a2a,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const GRASS = 1400;
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, GRASS);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const gp = new THREE.Vector3();
  const gs = new THREE.Vector3();
  for (let i = 0; i < GRASS; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 3 + Math.random() * 40;
    gp.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    eul.set(0, Math.random() * Math.PI, 0);
    q.setFromEuler(eul);
    const sc = 0.7 + Math.random() * 0.7;
    gs.set(1, sc, 1);
    m4.compose(gp, q, gs);
    grass.setMatrixAt(i, m4);
  }
  grass.instanceMatrix.needsUpdate = true;
  grass.receiveShadow = true;
  scene.add(grass);

  // --- フェンス ---
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.8 });
  for (let i = -20; i <= 20; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), fenceMat);
    post.position.set(i * 2, 0.3, 30);
    post.castShadow = true;
    scene.add(post);
    if (i < 20) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2, 0.04, 0.03), fenceMat);
      rail.position.set(i * 2 + 1, 0.45, 30);
      scene.add(rail);
      const rail2 = rail.clone();
      rail2.position.y = 0.25;
      scene.add(rail2);
    }
  }

  return scene;
}

// ============================================================
// 機体直下の擬似影（シャドウマップと併用の接地コンタクト）
// ============================================================
export function createBlobShadow(scene: THREE.Scene): THREE.Mesh {
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.35, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  scene.add(shadow);
  return shadow;
}

export function updateBlobShadow(shadow: THREE.Mesh, x: number, z: number, altitude: number): void {
  shadow.position.x = x;
  shadow.position.z = z;
  const spread = 1 + altitude * 0.18;
  shadow.scale.setScalar(spread);
  (shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 / (1 + altitude * 0.45);
}
