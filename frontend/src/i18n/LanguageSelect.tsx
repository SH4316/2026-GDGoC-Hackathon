import { useEffect, useSyncExternalStore } from 'react';
import { subscribeUrl, updateUrl } from '../urlState';
import { copy, readLanguage, speechLocale } from './language';
import './language.css';

const currentLanguage = () => readLanguage(location.search);
export function useLanguage() {
  const language = useSyncExternalStore(subscribeUrl, currentLanguage);
  return { language, locale: speechLocale(language), t: copy[language] };
}

export function useDocumentLanguage(title: string) {
  const { language, t } = useLanguage();
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t(title);
  }, [language, t, title]);
}

export function LanguageSelect() {
  const { language, t } = useLanguage();
  return <label className="language-select">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>
    </svg>
    <select aria-label={t('언어 설정')} value={language} onChange={event => updateUrl({ lang: event.target.value })}>
      <option lang="ko" value="ko">한국어</option>
      <option lang="en" value="en">English</option>
    </select>
  </label>;
}
