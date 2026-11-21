// 앱 본체: 화면 흐름과 각 모듈 연결.
//
// 주소 옵션
//   ?map=station     사용할 지도 (maps/<이름>.json)
//   ?m=A1            QR을 폰 기본 카메라로 찍어 들어온 경우의 마커 ID
//   ?sim=1           가상 역 모드 (카메라 대신 3D 역을 걷는다)
//   ?dest=toilet     목적지를 바로 정하고 안내 화면으로 (시연용)
//   ?lang=en         언어 고정
//   ?debug=1         추정값 표시
//   ?fov=65          카메라 긴 변 화각(도) 가정값
//   ?stride=0.65     보폭(m) 가정값
//   ?stepth=0.9      걸음으로 치는 흔들림 크기(m/s²). 걸음이 안 세어지면 낮춘다
//   ?slam=1          카메라 움직임 추적(SLAM)으로 QR 사이의 이동을 잰다 (걸음 수 대신). 놓치면 걸음 수로 돌아간다
//   ?slamdrop=20-26  (가상 역) 그 시간(초) 동안 추적을 놓친 것으로 흉내 낸다. 여러 구간은 쉼표로
//   ?slamheight=0.5  (가상 역) 흉내 낸 추적기가 높이를 실제의 0.5배로 말하게 한다 (단위 환산이 틀어지는 상황)
//   ?vp=0            영상의 복도 선으로 방향을 맞추는 기능 끄기 (비교용)
//   ?walkyaw=0       걸은 방향으로 방향을 맞추는 대비책 끄기 (비교용)
//   ?turnsnap=0      모퉁이를 돈 순간 위치를 모퉁이에 맞추는 기능 끄기 (비교용)
//   ?hold=5          (가상 역, walker=truth와 함께) 폰을 걷는 방향에서 오른쪽으로 5도 틀어 들고 걷는다
//   ?walker=truth    (가상 역) 자동 보행자가 앱의 화살표가 아니라 실제 복도를 따라 걷는다.
//                    사람은 눈에 보이는 복도를 따라 걷기 때문에, 화살표가 실제와 얼마나 어긋나는지 재는 데 쓴다

import { LANGS, detectLang } from './i18n.js';
import { loadMap } from './mapdata.js';
import { poiType, poiName, poiIcon, poiDetail, matchDestination } from './destinations.js';
import { buildRoute } from './route.js';
import { Guide } from './guide.js';
import { Localizer } from './localizer.js';
import { intrinsicsFor } from './pose.js';
import { createDetector, detectMarkers } from './detector.js';
import { startCamera, stopCamera, OrientationTracker, requestMotionPermission } from './sensors.js';
import { StepDetector } from './steps.js';
import { ARView } from './ar.js';
import { MiniMap } from './minimap.js';
import { drawTurnGlyph } from './glyphs.js';
import { canListen, listenOnce, speak, stopSpeaking, unlockSpeech } from './voice.js';
import { angDiff, bearingXY, deg, rad, distXY } from './geo.js';
import { headingOf, pitchOf, qRotate, qConj, qMul, yawQuat } from './orient-math.js';
import { corridorHistogram, findPeak } from './vanish.js';
import { VisualOdometer, SimTracker } from './tracker.js';

const CAMERA_LATENCY_MS = 60; // 카메라 영상이 센서 값보다 늦게 도착하는 시간 가정
const MAX_TURN_RATE = 45; // 폰이 이보다 빨리 도는 중에 찍힌 장면은 위치 계산에 쓰지 않는다 (도/초)
const OFF_ROUTE_ON_FIX = 2.2; // QR로 잡은 위치가 경로에서 이만큼 벗어나면 새 경로를 찾는다 (m)
const SNAP_RANGE = 3; // 걸음 추정 중 이 거리 안이면 경로 쪽으로 당긴다 (m)
const RESCAN_AFTER = 18; // QR 없이 이만큼 걸으면 다시 비추라고 알린다 (m)
const SLAM_LATENCY_MS = 90; // 추적 엔진이 그린 화면이 센서 값보다 늦는 시간 가정
const VO_TICK = 0.5; // 카메라 추적으로 이만큼 이동할 때마다 안내를 갱신한다 (m)
const VO_RESCAN_AFTER = 45; // 카메라 추적 중에는 이만큼 가고 나서 QR을 다시 비추라고 알린다 (m)
const SIGHTING_GAP_MS = 1500; // 이만큼 QR이 안 보이다 다시 보이면 새로 보기 시작한 것으로 친다
const TURN_SNAP_BEFORE = 4.5; // 추정 위치가 모퉁이의 이만큼 앞부터
const TURN_SNAP_AFTER = 3; // 이만큼 뒤 사이에 있을 때만 모퉁이에 맞춘다 (m)
const DISPLAY_LEAD_MS = 120; // 화면 위치를 부드럽게 만드느라 생기는 지연만큼 앞서 그린다
const SHARP_TURN = 50; // 이 각도 이상 꺾이면 모퉁이로 본다 (도)
const TURN_LEAD = 2.2; // 모퉁이를 지나 이만큼까지만 화살표를 미리 그린다 (m)
const VP_WIDTH = 240; // 복도 방향을 찾을 때 쓰는 줄인 영상의 폭 (픽셀)
const VP_WINDOW = 20; // 지금 추정한 방향에서 이 각도 안쪽의 복도 선만 믿는다 (도)
const VP_MEMORY_MS = 2000; // 영상에서 잰 방향 오차를 이만큼 모아서 본다
const VP_MIN_SPAN_MS = 500; // 적어도 이만큼의 시간에 걸쳐 잰 값이어야 한다 (걸을 때 좌우로 흔들리는 주기의 절반)
const VP_MIN_COUNT = 4;
const WALK_YAW_STEPS = 6; // 영상으로 못 맞출 때, 이만큼의 걸음 방향을 모아 통로 방향과 비교한다

// 자동으로 맞춘 보폭을 기억하는 이름. 맞추는 방식이 바뀌면 숫자를 올려 예전 값을 버린다.
const STRIDE_KEY = 'iriro.stride.v3';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 주소 옵션. 두 번째 옵션부터는 &로 이어야 하지만, ?로 이어 쓴 주소(?map=a?debug=1)도 알아듣게 한다.
const QUERY = location.search.replace(/(?!^)\?/g, '&');
const P = new URLSearchParams(QUERY);

/** 지난번에 자동으로 맞춰 둔 보폭 (이 기기, 이 브라우저) */
function savedStride() {
  try {
    const v = parseFloat(localStorage.getItem(STRIDE_KEY));
    return v >= 0.45 && v <= 0.95 ? v : 0;
  } catch (e) {
    return 0;
  }
}

const cfg = {
  mapId: P.get('map') || 'station',
  sim: P.get('sim') === '1',
  debug: P.get('debug') === '1',
  fovLong: parseFloat(P.get('fov')) || 65,
  stride: parseFloat(P.get('stride')) || savedStride() || 0.65,
  strideFixed: !!parseFloat(P.get('stride')), // 주소에 직접 적었으면 자동으로 바꾸지 않는다
  stepThreshold: parseFloat(P.get('stepth')) || 0.9,
  slam: P.get('slam') === '1',
  slamDrops: (P.get('slamdrop') || '')
    .split(',')
    .map((x) => x.split('-').map(Number))
    .filter((x) => x.length === 2 && x[1] > x[0]),
  vp: P.get('vp') !== '0',
  walkYaw: P.get('walkyaw') !== '0',
  turnSnap: P.get('turnsnap') !== '0',
  walker: P.get('walker') || 'app',
  startMarker: P.get('m'),
  dest: P.get('dest'),
  lang: P.get('lang'),
};

const st = {
  lang: 'ko',
  t: LANGS.ko,
  map: null,
  poi: null, // 고른 목적지
  route: null,
  guide: null,
  g: null, // 최근 안내 상태
  loc: null,
  orient: new OrientationTracker(),
  steps: null,
  detector: null,
  detectorReady: false,
  detectRun: 0,
  detMs: 0,
  ar: null,
  mini: null,
  sim: null,
  walker: null,
  autoWalk: true,
  running: false,
  voiceOn: true,
  disp: null, // 화면에 쓰는 위치 (부드럽게 따라간다)
  heading: 0,
  arrivedShown: false,
  edge: null,
  lookDownSince: 0,
  lastMini: 0,
  lastDebug: 0,
  lastRescanHint: -Infinity,
  lastNoRoute: -Infinity,
  routeOff: { x: 0, y: 0 }, // 화살표를 발밑에서 시작하게 하려고 경로를 옆으로 옮겨 그리는 거리
  vpCanvas: null,
  vpErrs: [], // 최근에 영상에서 잰 방향 오차들 (지금의 방향 보정값 기준)
  vpDeltaRef: 0, // vpErrs가 기준으로 삼은 방향 보정값
  vpInfo: null, // 가장 최근에 영상에서 찾은 복도 방향 (디버그 표시용)
  vpSeenT: -Infinity, // 영상에서 복도 방향을 마지막으로 찾은 시각
  vpFixes: 0,
  vpTotal: 0, // 영상으로 바로잡은 각도의 합 (디버그 표시용)
  vpMid: null, // 최근 영상 측정값들의 가운데 값 (0에 가까우면 방향이 맞아 있다)
  vpMidT: -Infinity,
  walkDev: [], // 최근 걸음들의 "걸은 방향 - 통로 방향"
  walkYawFixes: 0,
  holdBias: 0, // 이 사람이 폰을 드는 버릇: 방향이 맞아 있을 때의 "걸은 방향 - 통로 방향" 평균
  holdBiasN: 0,
  lastFixS: null, // 직전에 QR로 위치를 잡았을 때의 경로상 위치 (보폭 보정용)
  turn: { idx: -1, steps: 0, done: new Set() }, // 모퉁이 맞추기 진행 상태
  turnSnaps: 0,
  vo: null, // 카메라 움직임 추적기 (눈으로 보는 주행 거리계). ?slam=1일 때만 만든다
  voK: null, // 추적기의 길이 단위를 미터로 맞추는 데 쓰는 값들
  xr: null, // 실제 추적 엔진 (켜져 있을 때)
  xrProj: null, // 엔진이 알려 준 투영 행렬
  simTracker: null, // (가상 역) 흉내 낸 추적기
  truthGuide: null, // (가상 역) 실제 위치 기준의 진행 상황
  truthRoute: null,
  lastError: null, // 마지막으로 난 오류 (디버그 화면에 표시)
  toastTimer: null,
  snap: null,
  stageW: 1,
  stageH: 1,
};

