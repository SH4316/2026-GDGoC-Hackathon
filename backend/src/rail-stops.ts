import { readFileSync } from 'node:fs';
import type { RailStop } from './schema.js';

// The sign reader uses this same line and station-code pair to identify a stop.
const network: { lines: Record<string, [string, string][][]> } =
  JSON.parse(readFileSync(new URL('../signs/network.json', import.meta.url), 'utf8'));
const stopsByLine = new Map<string, Map<string, RailStop>>();
for (const [line, branches] of Object.entries(network.lines)) {
  const stops = new Map<string, RailStop>();
  for (const branch of branches) {
    for (const [code, name] of branch) stops.set(code, { line, code, name });
  }
  stopsByLine.set(line, stops);
}

export const railStops = Array.from(stopsByLine.values()).flatMap(stops => [...stops.values()]);
export function isKnownStop({ line, code, name }: RailStop) {
  return stopsByLine.get(line)?.get(code)?.name === name;
}
