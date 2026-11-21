import names from './station-names.json' with { type: 'json' };
import type { Language } from './language.ts';

// Snapshot of backend/signs/network.json for the standalone frontend build.
const englishNames: Record<string, string> = names;

export function stationLabel(name: string, language: Language, bilingual = false) {
  if (language === 'ko') return name;
  const key = Object.hasOwn(englishNames, name) ? name : name.replace(/역$/, '');
  if (!Object.hasOwn(englishNames, key)) return name;
  return bilingual ? `${englishNames[key]} (${key})` : englishNames[key];
}
