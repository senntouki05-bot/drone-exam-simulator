/**
 * main.ts — 配線: GameLoop（固定240Hz＋描画補間）× 入力層（Gamepad/キーボード）
 * × M2飛行力学（FlightDynamics: カスケード制御・GPS/ATTI・風・機体プロファイル）
 * × M3コース（data/courses/*.json: 描画・操縦者視点・幾何判定の目視用HUD）
 * × M4受験（ExamSession: 課目FSM・採点・試験員指示）
 * × M5仕上げ（ExamSeries=試験モード3課目通し・リプレイ・ミニマップ・スコア履歴・練習設定）。
 *
 * アプリモード（appMode）:
 *   free     = 自由飛行（練習設定パネルすべて操作可）
 *   practice = 課目単体の受験（練習モード扱い: 区画帯は表示可・ミニマップあり・リプレイ記録）
 *   series   = 試験モード3課目通し（区画帯/ミニマップ非表示・カメラは操縦者定点固定・設定ロック）
 *   replay   = リプレイ再生（物理停止・記録サンプルを補間して機体を動かす）
 *
 * 入力の選択（M1）: キャリブレーション済みのゲームパッド接続中はGamepadManager、
 * それ以外はKeyboardInput。ウィザード表示中は機体を動かさない。`?input=debug` でデバッグ画面。
 * キー: 1/2/3=課目・Z=区画帯・M=GPS/ATTI・V=風・C=機体・H=最小HUD・R=リセット（受験中=中止）。
 * Space/割当ボタン=安全確認の宣言。受験中は R/H 以外の切替キーを無効化（practice中はZのみ許可）。
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
  type FlightMode,
} from './sim/FlightModel';
import { FlightDynamics } from './sim/FlightDynamics';
import { MACHINES } from './sim/MachineProfile';
import { WindModel, type WindConfig, type WindEvent } from './sim/WindModel';
import { WIND_PRESETS } from './sim/WindPresets';
import { COURSES, courseToWorld, worldToCourse } from './exam/Course';
import {
  WindingTracker,
  createZoneResult,
  evalZone,
  inHCircle,
  pylonCollisionIndex,
} from './exam/geometry';
import { ExamSession, type ExamEvent, type ExamResult } from './exam/ExamSession';
import { ExamSeries, type ExamSeriesResult } from './exam/ExamSeries';
import { ScoreHistory } from './exam/ScoreHistory';
import {
  ReplayPlayer,
  ReplayRecorder,
  parseReplay,
  serializeReplay,
  type ReplayRecording,
} from './replay/Replay';
import { DroneModel } from './render/DroneModel';
import { CourseMarkers, computeCourseBBox } from './render/CourseMarkers';
import { MiniMap } from './render/MiniMap';
import {
  createBlobShadow,
  createGymScene,
  createOutdoorScene,
  updateBlobShadow,
} from './render/Scene';
import { ExamPanel } from './ui/ExamPanel';
import { PracticePanel, type CameraMode, type SceneKind } from './ui/PracticePanel';
import { InstructorVoice } from './ui/InstructorVoice';
import { WarningBeep } from './ui/WarningBeep';

type AppMode = 'free' | 'practice' | 'series' | 'replay';

// --- DOM ---
const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
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
// 左サイド列（受験パネル＋練習設定パネルを縦積み）
const sideCol = document.createElement('div');
sideCol.id = 'side-col';
app.appendChild(sideCol);

// --- レンダラ・シーン（屋内/屋外の2種を起動時に生成し、参照を差し替える） ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.prepend(renderer.domElement);

const gymScene = createGymScene();
const outdoorScene = createOutdoorScene();
let scene = gymScene;
const blobShadow = createBlobShadow(scene);
const droneModel = new DroneModel();
scene.add(droneModel.group);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 100);
// 視点位置は課目定義（Course.pilot）から setCourse() で設定する
const lookTarget = new THREE.Vector3(0, 0.5, 0);
const lookGoal = new THREE.Vector3();
const chaseGoal = new THREE.Vector3();
let cameraMode: CameraMode = 'pilot';
/** 俯瞰カメラ用のコース中心（ワールド座標・setCourseで更新） */
const courseCenterW = { x: 0, z: 0 };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/** シーン切替: three.jsのadd()は付け替え（旧シーンから自動で外れる）を利用する */
function setScene(kind: SceneKind): void {
  scene = kind === 'gym' ? gymScene : outdoorScene;
  scene.add(droneModel.group);
  scene.add(blobShadow);
  if (markers) scene.add(markers.group);
}

