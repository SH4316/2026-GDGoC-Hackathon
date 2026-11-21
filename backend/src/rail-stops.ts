import { readFileSync } from 'node:fs';
import type { RailStop } from './schema.js';

// The sign reader uses this same line and station-code pair to identify a stop.
const network: { lines: Record<string, [string, string][][]> } =
  JSON.parse(readFileSync(new URL('../signs/network.json', import.meta.url), 'utf8'));
const stopsByLine = new Map<string, Map<string, RailStop>>();
const connections = new Map<string, Map<string, Set<string>>>();
for (const [line, branches] of Object.entries(network.lines)) {
  const stops = new Map<string, RailStop>();
  const neighbors = new Map<string, Set<string>>();
  for (const branch of branches) {
    for (const [i, [code, name]] of branch.entries()) {
      stops.set(code, { line, code, name });
      if (!neighbors.has(code)) neighbors.set(code, new Set());
      if (i > 0) {
        const previous = branch[i - 1][0];
        neighbors.get(previous)!.add(code);
        neighbors.get(code)!.add(previous);
      }
    }
  }
  stopsByLine.set(line, stops);
  connections.set(line, neighbors);
}

export const railStops = Array.from(stopsByLine.values()).flatMap(stops => [...stops.values()]);
export function isKnownStop({ line, code, name }: RailStop) {
  return stopsByLine.get(line)?.get(code)?.name === name;
}

function reachableWithout(neighbors: Map<string, Set<string>>, start: string, blocked: string) {
  const seen = new Set([start]);
  for (const code of seen) {
    for (const next of neighbors.get(code)!)
      if (next !== blocked) seen.add(next);
  }
  return seen;
}

export function sameBoardingDirection(from: RailStop, planned: RailStop, shown: RailStop): boolean | undefined {
  if (from.line !== planned.line || from.line !== shown.line || from.code === planned.code || from.code === shown.code) return;
  if (planned.code === shown.code) return true;
  const neighbors = connections.get(from.line)!;
  const exits = neighbors.get(from.code)!;
  function departures(toward: string) {
    if (exits.has(toward)) return [toward];
    const reachable = reachableWithout(neighbors, toward, from.code);
    return [...exits].filter(code => reachable.has(code));
  }
  // A loop can reach a distant destination through either platform.
  const expected = departures(planned.code), observed = departures(shown.code);
  if (expected.length !== 1 || observed.length !== 1) return;
  if (expected[0] !== observed[0]) return false;
  // Services to different branches may share the first stop. Confirm only if
  // the sign's station is on the way to the planned stop, or vice versa.
  if (!reachableWithout(neighbors, from.code, planned.code).has(shown.code) ||
      !reachableWithout(neighbors, from.code, shown.code).has(planned.code)) return true;
}
