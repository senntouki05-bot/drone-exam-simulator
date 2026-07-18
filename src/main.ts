/**
 * main.ts — 配線: GameLoop（固定240Hz＋描画補間）× 入力層（Gamepad/キーボード）× 仮機体 × 体育館シーン。
 *
 * 入力の選択（M1）: キャリブレーション済みのゲームパッド接続中はGamepadManager、
 * それ以外はKeyboardInput。ウィザード表示中は機体を動かさない。
 * `?input=debug` で入力デバッグ画面（生軸・正規化4軸）を重ねる。
 */

import * as THREE from 'three';
import './style.css';
import { GameLoop } from './core/GameLoop';
import { KeyboardInput } from './input/KeyboardInput';
import { GamepadManager } from './input/GamepadManager';
import { InputSetupUI } from './ui/InputSetupUI';
import { InputDebugOverlay, type InputDebugView } from './ui/InputDebugOverlay';
import { NEUTRAL_INPUT, type ControlInput } from './sim/FlightModel';
import {
  SimpleDrone,
  horizontalSpeed,
  takeSnapshot,
  type DroneSnapshot,
} from './sim/SimpleDrone';
import { DroneModel } from './render/DroneModel';
import { PILOT_EYE, createBlobShadow, createGymScene, updateBlobShadow } from './render/Scene';

// --- DOM ---
const app = document.getElementById('app')!;
const hudAlt = document.getElementById('hud-alt')!;
const hudSpd = document.getElementById('hud-spd')!;
const hudTime = document.getElementById('hud-time')!;
const hudInput = document.getElementById('hud-input')!;
const pauseOverlay = document.getElementById('pause-overlay')!;
const resumeBtn = document.getElementById('resume-btn')!;

// --- レンダラ・シーン・カメラ（操縦者定点視点） ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.prepend(renderer.domElement);

const scene = createGymScene();
const blobShadow = createBlobShadow(scene);
const droneModel = new DroneModel();
scene.add(droneModel.group);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.05,
  100,
);
camera.position.set(PILOT_EYE.x, PILOT_EYE.y, PILOT_EYE.z);
const lookTarget = new THREE.Vector3(0, 0.5, 0);
const lookGoal = new THREE.Vector3();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- シム・入力 ---
const drone = new SimpleDrone();
const keyboard = new KeyboardInput();
const gamepad = new GamepadManager(); // navigator.getGamepads / window / localStorage は既定注入
const inputSetup = new InputSetupUI(app, gamepad);
const debugOverlay =
  new URLSearchParams(window.location.search).get('input') === 'debug'
    ? new InputDebugOverlay(app)
    : null;
const controls: ControlInput = { ...NEUTRAL_INPUT };

// デバッグ表示用ビュー（毎フレームのアロケーション回避のため使い回す）
const debugView: InputDebugView = {
  sourceName: '',
  gamepadId: null,
  calibrated: false,
  mode: null,
  deadzone: null,
  rawAxes: [],
  pressedButtons: [],
  normalized: controls,
  declare: false,
};

// 補間用スナップショット（前回ステップ／最新ステップ）
const prevSnap: DroneSnapshot = { x: 0, y: 0, z: 0, yawRad: 0, rotorSpin: 0 };
const currSnap: DroneSnapshot = { x: 0, y: 0, z: 0, yawRad: 0, rotorSpin: 0 };
takeSnapshot(drone.state, prevSnap);
takeSnapshot(drone.state, currSnap);

function resetDrone(): void {
  drone.reset();
  takeSnapshot(drone.state, prevSnap); // テレポートを補間しない
  takeSnapshot(drone.state, currSnap);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetDrone();
});

// --- 補間ヘルパ（毎フレームのアロケーション回避） ---
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 角度の最短経路lerp（±πまたぎ対策） */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function formatTime(tSim: number): string {
  const total = Math.floor(tSim);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// HUDはテキストが変わったときだけDOMを触る
let lastAlt = '';
let lastSpd = '';
let lastTime = '';
let lastInput = '';

// --- ゲームループ ---
const loop = new GameLoop({
  update: (dt) => {
    prevSnap.x = currSnap.x;
    prevSnap.y = currSnap.y;
    prevSnap.z = currSnap.z;
    prevSnap.yawRad = currSnap.yawRad;
    prevSnap.rotorSpin = currSnap.rotorSpin;
    // rAF駆動のフレーム内ポーリング（gamepadconnectedイベントとの併用はGamepadManager側）
    gamepad.poll();
    if (inputSetup.wizardActive) {
      // キャリブレーション中は機体を動かさない
      controls.aileron = 0;
      controls.elevator = 0;
      controls.throttle = 0;
      controls.rudder = 0;
    } else if (gamepad.ready) {
      gamepad.read(controls);
    } else {
      keyboard.read(controls);
    }
    drone.step(dt, controls);
    takeSnapshot(drone.state, currSnap);
  },
  render: (alpha) => {
    const x = lerp(prevSnap.x, currSnap.x, alpha);
    const y = lerp(prevSnap.y, currSnap.y, alpha);
    const z = lerp(prevSnap.z, currSnap.z, alpha);
    const yaw = lerpAngle(prevSnap.yawRad, currSnap.yawRad, alpha);
    const spin = lerp(prevSnap.rotorSpin, currSnap.rotorSpin, alpha);

    droneModel.update(x, y, z, yaw, spin);
    updateBlobShadow(blobShadow, x, z, y);

    // 操縦者定点から機体をなめらかに追尾
    lookGoal.set(x, y + 0.1, z);
    lookTarget.lerp(lookGoal, 0.18);
    camera.lookAt(lookTarget);

    const altText = `${y.toFixed(1)} m`;
    if (altText !== lastAlt) {
      hudAlt.textContent = altText;
      lastAlt = altText;
    }
    const spdText = `${horizontalSpeed(drone.state.v).toFixed(1)} m/s`;
    if (spdText !== lastSpd) {
      hudSpd.textContent = spdText;
      lastSpd = spdText;
    }
    const timeText = formatTime(loop.simTime);
    if (timeText !== lastTime) {
      hudTime.textContent = timeText;
      lastTime = timeText;
    }

    inputSetup.update();
    const inputText = inputSetup.wizardActive
      ? '設定中'
      : gamepad.ready
        ? 'プロポ/パッド'
        : 'キーボード';
    if (inputText !== lastInput) {
      hudInput.textContent = inputText;
      lastInput = inputText;
    }
    if (debugOverlay) {
      debugView.sourceName = inputText;
      debugView.gamepadId = gamepad.gamepadId;
      debugView.calibrated = gamepad.calibration !== null;
      debugView.mode = gamepad.calibration?.mode ?? null;
      debugView.deadzone = gamepad.calibration?.deadzone ?? null;
      debugView.rawAxes = gamepad.rawAxes;
      debugView.pressedButtons = gamepad.rawButtons;
      debugView.declare = keyboard.declarePressed || gamepad.declarePressed;
      debugOverlay.update(debugView);
    }

    renderer.render(scene, camera);
  },
  onAutoPause: () => {
    pauseOverlay.hidden = false;
  },
});

resumeBtn.addEventListener('click', () => {
  pauseOverlay.hidden = true;
  loop.resume();
});

loop.start();
