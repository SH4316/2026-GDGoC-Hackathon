import { copy, lineLabel, type Language } from '../i18n/language.ts';
import type { SpaceLayout } from './station';

export type Maneuver = {
  kind: 'straight' | 'left' | 'right' | 'uturn' | 'realign' | 'confirm'; index: number;
  stage?: 'soon' | 'now'; direction?: 'left' | 'right' | 'behind';
};
export type IndoorCue = {
  language: Language; key: string; text: string; spokenText?: string; turn?: { action: string; passage?: string };
  reorient?: 'left' | 'right' | 'behind';
};

export function indoorCue(space: SpaceLayout, maneuver: Maneuver | undefined, arrived: boolean, targetTag?: number, language: Language = 'ko'): IndoorCue | undefined {
  const t = copy[language];
  const line = targetTag === undefined && space.station.stationLinks?.find(link => link.routeEndpoint === 'end')?.line;
  if (arrived) return { language, key: space.id + '/arrival',
    text: targetTag !== undefined ? t('태그 {id}에 도착했습니다.', { id: targetTag })
      : line ? t('{line} 환승 위치에 도착했습니다.', { line: lineLabel(line, language) }) : t('실내 통로 끝에 도착했습니다.'),
    spokenText: t('목적지에 도착하였습니다.') };
  if (!maneuver) return;
  const turns = { left: '여기서 좌회전하세요.', right: '여기서 우회전하세요.', uturn: '여기서 돌아서세요.' };
  const upcoming = { left: '잠시 후 좌회전하세요.', right: '잠시 후 우회전하세요.', uturn: '잠시 후 돌아서세요.' };
  const key = [space.id, maneuver.kind, maneuver.index, maneuver.stage, maneuver.direction].filter(part => part !== undefined).join('/');
  if (maneuver.kind === 'straight') return { language, key, text: t('통로를 따라 직진하세요.') };
  if (maneuver.kind === 'confirm') return { language, key, text: t('목적지 근처입니다. 도착을 확인하려면 태그를 비추세요.') };
  if (maneuver.kind === 'realign') {
    const side = maneuver.direction === 'left' ? '왼쪽' : maneuver.direction === 'right' ? '오른쪽' : '뒤쪽';
    return { language, key, reorient: maneuver.direction, text: t('진행 방향이 {side}에 있습니다. 카메라를 {side}으로 돌려 주세요.', { side: t(side) }) };
  }
  const action = t(maneuver.stage === 'soon' ? upcoming[maneuver.kind] : turns[maneuver.kind]);
  const passage = line ? t('{line} 환승 통로', { line: lineLabel(line, language) }) : undefined;
  return { language, key, text: passage ? t('{action} {passage}입니다.', { action, passage }) : action, turn: { action, passage } };
}
