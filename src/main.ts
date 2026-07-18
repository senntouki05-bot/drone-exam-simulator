/**
 * main.ts — 配線: GameLoop（固定240Hz＋描画補間）× 入力層（Gamepad/キーボード）
 * × M2飛行力学（FlightDynamics: カスケード制御・GPS/ATTI・風・機体プロファイル）
 * × M3コース（data/courses/*.json: 描画・操縦者視点・幾何判定の目視用HUD）
 * × M4受験（ExamSession: 課目FSM・採点・試験員指示。音声=InstructorVoice/ビープ=WarningBeep）。
 *
 * 入力の選択（M1）: キャリブレーション済みのゲームパッド接続中はGamepadManager、
 * それ以外はKeyboardInput。ウィザード表示中は機体を動かさない。
 * `?input=debug` で入力デバッグ画面（生軸・正規化4軸）を重ねる。
 *
 * 開発用キー: 1/2/3=課目切替・Z=区画帯表示・M=GPS/ATTI切替・V=風切替・C=機体切替・R=リセット
 * （受験中はR=中止のみ有効）。Space/割当ボタン=安全確認の宣言。
 * 受験は左パネルの「課目開始」から（練習/試験通しモードの正式UIはM5）。
 * M3のHUD区画表示は常時判定の目視用で、受験の採点はExamSessionのフェーズゲーティングが正。
 */

import * as THREE from 'three';
import './style.css';
import { GameLoop } from './core/GameLoop';
import { KeyboardInput } from './input/KeyboardInput';
import { GamepadManager } from './input/GamepadManager';
import { InputSetupUI } from './ui/InputSetupUI';
import { InputDebugOverlay, type InputDebugView } from './ui/InputDebugOverlay';
import {
  NEUTRAL_INPUT,
  horizontalSpeed,
  takeSnapshot,
  type ControlInput,
  type DroneSnapshot,
} from './sim/FlightModel';
import { FlightDynamics } from './sim/FlightDynamics';
import { MACHINES } from './sim/MachineProfile';
import { WindModel, type WindEvent } from './sim/WindModel';
import { WIND_PRESETS } from './sim/WindPresets';
import { COURSES, courseToWorld, worldToCourse } from './exam/Course';
import {
  WindingTracker,
  createZoneResult,
  evalZone,
  inHCircle,
  pylonCollisionIndex,
} from './exam/geometry';
import { ExamSession, type ExamEvent } from './exam/ExamSession';
import { DroneModel } from './render/DroneModel';
import { CourseMarkers } from './render/CourseMarkers';
import { createBlobShadow, createGymScene, updateBlobShadow } from './render/Scene';
import { ExamPanel } from './ui/ExamPanel';
import { InstructorVoice } from './ui/InstructorVoice';
import { WarningBeep } from './ui/WarningBeep';

// --- DOM ---
const app = document.getElementById('app')!;
const hudCourse = document.getElementById('hud-course')!;
const hudAlt = document.getElementById('hud-alt')!;
const hudSpd = document.getElementById('hud-spd')!;
const hudMode = document.getElementById('hud-mode')!;
const hudWind = document.getElementById('hud-wind')!;
const hudMachine = document.getElementById('hud-machine')!;
const hudTime = document.getElementById('hud-time')!;
const hudInput = document.getElementById('hud-input')!;
const hudZone = document.getElementById('hud-zone')!;
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
// 視点位置は課目定義（Course.pilot）から setCourse() で設定する
const lookTarget = new THREE.Vector3(0, 0.5, 0);
const lookGoal = new THREE.Vector3();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- シム（M2: 機体プロファイル・風はデータ駆動） ---
let machineIndex = 0;
let windPresetIndex = 0; // 既定=屋内（無風）
// 風のシードはセッションごとに変える（テストと違い再現性は不要。決定性が要る検証はVitest側）
const windSeedBase = Date.now() >>> 0;
let wind = new WindModel(WIND_PRESETS[windPresetIndex].config, windSeedBase);
const drone = new FlightDynamics({
  profile: MACHINES[machineIndex],
  wind,
  seed: windSeedBase ^ 0x9e3779b9,
});
/** 風イベントの受け皿（毎ステップdrainし、受験中はExamSessionの突風猶予窓へ渡す） */
const windEvents: WindEvent[] = [];

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
const prevSnap: DroneSnapshot = {
  x: 0,
  y: 0,
  z: 0,
  yawRad: 0,
  pitchRad: 0,
  rollRad: 0,
  rotorSpin: 0,
};
const currSnap: DroneSnapshot = { ...prevSnap };
takeSnapshot(drone.state, prevSnap);
takeSnapshot(drone.state, currSnap);

// --- M3: 課目（コース）状態 ---
let courseIndex = 0;
let markers: CourseMarkers | null = null;
/** 巻き数アキュムレータ（4-2のみ・リセット/課目切替で作り直す） */
let winding: WindingTracker | null = null;
let zonesVisible = true; // M3は開発表示として既定ON（試験モードの非表示制御はM5）
// 幾何判定の使い回しバッファ（毎フレームのアロケーション回避）
const courseXZ = { x: 0, z: 0 };
const zoneScratch = createZoneResult();
const worldXZ = { x: 0, z: 0 };