// --- シム（M2: 機体プロファイル・風はデータ駆動） ---
let machineIndex = 0;
// 風のシードはセッションごとに変える（テストと違い再現性は不要。決定性が要る検証はVitest側）
const windSeedBase = Date.now() >>> 0;
let windSeedCounter = 0;
let wind = new WindModel(WIND_PRESETS[0].config, windSeedBase);
let windLabel = WIND_PRESETS[0].label;
const drone = new FlightDynamics({
  profile: MACHINES[machineIndex],
  wind,
  seed: windSeedBase ^ 0x9e3779b9,
});
/** 風イベントの受け皿（毎ステップdrainし、受験中はExamSessionの突風猶予窓へ渡す） */
const windEvents: WindEvent[] = [];

function setWindPreset(index: number): void {
  windSeedCounter++;
  wind = new WindModel(WIND_PRESETS[index].config, windSeedBase + windSeedCounter);
  windLabel = WIND_PRESETS[index].label;
  drone.setWind(wind);
}

/**
 * 風スライダー（カスタム風）: 瞬時風速の上限（定常+突風ピーク+乱流振幅）を
 * 実施中止基準5m/s未満に収める。突風ピークは乱流ぶんも予算に入れて頭打ちにする
 * （turbAmp=steady*0.13 を差し引く）。スライダー範囲[0,3.5]では ampMin≤ampMax が保たれる。
 */
function setWindCustom(steadyMs: number, gusts: boolean): void {
  const turbAmp = steadyMs * 0.13;
  const config: WindConfig = {
    steadyMs,
    steadyDirDeg: Math.random() * 360,
    gust: {
      enabled: gusts && steadyMs > 0,
      ampMinMs: Math.min(0.4, steadyMs * 0.3),
      ampMaxMs: Math.max(0.1, Math.min(1.4, 4.9 - steadyMs - turbAmp)),
      intervalMinS: 4,
      intervalMaxS: 10,
      durMinS: 1.5,
      durMaxS: 3.5,
      tauS: 1.0,
    },
    turbulence: { ampMs: turbAmp, freqHz: 0.7 },
  };
  windSeedCounter++;
  wind = new WindModel(config, windSeedBase + windSeedCounter);
  windLabel =
    steadyMs === 0 ? 'カスタム（無風）' : `カスタム ${steadyMs.toFixed(1)}m/s${config.gust.enabled ? '+突風' : ''}`;
  drone.setWind(wind);
}

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
/** 巻き数アキュムレータ（4-2のみ・HUD表示用。採点用はExamSessionが内部で持つ） */
let winding: WindingTracker | null = null;
let zonesVisible = true; // 練習モードの区画帯表示（試験モード通し中は強制非表示）
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
  // 機体テレポート時は軌跡をクリア（ジャンプ線を描かない）。minimapは初期化後のみ存在
  minimap?.resetTrail();
}

/** 課目を切り替える: コース描画・操縦者視点・H起点スポーン・指定モード・ミニマップを設定 */
function setCourse(index: number): void {
  courseIndex = index;
  const course = COURSES[index];

  if (markers) {
    scene.remove(markers.group);
    markers.dispose();
  }
  markers = new CourseMarkers(course);
  markers.setZonesVisible(zonesVisible && appMode !== 'series');
  scene.add(markers.group);
  minimap.setCourse(course);

  // 操縦者定点視点（課目ごとの立ち位置・目線1.6m）と俯瞰用のコース中心
  courseToWorld(course.pilot.x, course.pilot.z, worldXZ);
  camera.position.set(worldXZ.x, course.pilot.eyeHeightM, worldXZ.z);
  const bbox = computeCourseBBox(course.path, 0);
  courseToWorld((bbox.minX + bbox.maxX) / 2, (bbox.minZ + bbox.maxZ) / 2, worldXZ);
  courseCenterW.x = worldXZ.x;
  courseCenterW.z = worldXZ.z;

  // H中心へスポーン（機首は前方=奥向き）・課目の指定モード（4-3=ATTI）
  courseToWorld(course.h.x, course.h.z, worldXZ);
  drone.setSpawn(worldXZ.x, worldXZ.z, 0);
  drone.setMode(course.flightMode);
  resetDrone();
  lookTarget.set(worldXZ.x, 0.5, worldXZ.z);
}

