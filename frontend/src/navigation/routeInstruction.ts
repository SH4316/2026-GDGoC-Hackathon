import { copy, lineLabel, type Language } from '../i18n/language.ts';
import { stationLabel } from '../i18n/stationLabel.ts';
import { displayPlaceName, type RouteStep } from './routes.ts';

const turns: Record<string, string> = {
  좌회전: 'Turn left', 우회전: 'Turn right', 직진: 'Go straight', 유턴: 'Make a U-turn',
  횡단보도: 'Cross the street', '지하보도 진입': 'Enter the underpass',
};

export function placeLabel(name: string, language: Language) {
  if (name === '현재 위치' || name === '지도에서 선택한 출발지' || name === '지도에서 선택한 도착지')
    return copy[language](name);
  const formatted = displayPlaceName(name);
  if (language === 'ko') return formatted;
  if (formatted !== name) {
    const [station, line] = formatted.split(' · ');
    return stationLabel(station, language) + ' · ' + lineLabel(line, language);
  }
  const exit = /^(.+역)\s*(\d+)번\s*출구$/.exec(name);
  if (exit) return stationLabel(exit[1], language) + ' Exit ' + exit[2];
  return name.endsWith('역') ? stationLabel(name, language) : name;
}

// Translate the known instruction formats without changing the provider data used for transfer matching.
export function routeInstruction(step: RouteStep, language: Language) {
  const text = step.instruction;
  if (language === 'ko') return text;
  const ride = /^(?:(.+?)에서 )?(.+?) 탑승(?: → (.+?)에서 하차)?$/.exec(text);
  if (ride) {
    const stop = (name: string) => step.kind === '지하철' || step.rail ? stationLabel(name, language) : placeLabel(name, language);
    return 'Take ' + lineLabel(copy.en(ride[2]), language) + (ride[1] ? ' from ' + stop(ride[1]) : '') + (ride[3] ? ' to ' + stop(ride[3]) : '') + '.';
  }
  const to = /^(.+)까지 도보 이동$/.exec(text);
  if (to) return 'Walk to ' + stationLabel(placeLabel(to[1], language), language) + '.';
  const walk = /^(?:(.+?)에서 )?(?:(.+?) 후 )?(?:(.+?)[을를] 따라 )?([\d,.]+)m 이동$/.exec(text);
  if (walk && (!walk[2] || Object.hasOwn(turns, walk[2]))) {
    const road = walk[3] === '보행자도로' ? 'the footpath' : walk[3];
    const prefix = walk[1] ? 'At ' + placeLabel(walk[1], language) + ', ' : '';
    const turn = walk[2] && turns[walk[2]];
    const instruction = (turn ? turn + ', then walk ' : 'Walk ') + walk[4] + ' m' + (road ? ' along ' + road : '');
    return prefix + (prefix ? instruction[0].toLowerCase() + instruction.slice(1) : instruction) + '.';
  }
  return copy.en(text);
}
