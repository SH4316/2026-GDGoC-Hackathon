import { english } from './english.ts';

export type Language = 'ko' | 'en';
type Values = Record<string, string | number>;
export type Translate = (source: string, values?: Values) => string;

export const readLanguage = (search: string): Language => new URLSearchParams(search).get('lang') === 'en' ? 'en' : 'ko';
export const speechLocale = (lang: Language) => lang === 'en' ? 'en-US' : 'ko-KR';

function translator(language: Language): Translate {
  return (source, values) => {
    const text = language === 'en' && Object.hasOwn(english, source) ? english[source] : source;
    return values ? text.replace(/\{(\w+)\}/g, (key, name: string) => Object.hasOwn(values, name) ? String(values[name]) : key) : text;
  };
}
export const copy = { en: translator('en'), ko: translator('ko') };

export function uploadNotice(message: string, t: Translate) {
  return message.split(' · ').map(part => {
    const status = /^서버 응답 (\d+)$/.exec(part);
    return status ? t('서버 응답 {status}', { status: status[1] }) : t(part);
  }).join(' · ');
}

export function lineLabel(line: string, language: Language) {
  if (language === 'ko') return line;
  if (line === '서해선') return 'Seohae Line';
  const number = /^(?:수도권\s*)?(\d+)호선$/.exec(line);
  return number ? 'Line ' + number[1] : line;
}