// --- M4/M5: 受験（課目単体=practice／3課目通し=series）・リプレイ・履歴 ---
let appMode: AppMode = 'free';
let session: ExamSession | null = null;
let series: ExamSeries | null = null;
/** 通し試験の総合結果（課目別レポートの「総合成績を見る」から表示する） */
let pendingSeries: ExamSeriesResult | null = null;
/** 通し試験「不合格でも続行」設定（startSeries時にパネルから確定） */
let seriesContinueOnFail = false;
/** 通し試験をユーザーが中止したか（abortExam→finishSeriesUiで履歴記録を抑止するフラグ） */
let seriesAborting = false;
const voice = new InstructorVoice();
const beep = new WarningBeep();
const history = new ScoreHistory();
const examEvents: ExamEvent[] = [];
let declarePrev = false;
// ExamSampleはdrone.stateの参照を使い回す（毎ステップのアロケーション回避。modeのみ毎回更新）
const examSample = {
  p: drone.state.p,
  v: drone.state.v,
  q: drone.state.q,
  mode: drone.mode,
};

// リプレイ（記録は課目単体受験のみ=練習モード機能。再生は保存/読込どちらのデータも可）
let recorder: ReplayRecorder | null = null;
let lastRecording: ReplayRecording | null = null;
let loadedRecording: ReplayRecording | null = null;
let player: ReplayPlayer | null = null;
let playbackT = 0;
/** リプレイ再生中の水平対地速度 [m/s]（物理が止まるため位置差分から算出・HUD表示用） */
let replaySpeedMs = 0;
const replayBuf = {
  p: { x: 0, y: 0, z: 0 },
  q: { x: 0, y: 0, z: 0, w: 1 },
  mode: 'gps' as FlightMode,
};
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function examBusy(): boolean {
  return (session !== null && !session.finished) || (series !== null && !series.finished);
}

function unlockAudio(): void {
  // クリックハンドラ内でAudio/TTSをアンロック（Chromeの自動再生制限対策）
  beep.resume();
  voice.prime();
}

function wireSessionUiCallbacks(): {
  onInstruction: (i: { text: string }) => void;
  onWarning: (w: { message: string }) => void;
} {
  return {
    onInstruction: (i) => {
      examPanel.showInstruction(i.text);
      voice.speak(i.text);
    },
    onWarning: (w) => {
      beep.warning();
      examPanel.flashWarning(w.message);
    },
  };
}

function addHistoryFromResult(r: ExamResult, kind: 'practice' | 'exam'): void {
  history.add({
    at: new Date().toISOString(),
    kind,
    courseId: r.courseId,
    label: r.courseName,
    machineId: MACHINES[machineIndex].id,
    points: r.points,
    passed: r.passed,
    failCode: r.failCode,
    endReason: r.endReason,
    elapsedS: r.elapsedS,
  });
}

