/**
 * render/DroneModel.ts — フライトシム品質のクアッド機体（drone_simulator_v4.html 参考）。
 *
 * ローカル座標: 脚底（着陸脚のフィート）がy≈0（sim側の位置pは脚底基準）。機首は-z方向（赤いノーズ）。
 * 姿勢は rotation.order='YXZ' で yaw→pitch→roll の順に適用（sim/FlightModel.tsの規約:
 * rotation.y=yaw / rotation.x=-pitch(機首下げ正) / rotation.z=-roll(右バンク正)）。
 * ジオメトリ・マテリアルは生成時のみ作り、毎フレームのアロケーションはしない。
 * カーボン/クリアコートのPBR材質・カメラジンバル・航法LED・プロペラガードつき。
 */

import * as THREE from 'three';

const ARM_HALF = 0.21; // モーター位置（対角配置）[m]

export class DroneModel {
  readonly group: THREE.Group;
  private readonly props: THREE.Mesh[] = [];

  constructor() {
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';

    const matBody = new THREE.MeshPhysicalMaterial({
      color: 0xe8e8ec,
      metalness: 0.2,
      roughness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      reflectivity: 0.7,
      ior: 1.5,
    });
    const matDark = new THREE.MeshPhysicalMaterial({ color: 0x1a1a20, metalness: 0.75, roughness: 0.2, clearcoat: 0.5 });
    const matNose = new THREE.MeshPhysicalMaterial({
      color: 0xc02020,
      metalness: 0.1,
      roughness: 0.1,
      clearcoat: 1.0,
      emissive: 0x301010,
      emissiveIntensity: 0.15,
    });
    const matProp = new THREE.MeshPhysicalMaterial({ color: 0x101418, metalness: 0.5, roughness: 0.3, transparent: true, opacity: 0.85 });
    const matLED = new THREE.MeshPhysicalMaterial({ color: 0x40a0ff, emissive: 0x40a0ff, emissiveIntensity: 2.4, roughness: 0.02, toneMapped: false });
    const matLEDRed = new THREE.MeshPhysicalMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 2.4, roughness: 0.02, toneMapped: false });
    const matMotor = new THREE.MeshPhysicalMaterial({ color: 0x282830, metalness: 0.9, roughness: 0.1, clearcoat: 0.7 });
    const matGlass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 0.97, thickness: 0.5, ior: 1.5, transparent: true, opacity: 0.2 });
    const matCarbon = new THREE.MeshPhysicalMaterial({ color: 0x151518, metalness: 0.3, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.1 });

    // 胴体（空力形状の押し出し）
    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(0, 0.08);
    bodyShape.lineTo(0.12, 0.06);
    bodyShape.lineTo(0.14, 0.02);
    bodyShape.lineTo(0.12, -0.02);
    bodyShape.lineTo(0, -0.04);
    bodyShape.lineTo(-0.12, -0.02);
    bodyShape.lineTo(-0.14, 0.02);
    bodyShape.lineTo(-0.12, 0.06);
    bodyShape.closePath();
    const body = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bodyShape, { depth: 0.28, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 3 }),
      matBody,
    );
    body.rotation.y = Math.PI / 2;
    // 押し出し軸(local +z)は rotation.y=90°で world +x になる → x を -0.14 寄せて機体中心へ
    body.position.set(-0.14, 0.13, 0);
    body.castShadow = true;
    this.group.add(body);

    const topPanel = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.008, 0.26), matCarbon);
    topPanel.position.y = 0.185;
    this.group.add(topPanel);

    // 機首（前方=-z・赤）
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.08, 12), matNose);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.14, -0.16);
    this.group.add(nose);

    const ledGeo = new THREE.SphereGeometry(0.008, 12, 12);
    const frontLED = new THREE.Mesh(ledGeo, matLEDRed);
    frontLED.position.set(0, 0.14, -0.18);
    this.group.add(frontLED);
    for (const [lx, ly, lz] of [[-0.06, 0.14, 0.14], [0.06, 0.14, 0.14]]) {
      const led = new THREE.Mesh(ledGeo, matLED);
      led.position.set(lx, ly, lz);
      this.group.add(led);
    }

    // アーム（カーボンXフレーム）
    const armGeo = new THREE.BoxGeometry(0.58, 0.015, 0.04);
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(armGeo, matCarbon);
      arm.position.y = 0.14;
      arm.rotation.y = angle;
      arm.castShadow = true;
      this.group.add(arm);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.5, 6), matDark);
      strut.position.y = 0.14;
      strut.rotation.y = angle;
      strut.rotation.z = Math.PI / 6;
      this.group.add(strut);
    }

    // 着陸脚（スキッド・フィートがy≈0）
    for (const side of [-1, 1]) {
      const legGroup = new THREE.Group();
      const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.12, 8), matCarbon);
      s1.position.set(0, 0.06, 0.03);
      s1.rotation.x = 0.15;
      legGroup.add(s1);
      const s2 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.12, 8), matCarbon);
      s2.position.set(0, 0.06, -0.03);
      s2.rotation.x = -0.15;
      legGroup.add(s2);
      const skidCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.12, 0, 0),
        new THREE.Vector3(-0.06, -0.01, 0),
        new THREE.Vector3(0, -0.015, 0),
        new THREE.Vector3(0.06, -0.01, 0),
        new THREE.Vector3(0.12, 0, 0),
      ]);
      const skid = new THREE.Mesh(new THREE.TubeGeometry(skidCurve, 20, 0.005, 8, false), matDark);
      legGroup.add(skid);
      const footGeo = new THREE.SphereGeometry(0.012, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const footMat = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.95, metalness: 0 });
      const fL = new THREE.Mesh(footGeo, footMat);
      fL.position.set(-0.12, 0, 0);
      fL.rotation.z = Math.PI / 2;
      legGroup.add(fL);
      const fR = new THREE.Mesh(footGeo, footMat);
      fR.position.set(0.12, 0, 0);
      fR.rotation.z = -Math.PI / 2;
      legGroup.add(fR);
      legGroup.position.set(side * 0.1, 0, 0);
      this.group.add(legGroup);
    }

    // モーター＋プロペラ（4隅・回転方向は交互・ガードリングつき）
    const motorGeo = new THREE.CylinderGeometry(0.028, 0.032, 0.055, 16);
    const propGeo = new THREE.BoxGeometry(0.32, 0.002, 0.025);
    let i = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const mg = new THREE.Group();
        const motor = new THREE.Mesh(motorGeo, matMotor);
        motor.position.y = 0.17;
        motor.castShadow = true;
        mg.add(motor);
        for (let fin = 0; fin < 8; fin++) {
          const f = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.01, 0.002), matDark);
          f.position.y = 0.195;
          f.rotation.y = (fin / 8) * Math.PI * 2;
          f.translateX(0.018);
          mg.add(f);
        }
        const mLed = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 8), i % 2 === 0 ? matLED : matLEDRed);
        mLed.position.set(sx * 0.03, 0.2, sz * 0.03);
        mg.add(mLed);
        const prop = new THREE.Mesh(propGeo, matProp);
        prop.position.set(0, 0.2, 0);
        prop.rotation.y = i * 0.7;
        prop.userData.spinDir = i % 2 === 0 ? 1 : -1;
        this.props.push(prop);
        mg.add(prop);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), i % 2 === 0 ? matLED : matLEDRed);
        tip.position.set(0.14, 0, 0);
        prop.add(tip);
        const guard = new THREE.Mesh(
          new THREE.TorusGeometry(0.17, 0.002, 6, 32),
          new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2, transparent: true, opacity: 0.3 }),
        );
        guard.rotation.x = Math.PI / 2;
        guard.position.y = 0.2;
        mg.add(guard);
        mg.position.set(sx * ARM_HALF, 0, sz * ARM_HALF);
        this.group.add(mg);
        i++;
      }
    }

    // カメラジンバル（前方下）
    const gimbal = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), matDark);
    housing.rotation.x = Math.PI;
    gimbal.add(housing);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.02, 12), matDark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.015;
    gimbal.add(barrel);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 16), matGlass);
    lens.position.z = 0.025;
    gimbal.add(lens);
    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.01, 0.0015, 8, 16), new THREE.MeshPhysicalMaterial({ color: 0x444444, metalness: 0.9, roughness: 0.1 }));
    lensRing.position.z = 0.022;
    gimbal.add(lensRing);
    gimbal.position.set(0, 0.09, -0.06); // 機首側（-z）へ
    this.group.add(gimbal);

    // GPSアンテナ
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.06, 4), matDark);
    ant.position.set(0, 0.22, 0.08);
    this.group.add(ant);
    const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.003, 6, 6), new THREE.MeshPhysicalMaterial({ color: 0xff8800, emissive: 0xff4400, emissiveIntensity: 0.5 }));
    antTip.position.set(0, 0.25, 0.08);
    this.group.add(antTip);
    // ステータスLED（下面）
    const statusLED = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), new THREE.MeshPhysicalMaterial({ color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 2.0, roughness: 0.05, toneMapped: false }));
    statusLED.position.set(0, 0.09, 0.04);
    this.group.add(statusLED);
  }

  /** 補間済みの位置・姿勢・プロペラ位相を反映する（毎描画フレーム） */
  update(
    x: number,
    y: number,
    z: number,
    yawRad: number,
    pitchRad: number,
    rollRad: number,
    rotorSpin: number,
  ): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yawRad;
    this.group.rotation.x = -pitchRad; // 機首下げ正 → three.jsでは-x回転
    this.group.rotation.z = -rollRad; // 右バンク正 → three.jsでは-z回転
    for (const prop of this.props) {
      prop.rotation.y = rotorSpin * (prop.userData.spinDir as number);
    }
  }
}
