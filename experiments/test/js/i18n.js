// 화면 문구와 음성 안내 문장 (한국어, 영어, 일본어, 중국어).
// 언어를 추가하려면 같은 모양의 객체를 하나 더 만들어 LANGS에 넣으면 된다.

import { roundMeters } from './geo.js';

const d = (m) => `${roundMeters(m)}m`;

const ko = {
  code: 'ko',
  label: '한국어',
  speechLang: 'ko-KR',
  appName: '이리로',
  tagline: 'QR 안내판에 카메라를 비추면\n화살표가 길을 알려줘요',
  start: '시작하기',
  tryDemo: '가상 역에서 체험하기',
  permHint: '카메라와 동작 센서 사용을 허용해 주세요',
  youAreNear: (name) => `현재 위치: ${name} 근처`,
  whereTo: '어디로 가시나요?',
  speakBtn: '말해서 찾기',
  listening: '듣고 있어요…',
  typeHint: '가고 싶은 곳을 입력하세요',
  search: '찾기',
  heard: (s) => `“${s}”`,
  notUnderstood: '찾지 못했어요. 아래에서 골라 주세요.',
  chooseOne: '어느 곳인가요?',
  groups: { exits: '출구', platforms: '타는 곳', facilities: '편의시설' },
  goBtn: (name) => `${name}까지 안내 시작`,
  scanTitle: '가까운 QR 안내판을\n카메라로 비춰 주세요',
  scanSub: '현재 위치를 확인합니다',
  loadingDetector: 'QR 인식 준비 중…',
  located: '현재 위치를 확인했어요',
  modeMarker: 'QR로 위치 확인 중',
  modeSteps: (n) => `걸음으로 추정 중 · ${n}m`,
  modeQrOnly: 'QR을 비출 때마다 위치를 맞춰요',
  modeVisual: (n) => `카메라로 추적 중 · ${n}m`,
  slamLoading: '정밀 추적을 준비하고 있어요…',
  slamFail: '정밀 추적을 켜지 못해 기본 방식으로 안내합니다.',
  rescanHint: '정확도가 떨어졌어요. 가까운 QR을 다시 비춰 주세요.',
  remaining: (m) => `${d(m)} 남음`,
  exit: '안내 종료',
  voiceOn: '소리 켬',
  voiceOff: '소리 끔',
  edgeLeft: '왼쪽으로\n몸을 돌리세요',
  edgeRight: '오른쪽으로\n몸을 돌리세요',
  edgeBack: '뒤로\n돌아서세요',
  holdUp: '휴대폰을 세워서 앞을 비춰 주세요',
  rerouting: '경로를 벗어났어요. 새 길로 안내합니다.',
  noRoute: '거기까지 가는 길을 찾지 못했어요. 지도의 통로가 이어져 있는지 확인해 주세요.',
  arrivedTitle: '도착했어요!',
  again: '다른 곳 가기',
  noCamera: '카메라를 쓸 수 없어요. 권한을 확인해 주세요.',
  noMotion: '동작 센서를 쓸 수 없어요. 브라우저 설정에서 동작·방향 접근을 허용해 주세요.',
  simBadge: '가상 역',
  simAuto: '자동 걷기',
  simManual: '직접 걷기',
  simWalk: '걷기',
  simHint: '가상 역에서 가상 보행자가 안내를 따라 걸어가요',
  simManualHint: '화면을 끌어 둘러보고, 걷기 버튼을 누르고 있으면 걸어요',
  mapError: '지도를 불러오지 못했어요',
  dist: d,

  instruction({ stage, kind, dist }) {
    const then = {
      slightLeft: '왼쪽 방향으로 가요',
      left: '왼쪽으로 꺾어요',
      sharpLeft: '왼쪽으로 크게 꺾어요',
      slightRight: '오른쪽 방향으로 가요',
      right: '오른쪽으로 꺾어요',
      sharpRight: '오른쪽으로 크게 꺾어요',
      uturn: '뒤로 돌아가요',
    };
    const soon = {
      slightLeft: '왼쪽 방향',
      left: '왼쪽',
      sharpLeft: '크게 왼쪽',
      slightRight: '오른쪽 방향',
      right: '오른쪽',
      sharpRight: '크게 오른쪽',
      uturn: '뒤로 돌기',
    };
    const now = {
      slightLeft: '여기서 왼쪽 방향으로!',
      left: '여기서 왼쪽으로!',
      sharpLeft: '여기서 왼쪽으로 크게!',
      slightRight: '여기서 오른쪽 방향으로!',
      right: '여기서 오른쪽으로!',
      sharpRight: '여기서 오른쪽으로 크게!',
      uturn: '여기서 뒤로 도세요!',
    };
    if (kind === 'arrive') {
      if (stage === 'far') return { main: `앞으로 ${d(dist)}`, sub: '그다음 도착이에요' };
      return { main: '곧 도착해요', sub: `${d(dist)} 남았어요` };
    }
    if (stage === 'far') return { main: `앞으로 ${d(dist)}`, sub: `그다음 ${then[kind]}` };
    if (stage === 'soon') return { main: `${d(dist)} 앞에서 ${soon[kind]}`, sub: then[kind] };
    return { main: now[kind], sub: '' };
  },

  speech({ stage, kind, dist }) {
    const say = {
      slightLeft: '왼쪽 방향으로 가세요',
      left: '왼쪽으로 꺾으세요',
      sharpLeft: '왼쪽으로 크게 꺾으세요',
      slightRight: '오른쪽 방향으로 가세요',
      right: '오른쪽으로 꺾으세요',
      sharpRight: '오른쪽으로 크게 꺾으세요',
      uturn: '뒤로 돌아가세요',
    };
    const n = `${roundMeters(dist)}미터`;
    if (kind === 'arrive') {
      return stage === 'far' ? `약 ${n} 직진하면 목적지입니다.` : '곧 목적지입니다.';
    }
    if (stage === 'far') return `약 ${n} 직진한 다음, ${say[kind]}.`;
    if (stage === 'soon') return `잠시 후 ${say[kind]}.`;
    return `지금 ${say[kind]}.`;
  },
  speechStart: (name) => `위치를 확인했습니다. ${name}까지 안내를 시작합니다. 바닥의 화살표를 따라 걸으세요.`,
  speechArrived: '목적지에 도착했습니다. 안내를 마칩니다.',
  speechReroute: '경로를 벗어났습니다. 새 길로 안내합니다.',
  speechScan: '가까운 큐알 안내판을 카메라로 비춰 주세요.',
};