// --- 課目単体の受験（練習モード: 区画帯は表示可・ミニマップあり・リプレイ記録） ---
function startPractice(): void {
  if (examBusy() || appMode === 'replay') return;
  unlockAudio();
  const course = COURSES[courseIndex];
  drone.setMode(course.flightMode);
  resetDrone();
  declarePrev = false;
  appMode = 'practice';
  practicePanel.setEnabled(false);
  recorder = new ReplayRecorder(MACHINES[machineIndex].id, course.id);
  session = new ExamSession({
    course,
    machineRadiusM: drone.profile.radiusM,
    random: Math.random,
    direction: 'random',
    ...wireSessionUiCallbacks(),
    onDeduction: (d) => {
      if (d.immediate) beep.fail();
      else beep.deduct();
      examPanel.addToast(d);
      recorder?.addEvent(d);
      if (session) examPanel.setScore(session.points);
    },
    onFinished: (r) => {
      voice.cancel();
      appMode = 'free';
      examPanel.setIdle();
      examPanel.setScore(r.points);
      practicePanel.setEnabled(true);
      lastRecording = recorder?.finish() ?? null;
      recorder = null;
      practicePanel.setReplayAvailable(lastRecording !== null, hasPlayableRecording());
      if (r.endReason !== 'aborted') {
        addHistoryFromResult(r, 'practice');
        practicePanel.setStatus(`リプレイ記録済み: ${r.courseName}（保存/再生できます）`);
        examPanel.showReport(r, course);
      }
    },
  });
  examPanel.setRunning(course.name);
  examPanel.setScore(session.points);
}

// --- 試験モード3課目通し（区画帯/ミニマップ非表示・カメラ定点固定・持ち点100共通） ---
function startSeries(): void {
  if (examBusy() || appMode === 'replay') return;
  unlockAudio();
  appMode = 'series';
  declarePrev = false;
  pendingSeries = null;
  seriesAborting = false;
  seriesContinueOnFail = examPanel.getContinueOnFail();
  practicePanel.setEnabled(false);
  minimap.setVisible(false);
  series = new ExamSeries({
    courses: COURSES,
    machineRadiusM: drone.profile.radiusM,
    random: Math.random,
    direction: 'random',
    continueOnFail: seriesContinueOnFail,
    ...wireSessionUiCallbacks(),
    onDeduction: (d) => {
      if (d.immediate) beep.fail();
      else beep.deduct();
      examPanel.addToast(d);
      if (series) examPanel.setScore(series.points);
    },
    onCourseFinished: (r, idx) => {
      voice.cancel();
      if (r.endReason === 'aborted') return; // 中止時はレポートを出さない
      // 課目ごとに減点内訳＋上面図の軌跡レポートを出す（共通ルール「即不合格→内訳レポート」対応）
      const hasNext = idx + 1 < COURSES.length;
      const willContinue = hasNext && (r.endReason === 'completed' || seriesContinueOnFail);
      if (willContinue) {
        examPanel.showReport(r, COURSES[idx], {
          primaryLabel: `次の課目（${COURSES[idx + 1].name}）へ`,
          onPrimary: continueSeries,
          closeLabel: '中断して閉じる',
          onClose: abortExam,
        });
      } else {
        // シリーズ終了（最終課目完走 or 不合格）: この課目の内訳を出し、総合成績へ誘導
        examPanel.showReport(r, COURSES[idx], {
          primaryLabel: '総合成績を見る',
          onPrimary: () => {
            if (pendingSeries) examPanel.showSeriesReport(pendingSeries, COURSES);
          },
        });
      }
    },
    onSeriesFinished: (sr) => {
      voice.cancel();
      pendingSeries = sr;
      finishSeriesUi(sr); // 履歴記録・後始末（総合レポートは課目レポートのボタンから開く）
    },
  });
  setCourse(0); // 4-1から。H再配置・ATTI等はsetCourseが行う
  markers?.setZonesVisible(false);
  series.start();
  examPanel.setRunning(`試験 ${COURSES[0].name}`);
  examPanel.setScore(series.points);
}

/** 課目間の「次の課目へ」: 機体を次課目のHへ再配置してから次セッションを開始（スコア持ち越し） */
function continueSeries(): void {
  if (!series || !series.awaitingNext) return;
  examPanel.hideReport();
  setCourse(series.courseIndex);
  markers?.setZonesVisible(false);
  declarePrev = false;
  series.start();
  examPanel.setRunning(`試験 ${series.course.name}`);
  examPanel.setScore(series.points);
}

