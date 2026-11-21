import type { SpaceLayout, Station, StationLink } from '../ar/station';
import type { GeoPoint, Journey, JourneyProgress } from './routes';

function tagLinks(station: Station, tagId: number): StationLink[] {
  const tag = station.tags.find(item => item.id === tagId);
  const links = station.stationLinks ?? [];
  if (!tag || links.length < 2) return tag ? links : [];
  const endpoints = links.filter(link => {
    const graph = station.tagGraph || station.autoRoute;
    if (graph) return link.routeEndpoint === 'start' ? tag.id === graph.startTag
      : link.routeEndpoint === 'end' && tag.id === graph.endTag;
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

// Automatic tag passages are bidirectional. Orient all consumers (route tree,
// minimap, spoken line name and boarding confirmation) for this itinerary.
export function orientTransferLayout(trip: Journey, layout: SpaceLayout, step: number): SpaceLayout {
  const { station, network } = layout;
  if (!station.autoRoute || !station.stationLinks?.some(link => link.routeEndpoint === 'end')) return layout;
  const reversed: Station = { ...station, route: [...station.route].reverse(),
    autoRoute: { startTag: station.autoRoute.endTag, endTag: station.autoRoute.startTag },
    stationLinks: station.stationLinks.map(link => ({ ...link,
      routeEndpoint: link.routeEndpoint === 'start' ? 'end' : link.routeEndpoint === 'end' ? 'start' : undefined })) };
  const nextBoarding = (s: Station) => transfersAtStation(trip, s).find(t => t.boardingStep >= step)?.boardingStep ?? Infinity;
  if (nextBoarding(reversed) >= nextBoarding(station)) return layout;
  return { ...layout, station: reversed, network: network && { ...network, start: network.end, end: network.start } };
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

// GPS can reach the boarding leg before the traveller reaches its platform.
export function awaitingBoarding(current: JourneyProgress, boardingStep: number) {
  return current.step < boardingStep || (current.step === boardingStep && (current.stopIndex ?? -1) < 0);
}

export function upcomingIndoorTransfer(trip: Journey, current: JourneyProgress, station: Station, inTransferView = false) {
  if (station.stationLinks?.some(link => isStationPlace(trip.destination.name, link))) return;
  const transfer = transfersAtStation(trip, station).find(t => t.boardingStep >= current.step);
  if (!transfer) return;
  if (awaitingBoarding(current, transfer.boardingStep)) return transfer;
  // The saved AR screen can still be checking the screen door after arrival.
  if (inTransferView && current.stopIndex === 0 && stopName(current.station ?? '') === stopName(transfer.station)) return transfer;
}

export type BoardingTarget = { station?: string; line?: string; toward?: string };

export function boardingTarget(station: Station, trip: Journey | undefined, step: number, targetTag?: number): BoardingTarget {
  // The arrival callback may already have advanced progress to the boarding step.
  const transfer = trip && transfersAtStation(trip, station).find(t => t.boardingStep >= step);
  if (trip && transfer) {
    const stops = trip.steps[transfer.boardingStep].rail!.stops;
    const toward = stops.slice(1).map(s => s.name.trim()).find(name => name && stopName(name) !== stopName(transfer.station));
    return { station: transfer.station, line: transfer.toLine, toward };
  }
  const links = targetTag === undefined ? station.stationLinks ?? [] : tagLinks(station, targetTag);
  const endpoint = links.length === 1 ? links[0] : targetTag === undefined && links.find(l => l.routeEndpoint === 'end');
  return endpoint ? { station: endpoint.name, line: endpoint.line } : {};
}

export function progressAtIndoorArrival(trip: Journey, current: JourneyProgress, layout: SpaceLayout, time: number): JourneyProgress {
  if (current.tagTime !== undefined && time < current.tagTime) return current;
  const transfer = upcomingIndoorTransfer(trip, current, layout.station);
  if (!transfer) return current;
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
    if (!awaitingBoarding(current, transfer.boardingStep)) return current;
    const incoming = trip.steps[transfer.transferStep - 1];
    const hasWalk = transfer.transferStep < transfer.boardingStep;
    const step = Math.max(current.step, hasWalk ? transfer.transferStep : transfer.transferStep - 1);
    const stopIndex = step < transfer.transferStep ? incoming.rail!.stops.length - 1 : -1;
    if (current.step === step && current.station === transfer.station && current.stopIndex === stopIndex) return current;
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
