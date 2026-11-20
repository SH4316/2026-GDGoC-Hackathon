import type { SpaceLayout, Station, StationLink } from '../ar/station';
import type { GeoPoint, Journey, JourneyProgress } from './routes';

function tagLinks(station: Station, tagId: number): StationLink[] {
  const tag = station.tags.find(item => item.id === tagId);
  const links = station.stationLinks ?? [];
  if (!tag || links.length < 2) return tag ? links : [];
  const endpoints = links.filter(link => {
    if (station.tagGraph) return link.routeEndpoint === 'start' ? tag.id === station.tagGraph.startTag
      : link.routeEndpoint === 'end' && tag.id === station.tagGraph.endTag;
    const point = link.routeEndpoint === 'start' ? station.route[0]
      : link.routeEndpoint === 'end' ? station.route.at(-1) : undefined;
    return point && Math.hypot(point[0] - tag.center[0], point[1] - tag.center[1]) <= 1;
  });
  const candidates = endpoints.length ? endpoints : links;
  return candidates.every(link => link.name === candidates[0].name) ? candidates : [];
}

const lineName = (line: string) => line.replace(/\s/g, '').replace(/^(수도권|서울)/, '')
  .replace(/\((급행|특급|성수지선|신정지선)\)$/, '').replace(/^용인에버라인$/, '에버라인');
const stopName = (name: string) => name.trim().replace(/\([^()]*\)$/, '').trim().replace(/역$/, '');

export type RouteTransfer = {
  spaceId: string; station: string; fromLine: string; toLine: string; point?: GeoPoint;
  transferStep: number; boardingStep: number;
};

function transfersAtStation(trip: Journey, station: Station) {
  const transfers: Omit<RouteTransfer, 'spaceId'>[] = [];
  const start = station.stationLinks?.find(link => link.routeEndpoint === 'start');
  const end = station.stationLinks?.find(link => link.routeEndpoint === 'end');
  if (trip.mode !== 'transit' || !station.tags.length || station.route.length < 2 || !start || !end ||
    stopName(start.name) !== stopName(end.name) || lineName(start.line) === lineName(end.line)) return transfers;

  let incoming = -1;
  for (const [boardingStep, step] of trip.steps.entries()) {
    if (step.kind === '도보') continue;
    const outbound = step.rail;
    if (!outbound) { incoming = -1; continue; }
    const boardStop = outbound.stops[0];
    if (incoming >= 0 && boardStop && stopName(boardStop.name) === stopName(end.name) &&
      outbound.lines.some(line => lineName(line) === lineName(end.line))) {
      const arriving = trip.steps[incoming];
      transfers.push({ station: start.name, fromLine: start.line, toLine: end.line,
        point: boardStop.point ?? step.points[0] ?? arriving.rail?.stops.at(-1)?.point ?? arriving.points.at(-1),
        transferStep: incoming + 1, boardingStep });
    }
    const alightStop = outbound.stops.at(-1);
    incoming = alightStop && stopName(alightStop.name) === stopName(start.name) &&
      outbound.lines.some(line => lineName(line) === lineName(start.line)) ? boardingStep : -1;
  }
  return transfers;
}

export function routeTransfers(trip: Journey, layouts: SpaceLayout[]): RouteTransfer[] {
  const byBoarding = new Map<number, RouteTransfer>();
  for (const layout of layouts) {
    for (const transfer of transfersAtStation(trip, layout.station)) {
      if (byBoarding.has(transfer.boardingStep)) continue;
      byBoarding.set(transfer.boardingStep, { ...transfer, spaceId: layout.id, station: stopName(transfer.station) + '역' });
    }
  }
  return [...byBoarding.values()].sort((a, b) => a.boardingStep - b.boardingStep);
}

export function progressAtIndoorArrival(trip: Journey, current: JourneyProgress, layout: SpaceLayout, time: number): JourneyProgress {
  if (current.tagTime !== undefined && time < current.tagTime) return current;
  const transfer = transfersAtStation(trip, layout.station).find(candidate => candidate.boardingStep >= current.step);
  if (!transfer || (transfer.boardingStep === current.step && (current.stopIndex ?? -1) >= 0)) return current;
  return { step: transfer.boardingStep, stopIndex: 0, station: transfer.station, position: transfer.point, tagTime: time };
}