function finishSeriesUi(sr: ExamSeriesResult): void {
  appMode = 'free';
  examPanel.setIdle();
  examPanel.setScore(sr.points);
  practicePanel.setEnabled(true);
  practicePanel.setReplayAvailable(lastRecording !== null, hasPlayableRecording());
  markers?.setZonesVisible(zonesVisible);
  minimap.setVisible(true);
  const lastR = sr.results[sr.results.length - 1] ?? null;
  // ユーザー中止（課目実行中・課目間のどちらもabortExam経由でseriesAbortingが立つ）は履歴に残さない。
  // 直前課目の合否に依らず「中止して閉じる」/Rは一律に中止扱いにする（continueOnFail時も含む）。
  const userAborted = seriesAborting || lastR === null;
  if (!userAborted && lastR !== null) {
    history.add({
      at: new Date().toISOString(),
      kind: 'exam',
      courseId: 'series',
      label: '試験（3課目通し）',
      machineId: MACHINES[machineIndex].id,
      points: sr.points,
      passed: sr.passed,
      failCode: lastR.failCode,
      endReason: sr.endedEarly ? lastR.endReason : 'completed',
      elapsedS: sr.results.reduce((acc, r) => acc + r.elapsedS, 0),
    });
  }
  seriesAborting = false;
  series = null;
}

function abortExam(): void {
  if (series && !series.finished) {
    // 課目間レポート表示中にRで中止するとモーダルが残るため明示的に閉じる
    examPanel.hideReport();
    seriesAborting = true;
    series.abort();
  } else {
    session?.abort();
  }
}

// --- リプレイ再生 ---
function hasPlayableRecording(): boolean {
  return loadedRecording !== null || lastRecording !== null;
}

function startReplay(): void {
  if (examBusy() || appMode === 'replay') return;
  const rec = loadedRecording ?? lastRecording;
  if (!rec) return;
  const idx = COURSES.findIndex((c) => c.id === rec.courseId);
  if (idx < 0) {
    practicePanel.setStatus(`再生不可: 未知の課目id「${rec.courseId}」`);
    return;
  }
  setCourse(idx);
  appMode = 'replay';
  player = new ReplayPlayer(rec);
  playbackT = 0;
  practicePanel.setReplayPlaying(true);
  const machineNote =
    rec.machineId === MACHINES[machineIndex].id ? '' : `（記録機体: ${rec.machineId}）`;
  practicePanel.setStatus(`リプレイ再生中: ${COURSES[idx].name}${machineNote}`);
}

function stopReplay(): void {
  if (appMode !== 'replay') return;
  appMode = 'free';
  player = null;
  practicePanel.setReplayPlaying(false);
  practicePanel.setStatus('リプレイ再生を終了しました');
  resetDrone();
}