function resetDrone(): void {
  drone.reset();
  takeSnapshot(drone.state, prevSnap); // テレポートを補間しない
  takeSnapshot(drone.state, currSnap);
  const course = COURSES[courseIndex];
  winding = course.winding ? new WindingTracker(course.winding) : null;
}

/** 課目を切り替える: コース描画・操縦者視点・H起点スポーン・指定モードを設定 */
function setCourse(index: number): void {
  courseIndex = index;
  const course = COURSES[index];

  if (markers) {
    scene.remove(markers.group);
    markers.dispose();
  }
  markers = new CourseMarkers(course);
  markers.setZonesVisible(zonesVisible);
  scene.add(markers.group);

  // 操縦者定点視点（課目ごとの立ち位置・目線1.6m）
  courseToWorld(course.pilot.x, course.pilot.z, worldXZ);
  camera.position.set(worldXZ.x, course.pilot.eyeHeightM, worldXZ.z);

  // H中心へスポーン（機首は前方=奥向き）・課目の指定モード（4-3=ATTI）
  courseToWorld(course.h.x, course.h.z, worldXZ);
  drone.setSpawn(worldXZ.x, worldXZ.z, 0);
  drone.setMode(course.flightMode);
  resetDrone();
  lookTarget.set(worldXZ.x, 0.5, worldXZ.z);
}

// --- M4: 受験セッション ---
let session: ExamSession | null = null;
const voice = new InstructorVoice();
const beep = new WarningBeep();
const examEvents: ExamEvent[] = [];
let declarePrev = false;
// ExamSampleはdrone.stateの参照を使い回す（毎ステップのアロケーション回避。modeのみ毎回更新）
const examSample = {
  p: drone.state.p,
  v: drone.state.v,
  q: drone.state.q,
  mode: drone.mode,
};

function examActive(): boolean {
  return session !== null && !session.finished;
}

function startExam(): void {
  if (examActive()) return;
  // クリックハンドラ内でAudio/TTSをアンロック（Chromeの自動再生制限対策）
  beep.resume();
  voice.prime();
  const course = COURSES[courseIndex];
  drone.setMode(course.flightMode);
  resetDrone();
  markers?.setZonesVisible(false); // 受験中は区画帯非表示（実試験相当）
  declarePrev = false;
  session = new ExamSession({
    course,
    machineRadiusM: drone.profile.radiusM,
    random: Math.random,
    direction: 'random',
    onInstruction: (i) => {
      examPanel.showInstruction(i.text);
      voice.speak(i.text);
    },
    onWarning: (w) => {
      beep.warning();
      examPanel.flashWarning(w.message);
    },
    onDeduction: (d) => {
      if (d.immediate) beep.fail();
      else beep.deduct();
      examPanel.addToast(d);
      if (session) examPanel.setScore(session.points);
    },
    onFinished: (r) => {
      voice.cancel();
      examPanel.setIdle();
      examPanel.setScore(r.points);
      markers?.setZonesVisible(zonesVisible);
      if (r.endReason !== 'aborted') examPanel.showReport(r, course);
    },
  });
  examPanel.setRunning(course.name);
  examPanel.setScore(session.points);
}

function abortExam(): void {
  session?.abort();
}

const examPanel = new ExamPanel(app, { onStart: startExam, onAbort: abortExam });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') {
    if (examActive()) abortExam();
    resetDrone();
  } else if (examActive()) {
    // 受験中は開発用キーを無効化（モード・課目・機体・風は固定）
    return;
  } else if (e.code === 'KeyM') {
    drone.setMode(drone.mode === 'gps' ? 'atti' : 'gps');
  } else if (e.code === 'KeyV') {
    windPresetIndex = (windPresetIndex + 1) % WIND_PRESETS.length;
    wind = new WindModel(WIND_PRESETS[windPresetIndex].config, windSeedBase + windPresetIndex);
    drone.setWind(wind);
  } else if (e.code === 'KeyC') {
    machineIndex = (machineIndex + 1) % MACHINES.length;
    drone.setProfile(MACHINES[machineIndex]);
  } else if (e.code === 'KeyZ') {
    zonesVisible = !zonesVisible;
    markers?.setZonesVisible(zonesVisible);
  } else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
    const index = Number(e.code.slice(-1)) - 1;
    if (index !== courseIndex) setCourse(index);
  }
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
let lastCourse = '';
let lastAlt = '';
let lastSpd = '';
let lastMode = '';
let lastWind = '';
let lastMachine = '';
let lastTime = '';
let lastInput = '';
let lastZone = '';
let lastZoneClass = '';

const RAD2DEG = 180 / Math.PI;

