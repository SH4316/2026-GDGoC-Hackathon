// 목적지 종류(아이콘, 이름, 검색어)와 "말한 문장 → 목적지" 매칭.
//
// 지금은 검색어 사전으로 맞춘다. LLM을 붙일 때는 matchDestination만 바꾸면 된다
// (문장과 목적지 목록을 주고 목적지 id를 고르게 하는 식).

export const POI_TYPES = {
  exit: {
    icon: '🚪',
    group: 'exits',
    name: {
      ko: (n) => `${n}번 출구`,
      en: (n) => `Exit ${n}`,
      ja: (n) => `${n}番出口`,
      zh: (n) => `${n}号出口`,
    },
    keywords: ['출구', '나가는', '밖으로', 'exit', 'way out', '出口'],
  },
  platform: {
    icon: '🚇',
    group: 'platforms',
    name: { ko: '승강장', en: 'Platform', ja: 'ホーム', zh: '站台' },
    keywords: ['승강장', '타는곳', '플랫폼', 'platform', 'ホーム', 'のりば', '乗り場', '站台', '月台', '乘车'],
  },
  toilet: {
    icon: '🚻',
    group: 'facilities',
    name: { ko: '화장실', en: 'Restroom', ja: 'トイレ', zh: '洗手间' },
    keywords: [
      '화장실', 'toilet', 'toilets', 'restroom', 'bathroom', 'washroom',
      'トイレ', 'お手洗い', '化粧室', '厕所', '洗手间', '卫生间', '廁所',
    ],
  },
  elevator: {
    icon: '🛗',
    group: 'facilities',
    name: { ko: '엘리베이터', en: 'Elevator', ja: 'エレベーター', zh: '电梯' },
    keywords: ['엘리베이터', '승강기', 'elevator', 'lift', 'エレベーター', '电梯', '電梯'],
  },
  ticket: {
    icon: '🎫',
    group: 'facilities',
    name: { ko: '승차권 발매기', en: 'Ticket machines', ja: '券売機', zh: '售票机' },
    keywords: [
      '승차권', '발매기', '매표', '표사', '표를', '충전', '티머니',
      'ticket', 'tickets', 'top up', 'recharge', 't-money', 'tmoney',
      '切符', 'きっぷ', '券売機', 'チャージ', '售票', '车票', '買票', '买票', '充值',
    ],
  },
  locker: {
    icon: '🧳',
    group: 'facilities',
    name: { ko: '물품보관함', en: 'Lockers', ja: 'コインロッカー', zh: '储物柜' },
    keywords: [
      '보관함', '물품', '락커', '라커', '짐', 'locker', 'lockers', 'luggage', 'baggage',
      'ロッカー', '荷物', '储物柜', '寄存', '行李',
    ],
  },
  info: {
    icon: 'ℹ️',
    group: 'facilities',
    name: { ko: '안내소', en: 'Information', ja: '案内所', zh: '问讯处' },
    keywords: [
      '안내소', '안내센터', '고객센터', '역무실', 'information', 'info', 'help desk',
      '案内所', 'インフォメーション', '问讯', '咨询', '服务中心',
    ],
  },
  store: {
    icon: '🏪',
    group: 'facilities',
    name: { ko: '편의점', en: 'Convenience store', ja: 'コンビニ', zh: '便利店' },
    keywords: ['편의점', '가게', 'convenience', 'store', 'shop', 'コンビニ', '便利店', '商店'],
  },
  place: {
    icon: '📍',
    group: 'facilities',
    name: { ko: '목적지', en: 'Destination', ja: '目的地', zh: '目的地' },
    keywords: [],
  },
};

export function poiType(poi) {
  return POI_TYPES[poi.type] || POI_TYPES.place;
}

export function poiIcon(poi) {
  return poi.icon || poiType(poi).icon;
}

/** 목적지 이름. 지도에 이름이 적혀 있으면 그것을, 없으면 종류별 기본 이름을 쓴다. */
export function poiName(poi, lang) {
  if (poi.name && (poi.name[lang] || poi.name.en || poi.name.ko)) {
    return poi.name[lang] || poi.name.en || poi.name.ko;
  }
  const n = poiType(poi).name;
  const v = n[lang] || n.en;
  return typeof v === 'function' ? v(poi.number) : v;
}

/** 부가 설명 (예: "2호선 · 강남 방면") */
export function poiDetail(poi, lang) {
  if (!poi.detail) return '';
  return poi.detail[lang] || poi.detail.en || poi.detail.ko || '';
}

const KO_NUM = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10 };
const CJK_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** 문장에서 출구 번호 같은 숫자를 찾는다 */
export function parseNumber(text) {
  let m = /\d+/.exec(text);
  if (m) return parseInt(m[0], 10);
  m = /(일|이|삼|사|오|육|칠|팔|구|십)\s*번/.exec(text);
  if (m) return KO_NUM[m[1]];
  m = /([一二三四五六七八九十])\s*[号號番]/.exec(text);
  if (m) return CJK_NUM[m[1]];
  m = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.exec(text);
  if (m) return EN_NUM[m[1]];
  return null;
}

/** 검색어가 문장에 들어 있으면 그 길이를, 없으면 0을 돌려준다 */
function keywordScore(kw, lower, compact) {
  const k = kw.toLowerCase();
  if (/^[\x20-\x7e]+$/.test(k)) {
    // 영문은 단어 단위로만 맞춘다 ("store"가 "restore"에 걸리지 않게)
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower) ? k.length : 0;
  }
  return compact.includes(k.replace(/\s+/g, '')) ? k.length + 1 : 0;
}

/**
 * 말하거나 입력한 문장에 맞는 목적지 후보를 고른다.
 * 후보가 하나면 바로 확정할 수 있고, 여러 개면 사용자가 고르게 한다. 없으면 빈 배열.
 */
export function matchDestination(text, pois) {
  if (!text) return [];
  const lower = text.toLowerCase().trim();
  const compact = lower.replace(/\s+/g, '');
  const num = parseNumber(lower);

  const scored = [];
  for (const poi of pois) {
    const type = poiType(poi);
    let score = 0;
    for (const kw of type.keywords) score = Math.max(score, keywordScore(kw, lower, compact));
    // 지도에 적힌 고유 검색어와 이름은 더 구체적이므로 가산점을 준다
    const own = [...(poi.keywords || []), ...Object.values(poi.name || {})];
    for (const kw of own) {
      const s = keywordScore(kw, lower, compact);
      if (s) score = Math.max(score, s + 20);
    }
    if (poi.number != null && num != null) {
      // 번호가 있는 목적지(출구 등)는 번호가 맞아야 한다
      if (poi.number === num && (score > 0 || compact === String(num))) score += 50;
      else if (poi.number !== num && score < 20) score = 0;
    }
    if (score > 0) scored.push({ poi, score });
  }
  if (!scored.length) return [];
  const top = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === top).map((s) => s.poi);
}
