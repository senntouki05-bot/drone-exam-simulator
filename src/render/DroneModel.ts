/**
 * render/DroneModel.ts — プリミティブ組合せの仮クアッド機体（プロペラ回転つき）。
 *
 * ローカル座標: 脚底がy=0（sim側の位置pは脚底基準）。機首は-z方向（赤いノーズマーカー）。
 * ジオメトリ・マテリアルは生成時のみ作り、毎フレームのアロケーションはしない。
 */

import * as THREE from 'three';

const ARM_HALF = 0.17; // モーター位置（対角配置）[m]

export class DroneModel {
  readonly group: THREE.Group;
  private readonly props: THREE.Mesh[] = [];

  constructor() {
    this.group = new THREE.Group();

    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xe9e9ec });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x3a3a40 });
    const noseMat = new THREE.MeshLambertMaterial({ color: 0xd23b2f });
    const propMat = new THREE.MeshLambertMaterial({ color: 0x22262c });

    // 胴体（脚高0.08の上に載る）
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.26), bodyMat);
    body.position.y = 0.125;
    this.group.add(body);

    // 機首マーカー（前方=-z）
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.06), noseMat);
    nose.position.set(0, 0.14, -0.15);
    this.group.add(nose);

    // アーム（X字）
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.02, 0.045), darkMat);
      arm.position.y = 0.13;
      arm.rotation.y = angle;
      this.group.add(arm);
    }

    // 脚（スキッド）: 脚底がローカルy=0
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.2), darkMat);
      leg.position.set(side * 0.09, 0.04, 0);
      this.group.add(leg);
    }

    // モーター＋プロペラ（4隅・回転方向は交互）
    const motorGeo = new THREE.CylinderGeometry(0.025, 0.028, 0.045, 10);
    const propGeo = new THREE.BoxGeometry(0.26, 0.005, 0.028);
    let i = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const motor = new THREE.Mesh(motorGeo, darkMat);
        motor.position.set(sx * ARM_HALF, 0.155, sz * ARM_HALF);
        this.group.add(motor);
        const prop = new THREE.Mesh(propGeo, propMat);
        prop.position.set(sx * ARM_HALF, 0.182, sz * ARM_HALF);
        prop.rotation.y = i * 0.7; // 初期位相をばらす
        prop.userData.spinDir = i % 2 === 0 ? 1 : -1;
        this.props.push(prop);
        this.group.add(prop);
        i++;
      }
    }
  }

  /** 補間済みの位置・ヨー・プロペラ位相を反映する（毎描画フレーム） */
  update(x: number, y: number, z: number, yawRad: number, rotorSpin: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yawRad;
    for (const prop of this.props) {
      prop.rotation.y = rotorSpin * (prop.userData.spinDir as number);
    }
  }
}