/** 区画HUDの文言を組み立てる（M3の目視確認用。フェーズによる判定ON/OFFはM4） */
function buildZoneText(): { text: string; cls: string } {
  const course = COURSES[courseIndex];
  const s = drone.state;
  worldToCourse(s.p.x, s.p.z, courseXZ);
  evalZone(course.path, course.zoneBands, courseXZ.x, courseXZ.z, zoneScratch);

  let text: string;
  let cls: string;
  if (zoneScratch.zone === 'free') {
    text = `自由帯 ${zoneScratch.distM.toFixed(1)}m（${zoneScratch.legId}）`;
    cls = 'zone-free';
  } else if (zoneScratch.zone === 'deduct') {
    text = `減点区画（${zoneScratch.zoneId === 'outer' ? '外側' : '内側'}）${zoneScratch.distM.toFixed(1)}m`;
    cls = 'zone-deduct';
  } else {
    text = `不合格区画 ${zoneScratch.distM.toFixed(1)}m`;
    cls = 'zone-fail';
  }
  if (inHCircle(courseXZ.x, courseXZ.z, course.h)) text += '｜H円内';
  if (pylonCollisionIndex(courseXZ.x, courseXZ.z, s.p.y, drone.profile.radiusM, course.pylons) >= 0) {
    text += '｜⚠パイロン接触';
    cls = 'zone-fail';
  }
  if (winding) {
    const active = winding.activeCircleId;
    if (active !== null) {
      const deg = Math.round(winding.accumRad * RAD2DEG);
      text += `｜周回:${active === 'left' ? '左' : '右'} ${deg >= 0 ? '+' : ''}${deg}°`;
    }
  }
  return { text, cls };
}

// --- ゲームループ ---
const loop = new GameLoop({
  update: (dt, tSim) => {
    prevSnap.x = currSnap.x;
    prevSnap.y = currSnap.y;
    prevSnap.z = currSnap.z;
    prevSnap.yawRad = currSnap.yawRad;
    prevSnap.pitchRad = currSnap.pitchRad;
    prevSnap.rollRad = currSnap.rollRad;
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
    // 風→機体の順で更新（droneは wind.current を読む）
    wind.update(dt, tSim);
    drone.step(dt, controls);
    takeSnapshot(drone.state, currSnap);
    // 巻き数は物理レートで毎サンプル追跡（4-2のみ・HUD表示用。採点用はExamSessionが内部で持つ）
    if (winding) {
      worldToCourse(drone.state.p.x, drone.state.p.z, courseXZ);
      winding.update(courseXZ.x, courseXZ.z);
    }
    // --- M4: 受験セッションへサンプル＋イベント（宣言・突風）を毎ステップ供給 ---
    const windCount = wind.drainEvents(windEvents);
    if (session && !session.finished) {
      examEvents.length = 0;
      const declareNow = keyboard.declarePressed || gamepad.declarePressed;
      if (declareNow && !declarePrev) examEvents.push({ t: tSim, type: 'declare' });
      declarePrev = declareNow;
      for (let i = 0; i < windCount; i++) {
        examEvents.push({ t: windEvents[i].t, type: windEvents[i].type });
      }
      examSample.mode = drone.mode;
      session.step(tSim, examSample, examEvents);
    }
    windEvents.length = 0;
  },
  render: (alpha) => {
    const x = lerp(prevSnap.x, currSnap.x, alpha);
    const y = lerp(prevSnap.y, currSnap.y, alpha);
    const z = lerp(prevSnap.z, currSnap.z, alpha);
    const yaw = lerpAngle(prevSnap.yawRad, currSnap.yawRad, alpha);
    const pitch = lerp(prevSnap.pitchRad, currSnap.pitchRad, alpha);
    const roll = lerp(prevSnap.rollRad, currSnap.rollRad, alpha);
    const spin = lerp(prevSnap.rotorSpin, currSnap.rotorSpin, alpha);

    droneModel.update(x, y, z, yaw, pitch, roll, spin);
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
    const modeText = drone.mode === 'gps' ? 'GPS（位置安定ON）' : 'ATTI（位置安定OFF）';
    if (modeText !== lastMode) {
      hudMode.textContent = modeText;
      lastMode = modeText;
    }
    const windNow = Math.hypot(wind.current.x, wind.current.z);
    const windText = `${WIND_PRESETS[windPresetIndex].label}｜今 ${windNow.toFixed(1)} m/s`;
    if (windText !== lastWind) {
      hudWind.textContent = windText;
      lastWind = windText;
    }
    const machineText = MACHINES[machineIndex].name;
    if (machineText !== lastMachine) {
      hudMachine.textContent = machineText;
      lastMachine = machineText;
    }
    const timeText = formatTime(loop.simTime);
    if (timeText !== lastTime) {
      hudTime.textContent = timeText;
      lastTime = timeText;
    }
    const courseText = COURSES[courseIndex].name;
    if (courseText !== lastCourse) {
      hudCourse.textContent = courseText;
      lastCourse = courseText;
    }
    const zoneInfo = buildZoneText();
    if (zoneInfo.text !== lastZone) {
      hudZone.textContent = zoneInfo.text;
      lastZone = zoneInfo.text;
    }
    if (zoneInfo.cls !== lastZoneClass) {
      hudZone.className = zoneInfo.cls;
      lastZoneClass = zoneInfo.cls;
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

setCourse(0); // 起動時は4-1 スクエア飛行
loop.start();