/**
 * 폰에서 일어난 일을 노트북의 서버(serve.py)에 남긴다 → diag/client.log.
 * 폰에서는 콘솔을 볼 수 없어서, 무엇이 안 됐는지 알려면 이 기록이 필요하다.
 * ?debug=1 이나 ?slam=1 로 열었을 때만 보내고, 서버가 받지 않으면(정적 호스팅 등) 조용히 넘어간다.
 */
function report(event, data = {}) {
  if (!(cfg.debug || cfg.slam)) return;
  try {
    fetch('client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ event, ms: Math.round(performance.now()), map: cfg.mapId, ...data }).slice(0, 15000),
    }).catch(() => {});
  } catch (e) {
    /* 보내지 못해도 앱 동작에는 지장 없다 */
  }
}

// 폰에서는 콘솔을 볼 수 없으므로, 오류가 나면 디버그 화면에 그대로 보여 주고 서버에도 남긴다
window.addEventListener('error', (e) => {
  st.lastError = `${e.message || e.error || 'error'}`;
  report('error', { message: st.lastError, at: `${(e.filename || '').split('/').pop()}:${e.lineno || 0}` });
});
window.addEventListener('unhandledrejection', (e) => {
  st.lastError = `${(e.reason && e.reason.message) || e.reason || 'rejected promise'}`;
  report('rejection', { message: st.lastError });
});

init();

async function init() {
  st.lang = LANGS[cfg.lang] ? cfg.lang : detectLang();
  st.t = LANGS[st.lang];
  buildLangButtons();
  applyStaticText();
  try {
    st.map = await loadMap(cfg.mapId);
  } catch (e) {
    console.error(e);
    $('homeError').textContent = `${st.t.mapError} (${cfg.mapId})`;
    $('startBtn').disabled = true;
    return;
  }
  applyLang();
  wireEvents();
  if (cfg.debug) $('debug').classList.remove('hidden');
  // QR 인식기(웹어셈블리)를 미리 받아 둔다. 안내 화면에서 기다리지 않고,
  // 서버(노트북)에서 멀어져 와이파이가 끊긴 뒤에도 인식이 된다.
  st.detector = createDetector();
  const blank = document.createElement('canvas');
  blank.width = blank.height = 8;
  detectMarkers(st.detector, blank).then(() => {
    st.detectorReady = true;
  });
  window.__iriro = { st, cfg, startNavById };
  if (cfg.dest) startNavById(cfg.dest);
}

function startNavById(id) {
  const poi = st.map.pois.find((p) => p.id === id);
  if (poi) startNav(poi);
  return !!poi;
}

// ---------------------------------------------------------------- 화면 문구