// Search results include station POIs such as 정왕역[수도권4호선] as well as nearby exits and shops.
function isStationPlace(place: string, link: StationLink) {
  const title = stopName(link.name) + '역';
  if (place === title) return true;
  if (!place.startsWith(title)) return false;
  const qualifier = place.slice(title.length).trim().replace(/^\[(.+)\]$/, '$1');
  return lineName(qualifier) === lineName(link.line);
}

export function progressAtTag(trip: Journey, current: JourneyProgress, station: Station, tagId: number, time: number): JourneyProgress {
  if (current.step === trip.steps.length) return current;
  const links = tagLinks(station, tagId);
  if (!links.length) return current;
  // A station POI may be labelled with a different line in the same registered transfer space.
  const stationLines = station.stationLinks!.filter(link => link.name === links[0].name);
  const destination = stationLines.find(link => isStationPlace(trip.destination.name, link));
  if (destination) return { step: trip.steps.length, station: destination.name, position: trip.destination.point, tagTime: time };

  // Seeing a tag from across the corridor establishes the station. Only a pose at
  // the corridor's endpoint confirms that the traveller reached the boarding platform.
  const transfer = transfersAtStation(trip, station).find(candidate => candidate.boardingStep >= current.step);
  if (transfer) {
    const incoming = trip.steps[transfer.transferStep - 1];
    const hasWalk = transfer.transferStep < transfer.boardingStep;
    const step = hasWalk ? transfer.transferStep : transfer.transferStep - 1;
    const stopIndex = hasWalk ? -1 : incoming.rail!.stops.length - 1;
    if (current.step > step || (current.step === step && current.station === transfer.station && current.stopIndex === stopIndex)) return current;
    return { step, stopIndex, station: transfer.station,
      position: incoming.rail?.stops.at(-1)?.point ?? incoming.points.at(-1), tagTime: time };
  }

  // Include the previous leg's alighting stop, which opens the following (often transfer-walk) step.
  const hasDirectionalCorridor = stationLines.some(link => link.routeEndpoint === 'start') &&
    stationLines.some(link => link.routeEndpoint === 'end');
  for (let i = Math.max(0, current.step - 1); i < trip.steps.length; i++) {
    const leg = trip.steps[i];
    const rail = leg.rail;
    if (!rail) continue;
    for (const [j, stop] of rail.stops.entries()) {
      const link = links.find(link => stopName(link.name) === stopName(stop.name) &&
        (!rail.lines.length || rail.lines.some(line => lineName(line) === lineName(link.line))));
      if (!link) continue;
      // A different (for example reverse-direction) corridor at the same interchange
      // still identifies the station, but does not complete the planned transfer.
      if (j === 0 && hasDirectionalCorridor) {
        const previousLeg = trip.steps.slice(0, i).findLast(leg => leg.kind !== '도보');
        const previousStop = previousLeg?.rail?.stops.at(-1);
        if (previousStop && stopName(previousStop.name) === stopName(stop.name)) continue;
      }
      const alighting = rail.stops.length > 1 && j === rail.stops.length - 1;
      const step = alighting ? i + 1 : i;
      const stopIndex = alighting ? -1 : j;
      if (step < current.step || (step === current.step && stopIndex < (current.stopIndex ?? -1))) continue;
      if (step === current.step && current.stopIndex === stopIndex && current.station === link.name) return current;
      const position = stop.point ?? (alighting ? leg.points.at(-1) : j === 0 ? leg.points[0] : undefined);
      return { step, stopIndex, station: link.name, position, tagTime: time };
    }
  }
  const origin = stationLines.find(link => isStationPlace(trip.origin.name, link));
  if (origin && current.step === 0 && !current.station)
    return { step: 0, position: trip.origin.point, station: origin.name, tagTime: time };
  return current;
}