const en = {
  code: 'en',
  label: 'English',
  speechLang: 'en-US',
  appName: 'Iriro',
  tagline: 'Point your camera at a QR sign\nand follow the arrows',
  start: 'Start',
  tryDemo: 'Try the virtual station',
  permHint: 'Please allow camera and motion sensor access',
  youAreNear: (name) => `You are near: ${name}`,
  whereTo: 'Where are you going?',
  speakBtn: 'Speak to search',
  listening: 'Listening…',
  typeHint: 'Type where you want to go',
  search: 'Find',
  heard: (s) => `“${s}”`,
  notUnderstood: 'Not found. Please choose from the list below.',
  chooseOne: 'Which one?',
  groups: { exits: 'Exits', platforms: 'Trains', facilities: 'Facilities' },
  goBtn: (name) => `Guide me to ${name}`,
  scanTitle: 'Point your camera at\na nearby QR sign',
  scanSub: 'to find your location',
  loadingDetector: 'Getting ready…',
  located: 'Location found',
  modeMarker: 'Locating with QR',
  modeSteps: (n) => `Estimating by steps · ${n}m`,
  modeQrOnly: 'Position updates each time you scan a QR',
  modeVisual: (n) => `Tracking with camera · ${n}m`,
  slamLoading: 'Preparing precise tracking…',
  slamFail: 'Precise tracking is unavailable. Using the standard mode.',
  rescanHint: 'Accuracy is dropping. Please scan a nearby QR sign again.',
  remaining: (m) => `${d(m)} left`,
  exit: 'End',
  voiceOn: 'Sound on',
  voiceOff: 'Sound off',
  edgeLeft: 'Turn your body\nto the left',
  edgeRight: 'Turn your body\nto the right',
  edgeBack: 'Turn\naround',
  holdUp: 'Hold your phone upright and point it ahead',
  rerouting: 'Off route. Guiding you along a new route.',
  noRoute: 'No route found. Please check that the corridors on the map are connected.',
  arrivedTitle: 'You have arrived!',
  again: 'Go somewhere else',
  noCamera: 'Camera unavailable. Please check the permission.',
  noMotion: 'Motion sensors unavailable. Please allow motion and orientation access in your browser settings.',
  simBadge: 'Virtual station',
  simAuto: 'Auto walk',
  simManual: 'Manual',
  simWalk: 'Walk',
  simHint: 'A virtual walker follows the guidance through a virtual station',
  simManualHint: 'Drag to look around, hold Walk to move',
  mapError: 'Could not load the map',
  dist: d,

  instruction({ stage, kind, dist }) {
    const then = {
      slightLeft: 'bear left',
      left: 'turn left',
      sharpLeft: 'sharp left',
      slightRight: 'bear right',
      right: 'turn right',
      sharpRight: 'sharp right',
      uturn: 'turn around',
    };
    const now = {
      slightLeft: 'Bear left here!',
      left: 'Turn left here!',
      sharpLeft: 'Sharp left here!',
      slightRight: 'Bear right here!',
      right: 'Turn right here!',
      sharpRight: 'Sharp right here!',
      uturn: 'Turn around here!',
    };
    if (kind === 'arrive') {
      if (stage === 'far') return { main: `Straight ${d(dist)}`, sub: 'then you arrive' };
      return { main: 'Almost there', sub: `${d(dist)} to go` };
    }
    if (stage === 'far') return { main: `Straight ${d(dist)}`, sub: `then ${then[kind]}` };
    if (stage === 'soon') return { main: `In ${d(dist)}, ${then[kind]}`, sub: '' };
    return { main: now[kind], sub: '' };
  },

  speech({ stage, kind, dist }) {
    const say = {
      slightLeft: 'bear left',
      left: 'turn left',
      sharpLeft: 'make a sharp left',
      slightRight: 'bear right',
      right: 'turn right',
      sharpRight: 'make a sharp right',
      uturn: 'turn around',
    };
    const n = `${roundMeters(dist)} meters`;
    if (kind === 'arrive') {
      return stage === 'far'
        ? `Go straight for about ${n} to your destination.`
        : 'Your destination is just ahead.';
    }
    if (stage === 'far') return `Go straight for about ${n}, then ${say[kind]}.`;
    if (stage === 'soon') return `Get ready to ${say[kind]}.`;
    return `Now ${say[kind]}.`;
  },
  speechStart: (name) => `Location found. Starting guidance to ${name}. Follow the arrows on the floor.`,
  speechArrived: 'You have arrived at your destination.',
  speechReroute: 'You are off route. Guiding you along a new route.',
  speechScan: 'Please point your camera at a nearby QR sign.',
};