function buildLangButtons() {
  const box = $('langs');
  box.innerHTML = '';
  for (const [code, l] of Object.entries(LANGS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lang' + (code === st.lang ? ' on' : '');
    b.textContent = l.label;
    b.addEventListener('click', () => {
      st.lang = code;
      st.t = l;
      buildLangButtons();
      if (st.map) applyLang();
      else applyStaticText();
    });
    box.appendChild(b);
  }
}

function applyStaticText() {
  const t = st.t;
  document.documentElement.lang = st.lang;
  $('appName').textContent = t.appName;
  $('tagline').textContent = t.tagline;
  $('startBtn').textContent = t.start;
  $('simBtn').textContent = t.tryDemo;
  $('simBtn').classList.toggle('hidden', cfg.sim);
  $('permHint').textContent = cfg.sim ? t.simHint : t.permHint;
}

function applyLang() {
  const t = st.t;
  applyStaticText();

  const near = cfg.startMarker && st.map.markerById.get(cfg.startMarker);
  $('nearInfo').classList.toggle('hidden', !near);
  if (near) $('nearInfo').textContent = t.youAreNear(near.label || near.id);

  $('whereTo').textContent = t.whereTo;
  $('micLabel').textContent = t.speakBtn;
  $('micBtn').classList.toggle('hidden', !canListen);
  $('typeInput').placeholder = t.typeHint;
  $('typeBtn').textContent = t.search;

  $('exitBtn').textContent = t.exit;
  $('voiceBtn').textContent = st.voiceOn ? t.voiceOn : t.voiceOff;
  $('scanSub').textContent = t.scanSub;
  $('simBadge').textContent = t.simBadge;
  $('autoBtn').textContent = st.autoWalk ? t.simAuto : t.simManual;
  $('walkBtn').textContent = t.simWalk;
  $('arrivedTitle').textContent = t.arrivedTitle;
  $('againBtn').textContent = t.again;
  $('edgeLText').textContent = t.edgeLeft;
  $('edgeRText').textContent = t.edgeRight;
  buildDestList();
  if (st.poi) $('destName').textContent = `${poiIcon(st.poi)} ${poiName(st.poi, st.lang)}`;
  if (st.g) renderHud(st.g);
}

/** 목적지 목록. QR을 찍고 들어왔으면 그 위치에서의 거리도 보여 준다. */
function buildDestList() {
  const t = st.t;
  const origin = cfg.startMarker ? st.map.markerById.get(cfg.startMarker) : null;
  const list = $('destList');
  list.innerHTML = '';
  for (const group of ['exits', 'platforms', 'facilities']) {
    const pois = st.map.pois.filter((p) => poiType(p).group === group);
    if (!pois.length) continue;
    const h = document.createElement('h3');
    h.textContent = t.groups[group];
    list.appendChild(h);
    const box = document.createElement('div');
    box.className = group === 'exits' ? 'exit-grid' : 'dest-rows';
    for (const poi of pois.sort((a, b) => (a.number || 0) - (b.number || 0))) {
      box.appendChild(destButton(poi, origin, group === 'exits'));
    }
    list.appendChild(box);
  }
}

function destButton(poi, origin, asTile) {
  const b = document.createElement('button');
  b.type = 'button';
  const route = origin ? st.map.routeTo(origin, poi) : null;
  const dist = route ? st.t.dist(route.length) : '';
  if (asTile && poi.number != null) {
    b.className = 'exit-tile';
    b.innerHTML = `<span class="num"></span><span class="lbl"></span>`;
    b.querySelector('.num').textContent = poi.number;
    b.querySelector('.lbl').textContent = dist || st.t.groups.exits;
    b.setAttribute('aria-label', poiName(poi, st.lang));
  } else {
    b.className = 'dest-row';
    b.innerHTML = `<span class="ic"></span><span class="tx"><b></b><small></small></span><span class="ds"></span>`;
    b.querySelector('.ic').textContent = poiIcon(poi);
    b.querySelector('b').textContent = poiName(poi, st.lang);
    b.querySelector('small').textContent = poiDetail(poi, st.lang);
    b.querySelector('.ds').textContent = dist;
  }
  b.addEventListener('click', () => startNav(poi));
  return b;
}

function show(id) {
  for (const s of ['home', 'dest', 'arrived']) $(s).classList.toggle('hidden', s !== id);
  $('nav').classList.toggle('hidden', id !== 'nav' && id !== 'arrived');
}

function toast(text, ms = 3000) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(st.toastTimer);
  st.toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function say(text, urgent = false) {
  if (st.voiceOn) speak(text, st.t.speechLang, { urgent });
}

// ---------------------------------------------------------------- 버튼 연결

function wireEvents() {
  $('startBtn').addEventListener('click', onStart);
  $('simBtn').addEventListener('click', () => {
    const q = new URLSearchParams(QUERY);
    q.set('sim', '1');
    q.set('lang', st.lang);
    location.search = q.toString();
  });

  $('micBtn').addEventListener('click', onMic);
  $('typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleQuery([$('typeInput').value]);
  });

  $('exitBtn').addEventListener('click', stopNav);
  $('voiceBtn').addEventListener('click', () => {
    st.voiceOn = !st.voiceOn;
    if (!st.voiceOn) stopSpeaking();
    $('voiceBtn').textContent = st.voiceOn ? st.t.voiceOn : st.t.voiceOff;
  });
  $('againBtn').addEventListener('click', () => {
    st.route = null;
    st.guide = null;
    st.g = null;
    if (st.ar) st.ar.clearRoute();
    show('dest');
  });
  $('mini').addEventListener('click', () => $('mini').classList.toggle('big'));

  // 가상 역 조작
  $('autoBtn').addEventListener('click', () => {
    st.autoWalk = !st.autoWalk;
    $('autoBtn').textContent = st.autoWalk ? st.t.simAuto : st.t.simManual;
    $('walkBtn').classList.toggle('hidden', st.autoWalk);
    if (st.sim) st.sim.input.walk = 0;
    if (!st.autoWalk) toast(st.t.simManualHint, 3500);
  });
  const walk = (on) => {
    if (st.sim && !st.autoWalk) st.sim.input.walk = on ? 1 : 0;
  };
  $('walkBtn').addEventListener('pointerdown', () => walk(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    $('walkBtn').addEventListener(ev, () => walk(false));
  }
  let drag = null;
  $('nav').addEventListener('pointerdown', (e) => {
    if (st.sim && !st.autoWalk && !e.target.closest('button, #mini')) drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || !st.sim) return;
    st.sim.pose.heading -= (e.clientX - drag.x) * 0.25;
    st.sim.pose.pitch = Math.max(-80, Math.min(45, st.sim.pose.pitch + (e.clientY - drag.y) * 0.2));
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (drag = null));
  window.addEventListener('keydown', (e) => keyMove(e, true));
  window.addEventListener('keyup', (e) => keyMove(e, false));

  window.addEventListener('resize', onResize);
}

function keyMove(e, down) {
  if (!st.sim || st.autoWalk) return;
  if (e.key === 'ArrowUp') st.sim.input.walk = down ? 1 : 0;
  else if (e.key === 'ArrowLeft') st.sim.input.turn = down ? -1 : 0;
  else if (e.key === 'ArrowRight') st.sim.input.turn = down ? 1 : 0;
  else return;
  e.preventDefault();
}

async function onStart() {
  unlockSpeech();
  if (!cfg.sim) {
    // 아이폰은 이 터치 안에서 센서 권한을 요청해야 한다
    const perm = await requestMotionPermission();
    if (perm.orientation === 'granted') st.orient.start();
    if (perm.motion === 'granted' && !st.steps) {
      st.steps = new StepDetector((n) => onSteps(n), cfg.stepThreshold);
      st.steps.start();
    }
  }
  show('dest');
}

// ---------------------------------------------------------------- 목적지 고르기

async function onMic() {
  const heard = $('heard');
  heard.textContent = st.t.listening;
  heard.classList.remove('hidden');
  $('candidates').innerHTML = '';
  $('micBtn').classList.add('on');
  const alts = await listenOnce(st.t.speechLang);
  $('micBtn').classList.remove('on');
  handleQuery(alts);
}

/** 말하거나 입력한 문장(후보 여러 개)으로 목적지를 찾아 보여 준다 */
function handleQuery(texts) {
  const t = st.t;
  const heard = $('heard');
  const box = $('candidates');
  box.innerHTML = '';
  heard.classList.remove('hidden');
  const list = texts.map((s) => (s || '').trim()).filter(Boolean);
  let used = list[0] || '';
  let cands = [];
  for (const s of list) {
    const c = matchDestination(s, st.map.pois);
    if (c.length) {
      cands = c;
      used = s;
      break;
    }
  }
  if (!cands.length) {
    heard.textContent = (used ? t.heard(used) + ' · ' : '') + t.notUnderstood;
    return;
  }
  heard.textContent = t.heard(used) + (cands.length > 1 ? ' · ' + t.chooseOne : '');
  for (const poi of cands) {
    const name = `${poiIcon(poi)} ${poiName(poi, st.lang)}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary';
    b.textContent = cands.length === 1 ? t.goBtn(name) : name;
    b.addEventListener('click', () => startNav(poi));
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- 안내 시작과 종료

async function startNav(poi) {
  st.poi = poi;
  st.route = null;
  st.guide = null;
  st.g = null;
  st.arrivedShown = false;
  if (st.ar) st.ar.clearRoute();
  show('nav');
  $('destName').textContent = `${poiIcon(poi)} ${poiName(poi, st.lang)}`;
  $('remain').textContent = '';
  $('hud').classList.add('hidden');

  const wasRunning = st.running;
  await ensureRunning();
  if (wasRunning && st.loc.hasFix) {
    planRoute(false); // 직전까지 위치를 알고 있었으면 바로 안내한다
  } else {
    say(st.t.speechScan);
  }
}

/** 카메라(또는 가상 역), 인식, 그리기를 시작한다. 이미 시작했거나 시작하는 중이면 한 번만 실행한다. */
function ensureRunning() {
  if (st.running) return Promise.resolve();
  if (!st.starting) {
    st.starting = startSystems().finally(() => {
      st.starting = null;
    });
  }
  return st.starting;
}

async function startSystems() {
  if (!st.ar) {
    st.ar = new ARView($('ar'));
    st.ar.setMap(st.map);
    st.mini = new MiniMap($('mini'), st.map);
  }
  st.loc = new Localizer(st.map, { stride: cfg.stride });
  st.disp = null;
  st.routeOff = { x: 0, y: 0 };
  st.vpErrs = [];
  st.vpDeltaRef = 0;
  st.vpSeenT = -Infinity;
  st.walkDev = [];

  if (cfg.sim) {
    if (!st.sim) {
      const mod = await import('./simworld.js');
      st.sim = new mod.SimWorld($('simcam'), st.map, st.lang);
      st.sim.hold = cfg.walker === 'truth' ? parseFloat(P.get('hold')) || 0 : 0;
      st.walker = new mod.AutoWalker(st.sim, st.map);
      st.sim.onStep = () => onSteps(1);
      st.snap = document.createElement('canvas');
    }
    if (cfg.slam) {
      // 추적기를 흉내 낸다: 임의의 방향·원점·단위를 쓰고, 정해 둔 시간에는 놓친다
      st.vo = newVo();
      st.simTracker = new SimTracker(st.sim, {
        drops: cfg.slamDrops,
        heightFactor: parseFloat(P.get('slamheight')) || 1,
      });
    }
    $('simcam').classList.remove('hidden');
    $('cam').classList.add('hidden');
    $('simBar').classList.remove('hidden');
    $('walkBtn').classList.toggle('hidden', st.autoWalk);
  } else {
    // ?slam=1이면 추적 엔진이 카메라를 연다. 켜지 못하면 평소처럼 카메라만 연다.
    if (!(cfg.slam && (await startSlam())) && !(await startCamera($('cam')))) toast(st.t.noCamera, 6000);
    // 기울기 센서가 없으면 화살표를 바닥에 맞춰 그릴 수 없다. 권한이 거부된 경우가 많아 알려 준다.
    setTimeout(() => {
      if (st.running && !st.orient.available) toast(st.t.noMotion, 7000);
    }, 2500);
  }

  if (!st.detector) st.detector = createDetector();
  onResize();
  st.running = true;
  st.lastFrame = performance.now();
  requestAnimationFrame(frame);
  detectLoop();
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
}

// ---------------------------------------------------------------- 카메라 움직임 추적 (?slam=1)

/** 추적기를 쓰고 있는가 (실제 엔진이든 가상 역의 흉내든) */
function voActive() {
  return !!(st.xr || st.simTracker);
}

function newVo() {
  const vo = new VisualOdometer();
  vo.onMove = onVoMove;
  st.voK = {
    s: 1, // 추적기 단위 하나가 몇 m인지
    n: 0, // 단위를 맞춰 본 횟수
    dN: 0, // 그 가운데 "이동 거리"로 맞춘 횟수 (높이로 맞춘 것보다 믿을 만하다)
    resets: 0,
    leg: { from: null, ux: 0, uy: 0, ok: false }, // 직전 QR 이후의 이동 (추적기 단위, 지도 방향)
    sight: null, // 지금 보고 있는 QR을 처음 본 뒤의 이동
    pend: { x: 0, y: 0 }, // 아직 안내에 반영하지 않은 이동 (m)
    pendU: 0, // 같은 이동을 추적기 단위로 잰 길이
    steps: 0, // 걸음 수로 잰 거리와 견주기 위한 걸음 수와
    units: 0, // 그동안 추적기가 잰 거리 (추적기 단위)
    winPos: null, // 견주기 시작할 때의 위치 (단위를 고치면 그 뒤의 이동도 다시 계산한다)
    checks: 0, // 견주어 본 횟수 (좌표계를 새로 잡으면 0으로)
    stepFix: 0, // 걸음 수에 맞춰 단위를 고친 횟수
  };
  return vo;
}

/** 카메라 움직임 추적 엔진을 켠다. 켜지 못하면 false를 돌려주고, 그러면 평소 방식으로 진행한다. */
async function startSlam() {
  const feed = $('xrfeed');
  const vo = newVo();
  vo.status = 'loading';
  vo.log = []; // 엔진이 알려 준 진행 상황 (최근 것만)
  st.vo = vo;
  toast(st.t.slamLoading, 4000);
  report('slam-start', {
    ua: navigator.userAgent,
    screen: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
    sensor: st.orient.hasData,
    engineTag: !!document.querySelector('script[src*="xr8/xr.js"]'),
    engineReady: !!window.XR8,
  });
  try {
    const { startXr8 } = await import('./slam-xr8.js');
    const r = $('stage').getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    feed.width = Math.max(2, Math.round(r.width * dpr));
    feed.height = Math.max(2, Math.round(r.height * dpr));
    feed.classList.remove('hidden');
    $('cam').classList.add('hidden');
    st.xr = await startXr8({
      canvas: feed,
      onFrame: onXrFrame,
      onInfo: (text) => {
        vo.detail = text;
        vo.log.push(text);
        if (vo.log.length > 12) vo.log.shift();
        report('slam-info', { text });
      },
      onError: (e) => leaveSlam(String((e && e.message) || e), false),
    });
    report('slam-ok', { log: vo.log });
    return true;
  } catch (e) {
    console.warn('slam unavailable', e);
    leaveSlam(String((e && e.message) || e), true);
    return false;
  }
}

/** 추적을 끄고 평소 방식(카메라 영상 + 걸음 수)으로 돌아간다. starting: 켜는 도중에 실패한 경우 */
function leaveSlam(why, starting) {
  if (st.xr) st.xr.stop();
  st.xr = null;
  st.xrProj = null;
  $('xrfeed').classList.add('hidden');
  $('cam').classList.remove('hidden');
  if (st.vo) {
    st.vo.status = 'error';
    st.vo.detail = why;
  }
  if (st.loc) st.loc.odo = 'steps';
  report('slam-fail', { why, starting, log: st.vo ? st.vo.log : null });
  // 디버그 중에는 이유를 화면에 오래 보여 준다 (무엇이 안 됐는지 바로 알 수 있게)
  toast(cfg.debug ? `${st.t.slamFail}\n(${why})` : st.t.slamFail, cfg.debug ? 15000 : 5000);
  if (!starting && st.running) {
    startCamera($('cam')).then((ok) => {
      if (!ok) toast(st.t.noCamera, 6000);
    });
  }
}

/** 추적 엔진의 한 프레임 */
function onXrFrame({ q, p, proj, normal, reason }) {
  st.xrProj = proj;
  const vo = st.vo;
  if (!vo || !st.orient.hasData) return; // 기울기 센서 값이 있어야 추적기의 방향을 맞출 수 있다
  const t = performance.now();
  vo.reason = reason;
  vo.feed({
    q,
    p,
    normal,
    qImu: st.orient.at(t - SLAM_LATENCY_MS),
    turnRate: st.orient.turnRate(t - SLAM_LATENCY_MS),
    t,
  });
}

/**
 * 추적기가 알려 준 이동을 지도 위의 이동으로 바꿔 반영한다.
 * vx, vz: 센서 좌표계 기준 수평 이동 (추적기 단위). 지도 방향으로 돌리고 미터로 바꾼다.
 * 높이 변화는 쓰지 않는다 (카메라 높이는 QR로 잰 값을 그대로 둔다).
 */
function onVoMove(vx, vz, _vy, t) {
  const loc = st.loc;
  const k = st.voK;
  if (!loc || !loc.hasFix || !k || loc.odo !== 'visual') return;
  const v = qRotate(yawQuat(loc.delta), [vx, 0, vz]);
  const ux = v[0];
  const uy = -v[2];
  k.leg.ux += ux;
  k.leg.uy += uy;
  if (k.sight) {
    k.sight.ux += ux;
    k.sight.uy += uy;
  }
  const dx = ux * k.s;
  const dy = uy * k.s;
  if (!loc.advance(dx, dy)) return;
  // 이동한 거리는 프레임마다 더하지 않고(잔떨림까지 더해져 부푼다) 실제로 VO_TICK만큼 나아갔을 때 더한다
  k.pend.x += dx;
  k.pend.y += dy;
  const dist = Math.hypot(k.pend.x, k.pend.y);
  if (dist >= VO_TICK) {
    const brg = bearingXY({ x: 0, y: 0 }, k.pend);
    k.pend = { x: 0, y: 0 };
    k.units += dist / k.s;
    loc.addWalked(dist);
    onTravel(dist, brg, t);
  }
}

/**
 * 카메라 추적으로 VO_TICK만큼 이동할 때마다 부른다. 걸음마다 하던 일(모퉁이 맞추기, 안내 갱신)을 여기서 한다.
 *  dist: 이동한 거리(m), travelBearing: 실제로 이동한 방향(지도 기준)
 */
function onTravel(dist, travelBearing, t) {
  if (!st.guide || st.arrivedShown) return;
  const turning = cfg.turnSnap ? snapToTurn(travelBearing, 0.4) : false;
  walkHeading(travelBearing, t, true);
  const g = st.guide.update(st.loc.pos);
  if (g.lateral < SNAP_RANGE && !turning) {
    // 추적기가 잰 옆 방향 위치는 실제 값이므로, 걸음 추정 때보다 훨씬 약하게만 경로 쪽으로 당긴다
    const pull = 1 - Math.pow(0.9, dist / 0.7);
    st.loc.pos = {
      x: st.loc.pos.x + (g.snapped.x - st.loc.pos.x) * pull,
      y: st.loc.pos.y + (g.snapped.y - st.loc.pos.y) * pull,
    };
  }
  if ((g.lateral >= SNAP_RANGE || st.loc.walked > VO_RESCAN_AFTER) && t - st.lastRescanHint > 12000) {
    st.lastRescanHint = t;
    toast(st.t.rescanHint, 4000);
    say(st.t.speechScan);
  }
  applyGuide(g);
}

/**
 * QR로 위치를 잡을 때마다: 추적기의 길이 단위를 미터로 맞춘다.
 *  - 카메라 높이: QR로 잰 높이(m)와 추적기가 말하는 높이(추적기 단위)의 비. 첫 어림값으로만 쓴다.
 *    추적기의 높이 값은 걷는 동안 흘러가고 QR을 붙인 높이가 지도와 다르면 그만큼 틀리기 때문이다.
 *    크게 틀린 경우는 걸음 수로 잰 거리와 견주어 바로잡는다 (compareWithSteps).
 *  - 이동 거리: 두 번 잡은 위치 사이의 거리(m)와 그 사이 추적기가 잰 이동(추적기 단위)의 비.
 *    같은 QR을 보면서 0.8m 넘게 움직였을 때와, QR과 QR 사이를 4m 넘게 이동했을 때 쓴다.
 */
function voOnFix(fix, t) {
  const vo = st.vo;
  const k = st.voK;
  if (!k) return;
  if (!voActive() || !vo.usable || t - vo.lastT > 600) {
    k.leg = { from: { ...fix.pos }, ux: 0, uy: 0, ok: false };
    k.sight = null;
    return;
  }
  const take = (sd, gain) => {
    if (!(sd > 0.6 && sd < 1.6)) return;
    k.s += (sd - k.s) * gain;
    k.dN++;
    k.n++;
  };
  // 추적기가 좌표계를 잡은 뒤 얼마 걷지 않았을 때만 (걸을수록 추적기의 높이 값이 흘러가므로)
  if (vo.y > 0.3 && k.n === 0 && vo.traveled < 6) {
    const sh = fix.height / vo.y;
    if (sh > 0.4 && sh < 2.5) {
      k.s = sh;
      k.n++;
    }
  }
  const sg = k.sight;
  if (!sg || t - sg.t > SIGHTING_GAP_MS) {
    k.sight = { t, from: { ...fix.pos }, ux: 0, uy: 0 };
  } else {
    sg.t = t;
    const u = Math.hypot(sg.ux, sg.uy);
    const d = distXY(fix.pos, sg.from);
    if (u * k.s >= 0.8 && d >= 0.8) take(d / u, 0.1);
  }
  const leg = k.leg;
  if (leg.from && leg.ok) {
    const u = Math.hypot(leg.ux, leg.uy);
    const d = distXY(fix.pos, leg.from);
    if (u * k.s >= 4 && d >= 4) take(d / u, Math.max(0.3, Math.min(1, d / 15)));
  }
  k.leg = { from: { ...fix.pos }, ux: 0, uy: 0, ok: true };
}

/** 매 프레임: 추적 상태에 따라 "카메라 추적으로 이어 갈지, 걸음 수로 이어 갈지"를 정한다 */
function voHousekeeping(t) {
  const vo = st.vo;
  const k = st.voK;
  const loc = st.loc;
  if (!vo || !k || !loc) return;
  if (vo.resets !== k.resets) {
    // 추적기가 좌표계를 새로 잡았다. 길이 단위도 달라졌을 수 있으므로, QR 사이 거리로 맞춰 둔 값을 더는 믿지 않고
    // 걸음 수로 잰 거리와 다시 견주어 본다.
    k.resets = vo.resets;
    k.leg.ok = false;
    k.sight = null;
    k.dN = 0;
    k.n = 0;
    k.checks = 0;
    k.steps = 0;
    k.units = 0;
    k.winPos = null;
  }
  const usable = voActive() && vo.usable && t - vo.lastT < 600;
  if (st.xr && t - (k.reportT || 0) > 5000) {
    k.reportT = t;
    report('slam-status', {
      status: vo.status,
      reason: vo.reason,
      usable,
      using: loc.odo,
      frames: vo.frames,
      yaw: vo.yaw == null ? null : Math.round(vo.yaw),
      tilt: vo.tilt == null ? null : Math.round(vo.tilt),
      y: vo.y == null ? null : Math.round(vo.y * 100) / 100,
      scale: Math.round(k.s * 1000) / 1000,
      scaleN: [k.n, k.dN],
      resets: [vo.resets, vo.glitches],
      fix: loc.hasFix,
      pos: loc.pos ? [Math.round(loc.pos.x * 100) / 100, Math.round(loc.pos.y * 100) / 100] : null,
      seen: loc.seenIds,
      walked: Math.round(loc.walked * 10) / 10,
      snap: st.snap ? [st.snap.width, st.snap.height] : null,
      proj5: st.xrProj ? Math.round(st.xrProj[5] * 1000) / 1000 : null,
      h: Math.round(loc.height * 100) / 100,
      heading: Math.round(st.heading),
      stride: Math.round(loc.stride * 1000) / 1000,
      steps: loc.steps,
      stepFix: k.stepFix,
      rejects: loc.rejects,
      lastReject: loc.lastReject,
      synced: !!st.syncedPose,
      vp: [st.vpFixes, Math.round(st.vpTotal * 10) / 10, st.walkYawFixes],
      turnSnaps: st.turnSnaps,
      dest: st.poi ? st.poi.id : null,
      left: st.g ? Math.round(st.g.remaining * 10) / 10 : null,
    });
  }
  const mode = usable ? 'visual' : 'steps';
  if (mode !== loc.odo) {
    loc.odo = mode;
    st.walkDev.length = 0;
    k.steps = 0;
    k.units = 0;
    k.winPos = null;
    k.pend = { x: 0, y: 0 };
    if (!usable) {
      k.leg.ok = false;
      k.sight = null;
    }
  }
}

/**
 * 카메라 추적 중의 걸음: 추적기가 잰 거리와 걸음 수로 잰 거리를 견주어 본다.
 *  - QR 사이의 이동 거리로 추적기의 길이 단위를 맞춘 뒤라면 추적기 쪽이 정확하다. 보폭을 거기에 맞춰 배워 두고,
 *    추적을 놓쳐 걸음 수로 이어 가야 할 때 그 보폭을 쓴다.
 *  - 아직 그렇게 맞춘 적이 없으면 추적기의 단위가 크게 틀렸을 수 있다 (추적기가 말하는 높이로 어림한 값이라서).
 *    걸음 수는 정밀하지는 않아도 크게 틀리지는 않으므로, 차이가 크면 걸음 쪽에 맞춘다.
 *    처음에는 네 걸음 만에 큰 차이(1.6배 이상)부터 잡고, 그 뒤로는 여덟 걸음마다 25% 넘는 차이를 잡는다.
 *    단위를 고치면 그동안 잘못된 단위로 이동한 만큼도 다시 계산해 위치를 바로잡는다.
 */
function compareWithSteps(n) {
  const k = st.voK;
  const loc = st.loc;
  if (!k.winPos && loc.pos) k.winPos = { ...loc.pos };
  k.steps += n;
  const first = k.checks === 0 && k.dN === 0;
  if (k.steps < (first ? 4 : 8)) return;
  const steps = k.steps;
  const units = k.units;
  const from = k.winPos;
  k.steps = 0;
  k.units = 0;
  k.winPos = loc.pos ? { ...loc.pos } : null;
  if (!(units > 0.5)) return; // 제자리에서 흔들린 것이거나 추적기가 움직임을 못 쟀다
  k.checks++;
  const byTracker = units * k.s;
  const r = (steps * loc.stride) / byTracker;
  if (k.dN > 0 && r > 0.6 && r < 1.6) {
    const obs = byTracker / steps;
    if (cfg.strideFixed || !(obs > 0.4 && obs < 1)) return;
    loc.stride += (obs - loc.stride) * 0.3;
    try {
      localStorage.setItem(STRIDE_KEY, loc.stride.toFixed(3));
    } catch (e) {
      /* 저장하지 못해도 이번 안내에는 반영된다 */
    }
    return;
  }
  const [lo, hi] = first ? [0.6, 1.6] : [0.8, 1.25];
  if (r > lo && r < hi) return;
  k.s = Math.max(0.2, Math.min(5, k.s * r));
  k.dN = 0;
  k.stepFix++;
  if (from && loc.pos) {
    loc.pos = { x: from.x + (loc.pos.x - from.x) * r, y: from.y + (loc.pos.y - from.y) * r };
    loc.addWalked((r - 1) * byTracker);
    k.winPos = { ...loc.pos };
  }
}

function stopNav() {
  st.running = false;
  st.detectRun++;
  stopSpeaking();
  if (st.xr) {
    st.xr.stop();
    st.xr = null;
    st.xrProj = null;
    $('xrfeed').classList.add('hidden');
    $('cam').classList.remove('hidden');
  } else if (!cfg.sim) stopCamera($('cam'));
  st.route = null;
  st.guide = null;
  st.g = null;
  if (st.ar) st.ar.clearRoute();
  $('detfx').innerHTML = '';
  show('dest');
}

// ---------------------------------------------------------------- QR 인식 → 위치

/** 지금 쓰는 영상의 카메라 파라미터. 영상이 아직 준비되지 않았으면 null */
function currentIntrinsics() {
  if (cfg.sim) return st.sim ? st.sim.intrinsics() : null;
  if (st.xr) {
    // 추적 엔진이 그린 화면을 복사한 그림(st.snap) 기준. 엔진이 알려 준 투영 행렬에서 초점 거리를 얻는다.
    const m = st.xrProj;
    const c = st.snap;
    if (!m || !c || c.width < 4) return null;
    const f = (m[5] * c.height) / 2;
    if (!(f > c.height * 0.4 && f < c.height * 2.5)) return intrinsicsFor(c.width, c.height, cfg.fovLong);
    return { f, cx: (c.width / 2) * (1 - m[8]), cy: (c.height / 2) * (1 + m[9]), w: c.width, h: c.height };
  }
  const v = $('cam');
  if (v.readyState < 2 || !v.videoWidth) return null;
  return intrinsicsFor(v.videoWidth, v.videoHeight, cfg.fovLong);
}

function currentImu() {
  return cfg.sim ? st.sim.qImu() : st.orient.q;
}

async function detectLoop() {
  const run = ++st.detectRun;
  while (st.running && run === st.detectRun) {
    if (st.xr) sizeSnapToFeed();
    const intr = currentIntrinsics();
    if (intr) {
      let t0 = performance.now();
      let source;
      let qImu;
      let steady;
      if (st.xr) {
        // 추적 엔진이 그린 카메라 화면을 복사해서 쓴다
        const shot = await st.xr.snapshot(st.snap);
        if (!st.running || run !== st.detectRun) break;
        t0 = performance.now();
        source = st.snap;
        // 이 화면을 찍은 순간의 자세: 엔진이 영상과 짝지어 준 값을 센서 좌표계로 옮겨 쓴다.
        // (지금의 센서 값은 화면보다 앞서 있어서, 손이 조금만 움직여도 QR 위치 계산이 어긋난다)
        const synced = st.vo && shot && shot.q ? st.vo.syncedImu(shot.q) : null;
        qImu = synced || st.orient.at(t0 - SLAM_LATENCY_MS);
        st.syncedPose = !!synced;
        steady = st.orient.turnRate(t0 - SLAM_LATENCY_MS) < MAX_TURN_RATE;
      } else if (cfg.sim) {
        // 그 순간의 화면과 센서 값을 한 쌍으로 붙잡아 둔다
        if (st.snap.width !== intr.w || st.snap.height !== intr.h) {
          st.snap.width = intr.w;
          st.snap.height = intr.h;
        }
        st.snap.getContext('2d', { willReadFrequently: true }).drawImage($('simcam'), 0, 0);
        source = st.snap;
        qImu = st.sim.renderedImu;
        steady = st.sim.turnRate < MAX_TURN_RATE;
      } else {
        source = $('cam');
        qImu = st.orient.at(t0 - CAMERA_LATENCY_MS);
        steady = st.orient.turnRate(t0 - CAMERA_LATENCY_MS) < MAX_TURN_RATE;
      }
      const dets = await detectMarkers(st.detector, source);
      st.detectorReady = true;
      st.detMs = performance.now() - t0;
      if (!st.running || run !== st.detectRun) break;
      onDetections(dets, qImu, intr, t0, steady);
      if (steady) visualHeading(source, intr, qImu, t0);
      else st.vpInfo = null;
      if (cfg.debug) drawVpFx(intr);
    }
    await sleep(cfg.sim ? 50 : 30);
  }
}

/** 추적 엔진의 화면을 복사해 둘 그림의 크기를 정한다 (QR 인식에는 폭 720픽셀이면 충분하다) */
function sizeSnapToFeed() {
  const feed = $('xrfeed');
  const k = Math.min(1, 720 / Math.max(1, feed.width));
  const w = Math.max(2, Math.round(feed.width * k));
  const h = Math.max(2, Math.round(feed.height * k));
  if (!st.snap) st.snap = document.createElement('canvas');
  if (st.snap.width !== w || st.snap.height !== h) {
    st.snap.width = w;
    st.snap.height = h;
  }
}

/** QR에 높이·크기가 적혀 있으면 지도의 값을 그것으로 바꾼다 (화면에 띄운 QR로 시험할 때) */
function applyMarkerOverrides(dets) {
  let changed = false;
  for (const d of dets) {
    const m = d.id && st.map.markerById.get(d.id);
    if (!m) continue;
    if (d.size != null && Math.abs(m.size - d.size) > 1e-6) {
      m.size = d.size;
      changed = true;
    }
    if (d.h != null && m.mount !== 'floor' && Math.abs(m.h - d.h) > 1e-6) {
      m.h = d.h;
      changed = true;
    }
  }
  if (changed && st.ar) st.ar.setMap(st.map); // QR 위치 표시도 새 값으로 다시 만든다
}

function onDetections(dets, qImu, intr, t, steady) {
  drawDetFx(dets, intr);
  applyMarkerOverrides(dets);
  const hadFix = st.loc.hasFix;
  // 직전 QR 이후 걸음으로 잰 거리 (위치를 잡으면 0으로 돌아간다). 아직 다 딛지 않은 걸음도 더한다.
  const walkedBefore = st.loc.walked + st.loc.partialStep(t);
  const fix = st.loc.onFrame(dets.filter((d) => d.id), qImu, intr, t, steady);
  if (!fix) return;
  if (st.vo) voOnFix(fix, t);
  if (!hadFix) toast(st.t.located, 2200);
  if (!st.poi || st.arrivedShown) return;
  if (!st.route) {
    planRoute(false);
    return;
  }
  const g = st.guide.update(st.loc.pos);
  if (g.lateral > OFF_ROUTE_ON_FIX) {
    planRoute(true);
    return;
  }
  if (!voActive()) calibrateStride(g, walkedBefore); // 카메라 추적 중에는 보폭을 다른 방법으로 배운다 (onSteps)
  applyGuide(g);
}

/**
 * 보폭 자동 보정. QR 두 개 사이를 경로를 따라 걸었다면, 실제로 이동한 거리(두 QR에서 잡은 위치의 차이)와
 * 걸음 수로 잰 거리를 비교해 보폭을 맞춘다. 사람마다 보폭이 달라도 QR을 두어 번 지나면 맞춰진다.
 */
function calibrateStride(g, walkedBefore) {
  const from = st.lastFixS;
  st.lastFixS = g.s;
  if (cfg.strideFixed || from == null || walkedBefore < 3.5 || g.lateral > 1.5) return;
  // 모퉁이를 낀 구간은 쓰지 않는다: 사람은 모퉁이를 안쪽으로 질러 걷기 때문에 경로상 거리보다 덜 걷는다
  if (st.route.maneuvers.some((m) => Math.abs(m.angle) >= 30 && m.s > from - 1 && m.s < g.s + 1)) return;
  const real = g.s - from;
  const ratio = real / walkedBefore;
  // 경로를 벗어나 돌아다녔거나 걸음을 많이 놓친 경우는 믿지 않는다
  if (real < 3 || ratio < 0.7 || ratio > 1.4) return;
  // 짧은 구간은 한 걸음의 오차가 크게 보이므로 조금만, 긴 구간(20m 이상)은 그대로 반영한다
  const gain = Math.max(0.25, Math.min(1, walkedBefore / 20));
  const stride = Math.max(0.45, Math.min(0.95, st.loc.stride * (1 + gain * (ratio - 1))));
  st.loc.stride = stride;
  try {
    localStorage.setItem(STRIDE_KEY, stride.toFixed(3));
  } catch (e) {
    /* 저장하지 못해도 이번 안내에는 반영된다 */
  }
}

/**
 * 영상에 보이는 복도 선으로 방향을 맞춘다.
 *
 * QR 한 장(특히 벽에 붙은 것을 정면에서 볼 때)으로는 좌우 방향이 몇 도쯤 틀릴 수 있고, 그만큼 화살표가
 * 실제 복도와 어긋나 보인다. 그런데 복도를 비추면 바닥·천장 경계선이 한 점으로 모이므로
 * "카메라가 복도 방향에서 몇 도 틀어져 있는지"를 영상만으로 알 수 있다 (vanish.js).
 * 지도에서 지금 서 있는 통로의 방향과 비교해, 추정 방향이 틀어진 만큼 계속 조금씩 바로잡는다.
 *
 * 한 장면만 보고 고치지 않는다. 걸을 때는 폰이 좌우로 흔들리고 영상과 센서의 시각도 조금 어긋나므로,
 * 최근 2초 동안 잰 값들의 가운데 값을 쓰고, 값들이 서로 맞지 않으면(사람이 지나가는 등) 고치지 않는다.
 */
function visualHeading(source, intr, qImu, t) {
  const loc = st.loc;
  st.vpInfo = null;
  if (!cfg.vp || !loc.hasFix || !loc.pos) return;
  const up = qRotate(qConj(qImu), [0, 1, 0]);
  const pitch = deg(Math.asin(Math.max(-1, Math.min(1, -up[2]))));
  // 폰을 많이 숙여도 바닥과 벽의 경계선만 보이면 된다. 거의 바닥만 보거나 옆으로 눕힌 자세는 뺀다.
  if (pitch < -58 || pitch > 25 || Math.abs(up[0]) > 0.35) return;

  const ws = VP_WIDTH;
  const hs = Math.max(8, Math.round((intr.h * ws) / intr.w));
  const c = st.vpCanvas || (st.vpCanvas = document.createElement('canvas'));
  if (c.width !== ws || c.height !== hs) {
    c.width = ws;
    c.height = hs;
  }
  const g = c.getContext('2d', { willReadFrequently: true });
  let image;
  try {
    g.drawImage(source, 0, 0, ws, hs);
    image = g.getImageData(0, 0, ws, hs);
  } catch (e) {
    return;
  }
  const k = ws / intr.w;
  const votes = corridorHistogram(image, { f: intr.f * k, cx: ws / 2, cy: hs / 2 }, up);

  // 모아 둔 값들은 "그때의 방향 보정값" 기준이므로, 그 사이 보정값이 바뀌었으면(QR을 봤을 때 등) 그만큼 옮긴다
  const errs = st.vpErrs;
  const moved = angDiff(loc.delta, st.vpDeltaRef);
  if (moved !== 0) {
    for (const x of errs) x.e -= moved;
    st.vpDeltaRef = loc.delta;
  }
  while (errs.length && t - errs[0].t > VP_MEMORY_MS) errs.shift();

  // 지금 서 있는 통로들의 방향 가운데, 영상의 복도 선과 가장 잘 맞는 것
  const heading = headingOf(qMul(yawQuat(loc.delta), qImu));
  let best = null;
  for (const brg of st.map.corridorBearingsNear(loc.pos, 3.5)) {
    const expected = angDiff(brg, heading);
    if (Math.abs(expected) > 50) continue;
    const peak = findPeak(votes, expected, VP_WINDOW);
    if (peak && (!best || peak.quality > best.quality)) {
      best = { err: peak.rel - expected, rel: peak.rel, quality: peak.quality };
    }
  }
  if (!best) return;
  st.vpInfo = { ...best, up };
  st.vpSeenT = t;
  errs.push({ e: best.err, t });
  if (errs.length < VP_MIN_COUNT || t - errs[0].t < VP_MIN_SPAN_MS) return;

  const vals = errs.map((x) => x.e).sort((a, b) => a - b);
  const mid = vals[vals.length >> 1];
  const devs = vals.map((v) => Math.abs(v - mid)).sort((a, b) => a - b);
  if (devs[devs.length >> 1] > 2) return; // 값들이 서로 맞지 않는다
  st.vpMid = mid;
  st.vpMidT = t;
  if (Math.abs(mid) < 0.4) return; // 이미 맞아 있다
  // 한 번에 다 고치지 않고 절반씩, 최대 1.5도씩 (화살표가 갑자기 튀지 않게)
  const fix = Math.max(-1.5, Math.min(1.5, mid * 0.5));
  loc.adjustYaw(fix, t);
  for (const x of errs) x.e -= fix;
  st.vpDeltaRef = loc.delta;
  st.vpFixes++;
  st.vpTotal += fix;
  st.walkDev.length = 0;
}

/**
 * 영상으로 방향을 맞출 수 없을 때(폰을 깊이 숙였거나 복도 선이 안 보일 때)의 대비책.
 *
 * 통로의 곧은 구간을 걷는 동안에는 사람이 통로 방향으로 걷고 폰도 대체로 앞을 향한다. 그래서 여러 걸음의
 * "걸은 방향 - 통로 방향"이 한쪽으로 치우쳐 있으면 추정 방향이 틀어진 것으로 보고 조금 바로잡는다.
 * 다만 사람마다 폰을 살짝 틀어 드는 버릇이 있다. 영상으로 방향이 맞아 있는 동안 그 버릇(평균 치우침)을
 * 배워 두고, 배운 뒤에는 그 값을 기준으로 삼는다. 아직 못 배웠으면 3도 안쪽의 치우침은 건드리지 않는다.
 *  heading: 방금 걸은 방향(지도 기준), t: 시각
 *  travel: 카메라 추적으로 잰 실제 이동 방향이면 true (폰이 향한 쪽이 아니므로 드는 버릇과 무관하다)
 */
function walkHeading(heading, t, travel = false) {
  const dev = st.walkDev;
  const route = st.route;
  if (!cfg.walkYaw || !route || !st.guide || !st.loc.pos) return;
  const path = route.path;
  const pr = path.project(st.loc.pos, st.guide.s - 4, st.guide.s + 8);
  // 모퉁이 근처이거나 경로에서 벗어나 있으면 통로 방향으로 걷는다고 볼 수 없다
  const nearTurn = route.maneuvers.some((m) => Math.abs(m.angle) >= 20 && Math.abs(m.s - pr.s) < 3.5);
  const d = angDiff(heading, path.pointAt(pr.s).bearing);
  if (nearTurn || pr.dist > 1.5 || Math.abs(d) > 25 || path.length - pr.s < 2) {
    dev.length = 0;
    return;
  }
  // 영상으로 방향이 맞아 있는 동안: 고치지 않고, 폰 드는 버릇만 배운다
  if (t - st.vpSeenT < 3000) {
    if (!travel && t - st.vpMidT < 1500 && Math.abs(st.vpMid) < 1) {
      st.holdBiasN++;
      st.holdBias += (d - st.holdBias) / Math.min(st.holdBiasN, 12);
    }
    dev.length = 0;
    return;
  }
  dev.push({ d, t });
  while (dev.length > WALK_YAW_STEPS + 2 || (dev.length && t - dev[0].t > 9000)) dev.shift();
  if (dev.length < WALK_YAW_STEPS) return;
  const learned = travel || st.holdBiasN >= 6;
  const raw = dev.reduce((a, x) => a + x.d, 0) / dev.length;
  const spread = Math.sqrt(dev.reduce((a, x) => a + (x.d - raw) ** 2, 0) / dev.length);
  const mean = raw - (learned && !travel ? st.holdBias : 0);
  const dead = learned ? 1.5 : 3; // 이 안쪽은 건드리지 않는다
  if (spread > 6 || Math.abs(mean) < dead) return;
  const fix = Math.sign(mean) * Math.min(4, (Math.abs(mean) - (dead - 1)) * 0.6);
  st.loc.adjustYaw(fix, t);
  for (const x of dev) x.d -= fix;
  st.walkYawFixes++;
}

/**
 * (디버그) 영상에서 찾은 복도 방향을 화면에 그린다: 발밑을 지나 그 방향으로 뻗는 바닥 위의 선을 노란 점선으로.
 * 이 선이 실제 복도와 나란하면 방향 찾기는 맞게 되고 있는 것이고, 화살표가 이 선을 따라가면 방향도 맞춰진 것이다.
 */
function drawVpFx(intr) {
  const info = st.vpInfo;
  if (!info) return;
  const [ux, uy, uz] = info.up;
  // 수평면 위에서 카메라 정면과 오른쪽 (vanish.js와 같은 식)
  let fx = uz * ux;
  let fy = uz * uy;
  let fz = -1 + uz * uz;
  const fn = Math.hypot(fx, fy, fz);
  if (fn < 0.2) return;
  fx /= fn;
  fy /= fn;
  fz /= fn;
  const rx = fy * uz - fz * uy;
  const ry = fz * ux - fx * uz;
  const rz = fx * uy - fy * ux;
  const a = rad(info.rel);
  const dir = [
    Math.cos(a) * fx + Math.sin(a) * rx,
    Math.cos(a) * fy + Math.sin(a) * ry,
    Math.cos(a) * fz + Math.sin(a) * rz,
  ];
  const scale = Math.max(st.stageW / intr.w, st.stageH / intr.h);
  const ox = (st.stageW - intr.w * scale) / 2;
  const oy = (st.stageH - intr.h * scale) / 2;
  const h = st.loc.height;
  // 발밑에서 앞으로 dist(m) 떨어진 바닥 위의 점을 화면 좌표로
  const at = (dist) => {
    const x = dir[0] * dist - ux * h;
    const y = dir[1] * dist - uy * h;
    const z = dir[2] * dist - uz * h;
    if (-z < 0.05) return null;
    return [(intr.cx + (intr.f * x) / -z) * scale + ox, (intr.cy - (intr.f * y) / -z) * scale + oy];
  };
  let near = null;
  for (const dist of [0.8, 1.2, 1.8, 2.6, 4]) {
    near = at(dist);
    if (near) break;
  }
  const far = at(60);
  if (!near || !far) return;
  $('detfx').insertAdjacentHTML(
    'beforeend',
    `<line class="vp" x1="${near[0].toFixed(1)}" y1="${near[1].toFixed(1)}" x2="${far[0].toFixed(1)}" y2="${far[1].toFixed(1)}"/>`
  );
}

/** 인식한 QR 위에 테두리를 그린다 (영상 픽셀 → 화면 좌표) */
function drawDetFx(dets, intr) {
  const scale = Math.max(st.stageW / intr.w, st.stageH / intr.h);
  const ox = (st.stageW - intr.w * scale) / 2;
  const oy = (st.stageH - intr.h * scale) / 2;
  let html = '';
  for (const d of dets) {
    const pts = d.corners.map((p) => `${(p.x * scale + ox).toFixed(1)},${(p.y * scale + oy).toFixed(1)}`);
    const known = d.id && st.map.markerById.has(d.id);
    html += `<polygon points="${pts.join(' ')}" class="${known ? 'known' : 'other'}"/>`;
  }
  $('detfx').innerHTML = html;
}

// ---------------------------------------------------------------- 경로와 안내

function planRoute(reroute) {
  const r = st.map.routeTo(st.loc.pos, st.poi);
  if (!r) {
    // 직접 만든 지도에서 통로가 끊어져 있을 때. 프레임마다 반복해 띄우지 않는다.
    const now = performance.now();
    if (now - st.lastNoRoute > 6000) {
      st.lastNoRoute = now;
      toast(st.t.noRoute, 5000);
    }
    return;
  }
  st.route = buildRoute(r.points);
  st.guide = new Guide(st.route);
  st.ar.setRoute(st.route, { x: st.poi.x, y: st.poi.y }, poiIcon(st.poi));
  const g = st.guide.update(st.loc.pos);
  if (st.disp) st.disp.s = g.s;
  st.lastFixS = g.s;
  st.turn = { idx: -1, steps: 0, done: new Set() };
  if (reroute) {
    toast(st.t.rerouting, 3000);
    say(st.t.speechReroute, true);
  } else {
    say(st.t.speechStart(poiName(st.poi, st.lang)), true);
  }
  applyGuide(g);
}

/** 걸음이 감지될 때마다 호출된다 */
function onSteps(n) {
  if (!st.running || !st.loc) return;
  if (st.loc.odo === 'visual' && st.voK) compareWithSteps(n);
  const t = performance.now();
  const qImu = currentImu();
  let moved = false;
  let turning = false;
  for (let i = 0; i < n; i++) {
    if (!st.loc.onStep(qImu, t)) continue;
    moved = true;
    const walked = headingOf(qMul(yawQuat(st.loc.delta), qImu));
    if (cfg.turnSnap) turning = snapToTurn(walked);
    walkHeading(walked, t);
  }
  if (!moved || !st.guide || st.arrivedShown) return;
  const g = st.guide.update(st.loc.pos);
  if (g.lateral < SNAP_RANGE && !turning) {
    // 통로를 따라 걷고 있다고 보고 경로 쪽으로 조금씩 당긴다 (걸음 추정의 옆 방향 오차를 줄인다)
    st.loc.pos = {
      x: st.loc.pos.x + (g.snapped.x - st.loc.pos.x) * 0.25,
      y: st.loc.pos.y + (g.snapped.y - st.loc.pos.y) * 0.25,
    };
  }
  if ((g.lateral >= SNAP_RANGE || st.loc.walked > RESCAN_AFTER) && t - st.lastRescanHint > 12000) {
    st.lastRescanHint = t;
    toast(st.t.rescanHint, 4000);
    say(st.t.speechScan);
  }
  applyGuide(g);
}

/**
 * 모퉁이 맞추기.
 *
 * 걸음 수로 잰 거리는 조금씩 틀려서, 추정 위치는 아직 모퉁이에 못 미쳤는데(또는 이미 지났는데)
 * 사람은 눈에 보이는 실제 모퉁이에서 꺾는다. 꺾은 뒤에는 실제로 "다음 통로 위"를 걷고 있으므로,
 * 추정 위치가 모퉁이 근처일 때 다음 통로 방향으로 두 걸음을 걸으면 추정 위치를 다음 통로의 선 위로 옮긴다.
 * 옮기는 방향은 들어오던 방향뿐이라(= 걸음 수 오차가 쌓인 방향) 새 통로를 따라 걸은 거리는 그대로 남는다.
 * 이렇게 하면 걸음 수 오차가 모퉁이마다 지워져서 다음 구간의 화살표가 다시 실제 복도와 맞는다.
 *
 *  heading: 방금 걸은 방향(지도 기준), keep: 다음 통로의 선에서 이만큼 떨어진 것은 그대로 둔다 (m)
 * 반환: 모퉁이를 도는 중이면 true (이때는 경로 쪽으로 당기는 보정을 하지 않는다)
 */
function snapToTurn(heading, keep = 0) {
  const route = st.route;
  const loc = st.loc;
  const turn = st.turn;
  if (!route || !st.guide || !loc.pos) return false;
  const path = route.path;
  const s = path.project(loc.pos, st.guide.s - 4, st.guide.s + 8).s;
  const idx = route.maneuvers.findIndex(
    (k, i) =>
      !turn.done.has(i) && Math.abs(k.angle) >= SHARP_TURN && s > k.s - TURN_SNAP_BEFORE && s < k.s + TURN_SNAP_AFTER
  );
  if (idx !== turn.idx) {
    turn.idx = idx;
    turn.steps = 0;
  }
  if (idx < 0) return false;
  const m = route.maneuvers[idx];
  const out = path.pointAt(Math.min(path.length, m.s + 2)); // 꺾은 뒤 통로 위의 한 점과 그 방향
  const bIn = path.pointAt(Math.max(0, m.s - 1)).bearing;
  // 꺾은 뒤의 방향으로 걷고 있는가 (들어오던 방향과는 분명히 달라야 한다)
  if (Math.abs(angDiff(heading, out.bearing)) > 30 || Math.abs(angDiff(heading, bIn)) < 40) {
    turn.steps = 0;
    return false;
  }
  turn.steps++;
  if (turn.steps < 2) return true;
  turn.done.add(idx);
  // 다음 통로의 선 위로 수직으로 옮긴다. keep이 있으면 선에서 그만큼 떨어진 곳까지만 옮긴다
  // (카메라 추적으로 잰 옆 방향 위치는 실제 값이라, 통로 폭 안쪽이면 그대로 둔다).
  const ux = Math.sin(rad(out.bearing));
  const uy = Math.cos(rad(out.bearing));
  const along = (loc.pos.x - out.x) * ux + (loc.pos.y - out.y) * uy;
  const foot = { x: out.x + ux * along, y: out.y + uy * along };
  const off = distXY(loc.pos, foot);
  if (off > keep + 0.3) {
    const k = keep / off;
    loc.pos = { x: foot.x + (loc.pos.x - foot.x) * k, y: foot.y + (loc.pos.y - foot.y) * k };
    st.turnSnaps++;
  }
  return true;
}

function applyGuide(g) {
  st.g = g;
  renderHud(g);
  for (const ev of g.speak) say(st.t.speech(ev), ev.stage === 'now');
  if (g.arrived && !st.arrivedShown) {
    st.arrivedShown = true;
    say(st.t.speechArrived, true);
    $('arrivedName').textContent = `${poiIcon(st.poi)} ${poiName(st.poi, st.lang)}`;
    show('arrived');
  }
}

function renderHud(g) {
  const t = st.t;
  const text = t.instruction(g.ins);
  $('insMain').textContent = text.main;
  $('insSub').textContent = text.sub;
  $('insSub').classList.toggle('hidden', !text.sub);
  const icon = g.ins.stage === 'far' ? 'straight' : g.ins.kind;
  const c = $('turnIcon');
  if (c.dataset.kind !== icon) {
    c.dataset.kind = icon;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drawTurnGlyph(ctx, icon, c.width, '#ffffff', '#1e6bff');
  }
  $('hud').classList.toggle('now', g.ins.stage === 'now');
  $('remain').textContent = t.remaining(g.remaining);
}

// ---------------------------------------------------------------- 매 프레임

function onResize() {
  const r = $('stage').getBoundingClientRect();
  st.stageW = Math.max(1, r.width);
  st.stageH = Math.max(1, r.height);
  if (st.ar) st.ar.resize(st.stageW, st.stageH);
  if (st.sim) st.sim.resize(st.stageW, st.stageH);
  if (st.xr) st.xr.resize(st.stageW, st.stageH);
  $('detfx').setAttribute('viewBox', `0 0 ${st.stageW} ${st.stageH}`);
}

function frame(now) {
  if (!st.running) return;
  // 다음 프레임을 먼저 예약한다: 한 프레임에서 오류가 나도 화면이 멈추지 않게
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - st.lastFrame) / 1000));
  st.lastFrame = now;
  const loc = st.loc;

  if (st.sim) {
    if (st.autoWalk) st.walker.update(dt, walkerInput());
    st.sim.update(dt);
    st.sim.render();
    if (st.simTracker) {
      const r = st.simTracker.read();
      st.vo.feed({ q: r.q, p: r.p, normal: r.normal, qImu: st.sim.qImu(), turnRate: st.sim.turnRate || 0, t: now });
    }
  }
  if (st.vo) voHousekeeping(now);

  loc.tick(dt);
  const qMap = loc.qMap(currentImu());
  st.heading = headingOf(qMap);

  // 화면용 위치는 추정 위치를 부드럽게 따라간다 (걸음마다 뚝뚝 끊기지 않게).
  // 걷는 중에는 걸음 사이에도 나아가고 있으므로 그만큼 앞선 위치를 따라간다.
  if (loc.pos) {
    const at = loc.predicted(currentImu(), now + DISPLAY_LEAD_MS);
    let s = st.g ? st.g.s : 0;
    // 걸음 사이를 채운 위치이거나 카메라 추적으로 계속 움직이는 위치이면, 경로상 거리도 그 위치로 다시 잰다
    if (st.route && st.g && (at !== loc.pos || loc.odo === 'visual')) {
      s = st.route.path.project(at, st.g.s - 1, st.g.s + 2).s;
    }
    if (!st.disp) {
      st.disp = { x: at.x, y: at.y, s };
    } else {
      const k = 1 - Math.exp(-dt / (loc.odo === 'visual' ? 0.06 : 0.15));
      st.disp.x += (at.x - st.disp.x) * k;
      st.disp.y += (at.y - st.disp.y) * k;
      st.disp.s += (s - st.disp.s) * k;
    }
  }

  // 화살표는 항상 발밑에서 시작하게 한다: 추정 위치가 통로 가운데 선에서 옆으로 벗어난 만큼
  // 경로를 옆으로 옮겨 그린다. 통로의 어느 쪽으로 걷든, 위치가 조금 틀리든 화살표가 벽 너머로 가지 않는다.
  let offX = 0;
  let offY = 0;
  if (st.route && st.disp) {
    const p = st.route.path.pointAt(st.disp.s);
    const b = rad(p.bearing);
    const nx = Math.cos(b); // 진행 방향의 오른쪽
    const ny = -Math.sin(b);
    const lateral = (st.disp.x - p.x) * nx + (st.disp.y - p.y) * ny;
    if (Math.abs(lateral) < SNAP_RANGE) {
      offX = nx * lateral;
      offY = ny * lateral;
    }
  }
  const ko = 1 - Math.exp(-dt / 0.3);
  st.routeOff.x += (offX - st.routeOff.x) * ko;
  st.routeOff.y += (offY - st.routeOff.y) * ko;

  const intr = currentIntrinsics();
  if (intr) {
    // 화면에 실제로 보이는 영상 높이로 화각을 맞춘다 (영상은 화면을 꽉 채우도록 잘려서 보인다)
    const scale = Math.max(st.stageW / intr.w, st.stageH / intr.h);
    st.ar.setFov(deg(2 * Math.atan(st.stageH / scale / 2 / intr.f)));
  }
  st.ar.frame({
    pos: st.disp,
    height: loc.height,
    q: qMap,
    s: st.disp ? st.disp.s : 0,
    nextIdx: st.g ? st.g.ins.idx : -1,
    seenIds: loc.seenIds,
    t: now / 1000,
    dt,
    routeOffset: st.routeOff,
    sEnd: routeViewEnd(st.disp ? st.disp.s : 0),
  });

  updateOverlays(now, pitchOf(qMap));
}

/**
 * 화살표를 경로의 어디까지 그릴지: 아직 닿지 않은 다음 모퉁이를 조금 지난 곳까지.
 * 모퉁이에 거의 다 오면(0.8m 이내) 그다음 구간을 보여 준다.
 */
function routeViewEnd(s) {
  if (!st.route) return Infinity;
  for (const m of st.route.maneuvers) {
    if (Math.abs(m.angle) >= SHARP_TURN && m.s > s + 0.8) return m.s + TURN_LEAD;
  }
  return Infinity;
}

/**
 * 앱이 가리키는 방향: 경로가 지금 위치에서 조금 앞까지 뻗은 방향이 정면에서 몇 도 옆인지 (오른쪽 +).
 * 통로의 한쪽으로 치우쳐 걸어도 "가운데로 돌아오라"고 하지 않도록, 내 위치가 아니라 경로 위의 점에서 잰다.
 */
function guidedDirection() {
  if (!st.route || !st.g || !st.loc.pos) return null;
  const path = st.route.path;
  const from = path.pointAt(st.g.s);
  const to = path.pointAt(Math.min(path.length, st.g.s + 2.5));
  const brg = distXY(from, to) < 0.3 ? from.bearing : bearingXY(from, to);
  return angDiff(brg, st.heading);
}

function walkerInput() {
  const nav = {
    hasFix: st.loc.hasFix,
    rel: guidedDirection(),
    arrived: st.arrivedShown,
    walked: st.loc.walked,
  };
  if (cfg.walker === 'truth' && st.route) {
    // 사람처럼 걷기: 앱이 추정한 위치가 아니라 실제 위치를 기준으로 경로(=실제 복도)를 따라간다
    if (st.truthRoute !== st.route) {
      st.truthRoute = st.route;
      st.truthGuide = new Guide(st.route);
    }
    const pose = st.sim.pose;
    const g = st.truthGuide.update(pose);
    const path = st.route.path;
    const from = path.pointAt(g.s);
    const to = path.pointAt(Math.min(path.length, g.s + 2.5));
    // 걷는 방향(폰을 틀어 들고 있으면 폰이 향한 쪽과 다르다)이 통로를 따라가게 한다
    nav.rel = angDiff(distXY(from, to) < 0.3 ? from.bearing : bearingXY(from, to), pose.heading - (st.sim.hold || 0));
    nav.arrived = g.arrived;
    st.truthS = g.s;
  }
  return nav;
}

function updateOverlays(now, pitch) {
  const t = st.t;
  const loc = st.loc;
  const mode = loc.mode(now);

  // 아직 위치를 모르면 QR을 비추라고 안내
  $('scan').classList.toggle('hidden', loc.hasFix);
  if (!loc.hasFix) $('scanTitle').textContent = st.detectorReady ? t.scanTitle : t.loadingDetector;
  $('hud').classList.toggle('hidden', !st.route);

  const chip = $('chip');
  chip.classList.toggle('hidden', mode === 'none');
  if (mode === 'marker') {
    chip.textContent = t.modeMarker;
    chip.className = 'chip ok';
  } else if (mode === 'visual') {
    chip.textContent = t.modeVisual(Math.round(loc.walked));
    chip.className = 'chip' + (loc.walked > VO_RESCAN_AFTER ? ' warn' : '');
  } else if (mode === 'steps') {
    if (!cfg.sim && !st.steps) {
      // 걸음 센서를 못 쓰면 QR을 비춘 순간의 위치만 안다
      chip.textContent = t.modeQrOnly;
      chip.className = 'chip warn';
    } else {
      chip.textContent = t.modeSteps(Math.round(loc.walked));
      chip.className = 'chip' + (loc.walked > RESCAN_AFTER ? ' warn' : '');
    }
  }

  // 화살표가 화면 밖에 있으면 몸을 돌리라고 알려 준다
  const rel = guidedDirection();
  let edge = null;
  if (rel != null && !st.arrivedShown) {
    const a = Math.abs(rel);
    const limit = st.edge ? 22 : 32; // 한 번 켜지면 조금 더 돌 때까지 유지
    if (a > limit) edge = a > 140 ? 'back' : rel < 0 ? 'left' : 'right';
  }
  if (edge !== st.edge) {
    st.edge = edge;
    $('edgeL').classList.toggle('hidden', edge !== 'left' && edge !== 'back');
    $('edgeR').classList.toggle('hidden', edge !== 'right');
    $('edgeLText').textContent = edge === 'back' ? t.edgeBack : t.edgeLeft;
  }

  // 폰을 너무 눕혀 들고 있으면 세우라고 알려 준다 (바닥 QR을 비추는 중에는 제외)
  if (st.route && pitch < -62 && mode !== 'marker') {
    if (!st.lookDownSince) st.lookDownSince = now;
    else if (now - st.lookDownSince > 1500) {
      st.lookDownSince = now + 6000;
      toast(t.holdUp, 2500);
    }
  } else if (st.lookDownSince < now) {
    st.lookDownSince = 0;
  }

  if (now - st.lastMini > 120) {
    st.lastMini = now;
    $('mini').classList.toggle('hidden', !loc.hasFix);
    if (loc.hasFix) {
      st.mini.draw({
        pos: st.disp,
        heading: st.heading,
        route: st.route,
        s: st.disp ? st.disp.s : 0,
        dest: st.poi,
        seenIds: loc.seenIds,
        uncertainty: mode === 'steps' ? 0.3 + loc.walked * 0.1 : mode === 'visual' ? 0.2 + loc.walked * 0.02 : 0,
      });
    }
  }

  if (cfg.debug && now - st.lastDebug > 250) {
    st.lastDebug = now;
    $('debug').textContent = debugText(mode);
  }
}

function debugText(mode) {
  const loc = st.loc;
  const f = (v, n = 2) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(n));
  const lines = [
    `mode ${mode}  qr [${loc.seenIds.join(',')}]  detect ${f(st.detMs, 0)}ms`,
    `pos ${loc.pos ? f(loc.pos.x) + ', ' + f(loc.pos.y) : '-'}  h ${f(loc.height)}  head ${f(st.heading, 0)}`,
    `yaw sigma ${f(loc.sigma, 1)}  rms ${f(loc.lastRms, 1)}px  steps ${loc.steps}  walked ${f(loc.walked, 1)}m`,
    `stride ${f(loc.stride)}m${cfg.strideFixed ? ' (fixed)' : ''}  turn snaps ${st.turnSnaps}`,
  ];
  if (st.g) lines.push(`s ${f(st.g.s, 1)}  lateral ${f(st.g.lateral)}  left ${f(st.g.remaining, 1)}m`);
  lines.push(
    cfg.vp
      ? `corridor ${st.vpInfo ? `off ${f(st.vpInfo.err, 1)}deg q${f(st.vpInfo.quality, 0)}` : 'not seen'}  fixes ${st.vpFixes} (${f(st.vpTotal, 1)}deg)`
      : 'corridor check off',
    `walk fixes ${st.walkYawFixes}  hold ${st.holdBiasN >= 6 ? f(st.holdBias, 1) + 'deg' : '-'}`
  );
  if (st.vo) {
    const vo = st.vo;
    const k = st.voK;
    lines.push(
      `slam ${vo.status}${vo.reason ? '/' + vo.reason : ''}  using ${loc.odo}  frames ${vo.frames}`,
      `slam scale ${f(k.s)} (qr ${k.dN} step ${k.stepFix})  yaw ${f(vo.yaw, 0)}  tilt ${f(vo.tilt, 0)}  resets ${vo.resets}/${vo.glitches}`
    );
    if (vo.detail) lines.push(`slam: ${vo.detail}`);
  }
  const rj = loc.rejects;
  if (rj.moving + rj.rms + rj.height > 0) {
    lines.push(`no fix: moving ${rj.moving} rms ${rj.rms} height ${rj.height}  last ${loc.lastReject}`);
  }
  if (st.lastError) lines.push(`ERROR ${st.lastError}`);
  const seen = loc.pos && st.map.markerById.get(loc.seenIds[0]);
  if (seen) {
    // 실제 거리와 다르면 ?fov= 값을 조정한다 (추정 거리가 길게 나오면 화각을 키운다)
    const d = Math.hypot(distXY(loc.pos, seen), loc.height - seen.h);
    lines.push(`dist to ${seen.id} ${f(d)}m  (fov ${cfg.fovLong})`);
  }
  if (st.sim && loc.pos) {
    const p = st.sim.pose;
    lines.push(
      `TRUE ${f(p.x)}, ${f(p.y)} head ${f(p.heading, 0)}`,
      `ERR pos ${f(distXY(loc.pos, p))}m  yaw ${f(angDiff(st.heading, p.heading), 1)}deg`
    );
  }
  return lines.join('\n');
}
