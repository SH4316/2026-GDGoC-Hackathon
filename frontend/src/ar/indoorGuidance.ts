import type { SpaceLayout } from './station';

export type Maneuver = { kind: 'straight' | 'left' | 'right' | 'uturn' | 'realign'; index: number };
export type IndoorCue = { key: string; text: string; spokenText?: string; turn?: { action: string; passage?: string } };

export function indoorCue(space: SpaceLayout, maneuver: Maneuver | undefined, arrived: boolean, targetTag?: number): IndoorCue | undefined {
  const line = targetTag === undefined && space.station.stationLinks?.find(link => link.routeEndpoint === 'end')?.line;
  if (arrived) return { key: space.id + '/arrival', text: targetTag !== undefined ? '태그 ' + targetTag + '에 도착했습니다.' : line ? line + ' 환승 위치에 도착했습니다.' : '실내 통로 끝에 도착했습니다.',
    spokenText: '목적지에 도착하였습니다.' };
  if (!maneuver) return;
  const turns = { left: '여기서 좌회전하세요.', right: '여기서 우회전하세요.', uturn: '여기서 돌아서세요.' };
  const key = [space.id, maneuver.kind, maneuver.index].join('/');
  if (maneuver.kind === 'straight') return { key, text: '통로를 따라 직진하세요.' };
  if (maneuver.kind === 'realign') return { key, text: '카메라가 진행 방향의 반대쪽을 향하고 있습니다. 카메라를 돌려 주세요.' };
  const action = turns[maneuver.kind], passage = line ? line + ' 환승 통로' : undefined;
  return { key, text: action + (passage ? ' ' + passage + '입니다.' : ''), turn: { action, passage } };
}