const ja = {
  code: 'ja',
  label: '日本語',
  speechLang: 'ja-JP',
  appName: 'Iriro',
  tagline: 'QR案内板にカメラを向けると\n矢印が道を案内します',
  start: 'スタート',
  tryDemo: 'バーチャル駅で試す',
  permHint: 'カメラとモーションセンサーの使用を許可してください',
  youAreNear: (name) => `現在地：${name} 付近`,
  whereTo: 'どこへ行きますか？',
  speakBtn: '話して探す',
  listening: '聞いています…',
  typeHint: '行き先を入力してください',
  search: '検索',
  heard: (s) => `「${s}」`,
  notUnderstood: '見つかりませんでした。下から選んでください。',
  chooseOne: 'どちらですか？',
  groups: { exits: '出口', platforms: 'のりば', facilities: '施設' },
  goBtn: (name) => `${name}まで案内開始`,
  scanTitle: '近くのQR案内板に\nカメラを向けてください',
  scanSub: '現在地を確認します',
  loadingDetector: '準備中…',
  located: '現在地を確認しました',
  modeMarker: 'QRで位置を確認中',
  modeSteps: (n) => `歩数で推定中 · ${n}m`,
  modeQrOnly: 'QRを読み取るたびに位置を更新します',
  modeVisual: (n) => `カメラで追跡中 · ${n}m`,
  slamLoading: '高精度トラッキングを準備中…',
  slamFail: '高精度トラッキングを開始できないため、通常モードで案内します。',
  rescanHint: '精度が下がっています。近くのQRをもう一度読み取ってください。',
  remaining: (m) => `あと${d(m)}`,
  exit: '案内終了',
  voiceOn: '音声オン',
  voiceOff: '音声オフ',
  edgeLeft: '左を\n向いてください',
  edgeRight: '右を\n向いてください',
  edgeBack: '後ろを\n向いてください',
  holdUp: 'スマホを立てて前に向けてください',
  rerouting: 'ルートを外れました。新しいルートで案内します。',
  noRoute: 'ルートが見つかりません。地図の通路がつながっているか確認してください。',
  arrivedTitle: '到着しました！',
  again: '別の場所へ',
  noCamera: 'カメラを使用できません。権限を確認してください。',
  noMotion: 'モーションセンサーを使用できません。ブラウザの設定で「モーションと画面の向き」を許可してください。',
  simBadge: 'バーチャル駅',
  simAuto: '自動歩行',
  simManual: '手動',
  simWalk: '歩く',
  simHint: 'バーチャル駅で仮想の歩行者が案内に沿って歩きます',
  simManualHint: 'ドラッグで見回し、「歩く」を押している間歩きます',
  mapError: '地図を読み込めませんでした',
  dist: d,

  instruction({ stage, kind, dist }) {
    const then = {
      slightLeft: '左方向へ進みます',
      left: '左に曲がります',
      sharpLeft: '大きく左に曲がります',
      slightRight: '右方向へ進みます',
      right: '右に曲がります',
      sharpRight: '大きく右に曲がります',
      uturn: '引き返します',
    };
    const soon = {
      slightLeft: '左方向へ',
      left: '左へ',
      sharpLeft: '大きく左へ',
      slightRight: '右方向へ',
      right: '右へ',
      sharpRight: '大きく右へ',
      uturn: '引き返す',
    };
    const now = {
      slightLeft: 'ここで左方向へ！',
      left: 'ここで左へ！',
      sharpLeft: 'ここで大きく左へ！',
      slightRight: 'ここで右方向へ！',
      right: 'ここで右へ！',
      sharpRight: 'ここで大きく右へ！',
      uturn: 'ここで引き返してください！',
    };
    if (kind === 'arrive') {
      if (stage === 'far') return { main: `まっすぐ ${d(dist)}`, sub: 'その先が目的地です' };
      return { main: 'まもなく到着', sub: `あと${d(dist)}` };
    }
    if (stage === 'far') return { main: `まっすぐ ${d(dist)}`, sub: `その先、${then[kind]}` };
    if (stage === 'soon') return { main: `${d(dist)}先を${soon[kind]}`, sub: then[kind] };
    return { main: now[kind], sub: '' };
  },

  speech({ stage, kind, dist }) {
    const say = {
      slightLeft: '左方向に進んでください',
      left: '左に曲がってください',
      sharpLeft: '大きく左に曲がってください',
      slightRight: '右方向に進んでください',
      right: '右に曲がってください',
      sharpRight: '大きく右に曲がってください',
      uturn: '引き返してください',
    };
    const n = `${roundMeters(dist)}メートル`;
    if (kind === 'arrive') {
      return stage === 'far' ? `約${n}直進すると目的地です。` : 'まもなく目的地です。';
    }
    if (stage === 'far') return `約${n}直進して、${say[kind]}。`;
    if (stage === 'soon') return `まもなく、${say[kind]}。`;
    return `ここで、${say[kind]}。`;
  },
  speechStart: (name) => `現在地を確認しました。${name}まで案内を開始します。床の矢印に沿って進んでください。`,
  speechArrived: '目的地に到着しました。案内を終了します。',
  speechReroute: 'ルートを外れました。新しいルートで案内します。',
  speechScan: '近くのQR案内板にカメラを向けてください。',
};

