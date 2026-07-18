/**
 * render/Scene.ts — 体育館風の屋内シーン（M0）。
 *
 * 見た目だけのモジュール。コース設置物（パイロン・H円・区画帯・ガイド線）は
 * data/courses/*.json 駆動の CourseMarkers（M3）が担当し、ここにあるコートラインは
 * 装飾（採点とは無関係）。操縦者の視点位置も課目定義（Course.pilot）から設定する。
 * 60fps優先のためシャドウマップは使わず、機体直下の擬似影（ブロブシャドウ）で代替する。
 */

import * as THREE from 'three';

/** 体育館の内寸 [m]（M0仮） */
export const GYM = {
  halfX: 15,
  halfZ: 11,
  height: 8,
} as const;

/** 木床のプランク模様をCanvasで生成（外部アセットなし・決定的パターン） */
function createFloorTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#c79f66';
  ctx.fillRect(0, 0, size, size);

  const plankH = 32;
  for (let row = 0; row < size / plankH; row++) {
    // 行ごとに明度を決定的に変える（乱数不使用）
    const tone = 8 * Math.sin(row * 12.9898) - 4;
    ctx.fillStyle = `rgb(${199 + tone}, ${159 + tone}, ${102 + tone * 0.6})`;
    ctx.fillRect(0, row * plankH, size, plankH - 1);
    // プランクの継ぎ目（横方向にずらす）
    ctx.fillStyle = 'rgba(90, 60, 30, 0.35)';
    const joint = ((row * 97) % 8) * (size / 8);
    ctx.fillRect(joint, row * plankH, 2, plankH);
    // 行の区切り線
    ctx.fillStyle = 'rgba(90, 60, 30, 0.5)';
    ctx.fillRect(0, row * plankH + plankH - 1, size, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 4);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** コートライン風の細長い白帯（装飾） */
function addLine(
  scene: THREE.Scene,
  material: THREE.Material,
  w: number,
  d: number,
  x: number,
  z: number,
): void {
  const line = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  line.rotation.x = -Math.PI / 2;
  line.position.set(x, 0.005, z);
  scene.add(line);
}

export function createGymScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x35322c);

  // --- 照明（シャドウなし） ---
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x7a6a50, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 12, 4);
  scene.add(sun);

  // --- 床 ---
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2),
    new THREE.MeshLambertMaterial({ map: createFloorTexture() }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // --- コートライン（装飾。H円・経路白線はCourseMarkersが課目定義から描く） ---
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf5f2e8 });
  const courtW = 26;
  const courtD = 15;
  const lw = 0.05;
  addLine(scene, lineMat, courtW, lw, 0, -courtD / 2);
  addLine(scene, lineMat, courtW, lw, 0, courtD / 2);
  addLine(scene, lineMat, lw, courtD, -courtW / 2, 0);
  addLine(scene, lineMat, lw, courtD, courtW / 2, 0);

  // --- 壁（腰壁つき） ---
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xded8c3 });
  const wainscotMat = new THREE.MeshLambertMaterial({ color: 0x9a8b6f });
  const walls: Array<{ w: number; x: number; z: number; ry: number }> = [
    { w: GYM.halfX * 2, x: 0, z: -GYM.halfZ, ry: 0 },
    { w: GYM.halfX * 2, x: 0, z: GYM.halfZ, ry: Math.PI },
    { w: GYM.halfZ * 2, x: -GYM.halfX, z: 0, ry: Math.PI / 2 },
    { w: GYM.halfZ * 2, x: GYM.halfX, z: 0, ry: -Math.PI / 2 },
  ];
  for (const def of walls) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(def.w, GYM.height), wallMat);
    wall.position.set(def.x, GYM.height / 2, def.z);
    wall.rotation.y = def.ry;
    scene.add(wall);
    const wainscot = new THREE.Mesh(new THREE.PlaneGeometry(def.w, 2), wainscotMat);
    wainscot.position.set(def.x, 1, def.z);
    wainscot.rotation.y = def.ry;
    // 壁より僅かに内側へ出してZファイトを避ける
    wainscot.translateZ(0.01);
    scene.add(wainscot);
  }

  // --- 長辺の壁の上部に窓（発光板で代替） ---
  const windowMat = new THREE.MeshBasicMaterial({ color: 0xeaf3ff });
  for (const zSide of [-1, 1]) {
    for (let i = -3; i <= 3; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), windowMat);
      win.position.set(i * 4, 5.8, zSide * (GYM.halfZ - 0.02));
      win.rotation.y = zSide > 0 ? Math.PI : 0;
      scene.add(win);
    }
  }

  // --- 天井＋照明パネル ---
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(GYM.halfX * 2, GYM.halfZ * 2),
    new THREE.MeshLambertMaterial({ color: 0xcfcabb }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = GYM.height;
  scene.add(ceiling);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let ix = -1; ix <= 1; ix++) {
    for (let iz = -1; iz <= 1; iz += 2) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), panelMat);
      panel.rotation.x = Math.PI / 2;
      panel.position.set(ix * 8, GYM.height - 0.02, iz * 4);
      scene.add(panel);
    }
  }

  return scene;
}

/** 機体直下の擬似影（シャドウマップの代替・毎フレームupdateBlobShadowで動かす） */
export function createBlobShadow(scene: THREE.Scene): THREE.Mesh {
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.35, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
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
  (shadow.material as THREE.MeshBasicMaterial).opacity = 0.35 / (1 + altitude * 0.45);
}