function saveReplay(): void {
  if (!lastRecording) return;
  const blob = new Blob([serializeReplay(lastRecording)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `replay-${lastRecording.courseId}-${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function loadReplayFile(file: File): void {
  file
    .text()
    .then((text) => {
      loadedRecording = parseReplay(text);
      practicePanel.setReplayAvailable(lastRecording !== null, true);
      practicePanel.setStatus(
        `リプレイ読込OK: 課目${loadedRecording.courseId}・機体${loadedRecording.machineId}・${loadedRecording.samples.length}サンプル`,
      );
    })
    .catch((e: unknown) => {
      practicePanel.setStatus(`リプレイ読込失敗: ${e instanceof Error ? e.message : String(e)}`);
    });
}

// --- パネル生成 ---
const examPanel = new ExamPanel(app, sideCol, {
  onStartPractice: startPractice,
  onStartSeries: startSeries,
  onAbort: abortExam,
  getHistory: () => history.list(),
  onClearHistory: () => history.clear(),
  onMinimalHud: (v) => setMinimalHud(v),
});

const practicePanel = new PracticePanel(sideCol, {
  onMachine: (i) => {
    machineIndex = i;
    drone.setProfile(MACHINES[i]);
  },
  onWindPreset: setWindPreset,
  onWindCustom: setWindCustom,
  onScene: setScene,
  onCamera: (mode) => {
    cameraMode = mode;
    if (mode === 'pilot') {
      const course = COURSES[courseIndex];
      courseToWorld(course.pilot.x, course.pilot.z, worldXZ);
      camera.position.set(worldXZ.x, course.pilot.eyeHeightM, worldXZ.z);
    }
  },
  onZones: (v) => {
    zonesVisible = v;
    markers?.setZonesVisible(v && appMode !== 'series');
  },
  onReplaySave: saveReplay,
  onReplayLoad: loadReplayFile,
  onReplayPlay: startReplay,
  onReplayStop: stopReplay,
});

const minimap = new MiniMap(app);

let minimalHud = false;
function setMinimalHud(v: boolean): void {
  minimalHud = v;
  hud.classList.toggle('hud-minimal', v);
  examPanel.setMinimalHudChecked(v);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') {
    if (appMode === 'replay') {
      stopReplay();
      return;
    }
    if (examBusy()) abortExam();
    resetDrone();
  } else if (e.code === 'KeyH') {
    setMinimalHud(!minimalHud);
  } else if (appMode === 'replay') {
    return; // 再生中はR/H以外無効
  } else if (examBusy()) {
    // 受験中: 練習モード（課目単体）のみ区画帯トグルを許可（仕様: 区画表示は練習モードのみ表示可）
    if (e.code === 'KeyZ' && series === null) {
      zonesVisible = !zonesVisible;
      markers?.setZonesVisible(zonesVisible);
      practicePanel.setZonesChecked(zonesVisible);
    }
  } else if (e.code === 'KeyM') {
    drone.setMode(drone.mode === 'gps' ? 'atti' : 'gps');
  } else if (e.code === 'KeyV') {
    // 開発用: 風プリセットを順送り（パネルの選択表示とはズレることがある。正はパネル）
    windSeedCounter++;
    setWindPreset(windSeedCounter % WIND_PRESETS.length);
  } else if (e.code === 'KeyC') {
    machineIndex = (machineIndex + 1) % MACHINES.length;
    drone.setProfile(MACHINES[machineIndex]);
    practicePanel.setMachineValue(machineIndex);
  } else if (e.code === 'KeyZ') {
    zonesVisible = !zonesVisible;
    markers?.setZonesVisible(zonesVisible);
    practicePanel.setZonesChecked(zonesVisible);
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

const WIND_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
/** 風が吹いていく向きの矢印（画面基準: ↑=奥へ・→=右へ・↓=受験者側へ）。world→course（z反転）を考慮 */
function windArrow(wx: number, wz: number): string {
  const a = Math.atan2(wx, -wz); // 0=奥(-z)方向・+x側が正
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return WIND_ARROWS[idx];
}

/** 進行中の受験セッション（practice or 試験通しの現課目）。HUDの経過/制限表示用 */
function activeExamSession(): ExamSession | null {
  if (series !== null && !series.finished) return series.session;
  if (session !== null && !session.finished) return session;
  return null;
}

/** 区画HUDの文言（常時判定の目視用。採点の正はExamSessionのフェーズゲーティング） */
function buildZoneText(): { text: string; cls: string } {
  // 試験モード通しは実試験どおり目測で飛ぶ体験にするため区画の生判定を伏せる（採点ヒントを出さない）
  if (appMode === 'series') {
    return { text: '（試験中は非表示）', cls: 'zone-free' };
  }
  if (appMode === 'replay' && player !== null) {
    return {
      text: `リプレイ再生中 ${playbackT.toFixed(1)}s / ${player.durationS.toFixed(1)}s`,
      cls: 'zone-free',
    };
  }
  const course = COURSES[courseIndex];
  worldToCourse(currSnap.x, currSnap.z, courseXZ);
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
  if (
    pylonCollisionIndex(courseXZ.x, courseXZ.z, currSnap.y, drone.profile.radiusM, course.pylons) >=
    0
  ) {
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

    // --- リプレイ再生: 物理を止め、記録サンプルの補間で機体を動かす ---
    if (appMode === 'replay' && player !== null) {
      playbackT += dt;
      player.sampleAt(player.startT + playbackT, replayBuf);
      tmpQuat.set(replayBuf.q.x, replayBuf.q.y, replayBuf.q.z, replayBuf.q.w);
      tmpEuler.setFromQuaternion(tmpQuat, 'YXZ');
      currSnap.x = replayBuf.p.x;
      currSnap.y = replayBuf.p.y;
      currSnap.z = replayBuf.p.z;
      // FlightDynamics.syncQuatの逆変換: rotation.y=yaw / rotation.x=-pitch / rotation.z=-roll
      currSnap.yawRad = tmpEuler.y;
      currSnap.pitchRad = -tmpEuler.x;
      currSnap.rollRad = -tmpEuler.z;
      currSnap.rotorSpin += 55 * dt;
      // 物理vが凍結するため、再生位置の差分から水平速度をHUD用に算出
      replaySpeedMs = dt > 0 ? Math.hypot(currSnap.x - prevSnap.x, currSnap.z - prevSnap.z) / dt : 0;
      if (playbackT > player.durationS + 0.8) stopReplay();
      return;
    }

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
    // --- 受験（practice/series）へサンプル＋イベント（宣言・突風）を毎ステップ供給 ---
    const windCount = wind.drainEvents(windEvents);
    const target = series ?? session;
    if (target && !target.finished) {
      examEvents.length = 0;
      const declareNow = keyboard.declarePressed || gamepad.declarePressed;
      if (declareNow && !declarePrev) examEvents.push({ t: tSim, type: 'declare' });
      declarePrev = declareNow;
      for (let i = 0; i < windCount; i++) {
        examEvents.push({ t: windEvents[i].t, type: windEvents[i].type });
      }
      examSample.mode = drone.mode;
      target.step(tSim, examSample, examEvents);
    }
    // リプレイ記録（課目単体受験のみ。recorderの生成/確定はstartPractice/onFinished）
    recorder?.record(tSim, drone.state.p, drone.state.q, drone.mode);
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

    // カメラ: 試験モード通しは操縦者定点固定。それ以外は選択（定点/俯瞰/追従）
    if (appMode === 'series' || cameraMode === 'pilot') {
      lookGoal.set(x, y + 0.1, z);
      lookTarget.lerp(lookGoal, 0.18);
      camera.lookAt(lookTarget);
    } else if (cameraMode === 'overhead') {
      camera.position.set(courseCenterW.x, 20, courseCenterW.z + 0.02);
      lookGoal.set(courseCenterW.x, 0, courseCenterW.z);
      camera.lookAt(lookGoal);
    } else {
      // 追従: 機首の後方4.2m・上方1.9mからなめらかに追う
      chaseGoal.set(x + Math.sin(yaw) * 4.2, y + 1.9, z + Math.cos(yaw) * 4.2);
      camera.position.lerp(chaseGoal, 0.1);
      lookGoal.set(x, y + 0.3, z);
      camera.lookAt(lookGoal);
    }

    // ミニマップ（コース座標へ変換。ヘディングは -ワールドyaw=コース方位）
    worldToCourse(x, z, courseXZ);
    minimap.update(courseXZ.x, courseXZ.z, -yaw);

    const altText = `${y.toFixed(1)} m`;
    if (altText !== lastAlt) {
      hudAlt.textContent = altText;
      lastAlt = altText;
    }
    const spdMs = appMode === 'replay' ? replaySpeedMs : horizontalSpeed(drone.state.v);
    const spdText = `${spdMs.toFixed(1)} m/s`;
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
    const windDir = windNow > 0.1 ? `${windArrow(wind.current.x, wind.current.z)} ` : '';
    const windText = `${windLabel}｜${windDir}${windNow.toFixed(1)} m/s`;
    if (windText !== lastWind) {
      hudWind.textContent = windText;
      lastWind = windText;
    }
    const machineText = MACHINES[machineIndex].name;
    if (machineText !== lastMachine) {
      hudMachine.textContent = machineText;
      lastMachine = machineText;
    }
    // 時間: 受験中=経過/制限（起点は離陸指示の発話開始）・リプレイ中=再生位置・平常=シム時間
    const activeS = activeExamSession();
    let timeText: string;
    if (appMode === 'replay' && player !== null) {
      timeText = `再生 ${formatTime(playbackT)} / ${formatTime(player.durationS)}`;
    } else if (activeS !== null) {
      const e = activeS.examElapsedS;
      timeText =
        e === null
          ? `--:-- / ${formatTime(activeS.timeLimitS)}`
          : `${formatTime(e)} / ${formatTime(activeS.timeLimitS)}`;
    } else {
      timeText = formatTime(loop.simTime);
    }
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