const zh = {
  code: 'zh',
  label: '中文',
  speechLang: 'zh-CN',
  appName: 'Iriro',
  tagline: '将摄像头对准二维码指示牌\n箭头为您指路',
  start: '开始',
  tryDemo: '在虚拟车站体验',
  permHint: '请允许使用摄像头和运动传感器',
  youAreNear: (name) => `当前位置：${name} 附近`,
  whereTo: '您要去哪里？',
  speakBtn: '语音查找',
  listening: '正在聆听…',
  typeHint: '请输入您想去的地方',
  search: '查找',
  heard: (s) => `“${s}”`,
  notUnderstood: '没有找到，请从下方选择。',
  chooseOne: '请问是哪一个？',
  groups: { exits: '出口', platforms: '乘车', facilities: '设施' },
  goBtn: (name) => `开始导航到${name}`,
  scanTitle: '请将摄像头对准\n附近的二维码指示牌',
  scanSub: '以确认您的位置',
  loadingDetector: '准备中…',
  located: '已确认当前位置',
  modeMarker: '正在通过二维码定位',
  modeSteps: (n) => `按步数估算中 · ${n}m`,
  modeQrOnly: '每次扫描二维码时更新位置',
  modeVisual: (n) => `正在用摄像头跟踪 · ${n}m`,
  slamLoading: '正在准备精确跟踪…',
  slamFail: '无法启动精确跟踪，将使用标准方式导航。',
  rescanHint: '定位精度下降，请再次扫描附近的二维码。',
  remaining: (m) => `还有${d(m)}`,
  exit: '结束导航',
  voiceOn: '语音开',
  voiceOff: '语音关',
  edgeLeft: '请向左\n转身',
  edgeRight: '请向右\n转身',
  edgeBack: '请向后\n转身',
  holdUp: '请竖起手机并对准前方',
  rerouting: '已偏离路线，正在按新路线导航。',
  noRoute: '未找到路线。请检查地图中的通道是否连通。',
  arrivedTitle: '已到达！',
  again: '去其他地方',
  noCamera: '无法使用摄像头，请检查权限。',
  noMotion: '无法使用运动传感器。请在浏览器设置中允许“运动与方向”访问。',
  simBadge: '虚拟车站',
  simAuto: '自动行走',
  simManual: '手动',
  simWalk: '行走',
  simHint: '虚拟行人会在虚拟车站中按导航行走',
  simManualHint: '拖动屏幕环顾四周，按住“行走”移动',
  mapError: '无法加载地图',
  dist: d,

  instruction({ stage, kind, dist }) {
    const then = {
      slightLeft: '靠左前行',
      left: '左转',
      sharpLeft: '向左急转',
      slightRight: '靠右前行',
      right: '右转',
      sharpRight: '向右急转',
      uturn: '掉头',
    };
    if (kind === 'arrive') {
      if (stage === 'far') return { main: `直行 ${d(dist)}`, sub: '然后到达目的地' };
      return { main: '即将到达', sub: `还有${d(dist)}` };
    }
    if (stage === 'far') return { main: `直行 ${d(dist)}`, sub: `然后${then[kind]}` };
    if (stage === 'soon') return { main: `${d(dist)}后${then[kind]}`, sub: '' };
    return { main: `在这里${then[kind]}！`, sub: '' };
  },

  speech({ stage, kind, dist }) {
    const say = {
      slightLeft: '靠左前行',
      left: '左转',
      sharpLeft: '向左急转',
      slightRight: '靠右前行',
      right: '右转',
      sharpRight: '向右急转',
      uturn: '掉头',
    };
    const n = `${roundMeters(dist)}米`;
    if (kind === 'arrive') {
      return stage === 'far' ? `直行约${n}到达目的地。` : '即将到达目的地。';
    }
    if (stage === 'far') return `直行约${n}，然后${say[kind]}。`;
    if (stage === 'soon') return `前方即将${say[kind]}。`;
    return `现在${say[kind]}。`;
  },
  speechStart: (name) => `已确认当前位置。开始导航到${name}。请沿着地面的箭头前进。`,
  speechArrived: '您已到达目的地，导航结束。',
  speechReroute: '您已偏离路线，正在按新路线导航。',
  speechScan: '请将摄像头对准附近的二维码指示牌。',
};

export const LANGS = { ko, en, ja, zh };

/** 브라우저 언어 설정에서 가장 가까운 언어를 고른다 */
export function detectLang() {
  const nav = (navigator.language || 'en').toLowerCase();
  for (const code of Object.keys(LANGS)) {
    if (nav.startsWith(code)) return code;
  }
  return 'en';
}
