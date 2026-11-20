import type { Station, StationLink } from '../ar/station';
import type { Journey, JourneyProgress } from './routes';

function tagLinks(station: Station, tagId: number): StationLink[] {
  const tag = station.tags.find(item => item.id === tagId);
  const links = station.stationLinks ?? [];
  if (!tag || links.length < 2) return tag ? links : [];
  const endpoints = links.filter(link => {
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

  // Include the previous leg's alighting stop, which opens the following (often transfer-walk) step.
  for (let i = Math.max(0, current.step - 1); i < trip.steps.length; i++) {
    const leg = trip.steps[i];
    const rail = leg.rail;
    if (!rail) continue;
    for (const [j, stop] of rail.stops.entries()) {
      const link = links.find(link => stopName(link.name) === stopName(stop.name) &&
        (!rail.lines.length || rail.lines.some(line => lineName(line) === lineName(link.line))));
      if (!link) continue;
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
