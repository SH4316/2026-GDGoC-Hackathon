import { copy, speechLocale, type Language } from '../i18n/language';
import { useLanguage } from '../i18n/LanguageSelect';
import { useEffect, useRef, useState } from 'react';
import type { IndoorCue } from './indoorGuidance';

const preference = 'station-indoor-voice-muted';
let current: SpeechSynthesisUtterance | undefined;

function muted() {
  try { return sessionStorage.getItem(preference) === 'yes'; } catch { return false; }
}

function stopVoice() {
  if (!current) return;
  current = undefined;
  window.speechSynthesis.cancel();
}

function speak(text: string, language: Language, failed?: () => void) {
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLocale(language);
  utterance.onend = () => { if (current === utterance) current = undefined; };
  utterance.onerror = event => {
    if (current !== utterance) return;
    current = undefined;
    if (event.error !== 'interrupted' && event.error !== 'canceled') failed?.();
  };
  current = utterance;
  try { window.speechSynthesis.speak(utterance); }
  catch { current = undefined; failed?.(); }
}

const supported = () => !!window.speechSynthesis && typeof SpeechSynthesisUtterance === 'function';

// Start the platform synthesizer inside the user's tap, before permission and route requests.
export function prepareIndoorVoice(message: string, language: Language) {
  if (supported() && !muted()) speak(copy[language](message), language);
}

export function IndoorVoice({ cue, hint }: { cue?: IndoorCue; hint?: string }) {
  const { language, t } = useLanguage();
  const [enabled, setEnabled] = useState(() => !muted());
  const [needsTap, setNeedsTap] = useState(false);
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) stopVoice(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopVoice();
      heard.current.clear();
    };
  }, [language]);

  const reportFailure = () => setNeedsTap(true);
  useEffect(() => {
    if (!cue || cue.language !== language || !enabled || needsTap || !supported() || document.hidden || heard.current.has(cue.key)) return;
    heard.current.add(cue.key);
    speak(cue.spokenText ?? cue.text, language, reportFailure);
  }, [cue, enabled, needsTap, language]);

  if (!supported()) return <button className="settings-trigger" type="button" disabled>{t('음성 안내 미지원')}</button>;
  const active = enabled && !needsTap;
  const currentCue = cue?.language === language ? cue : undefined;
  const instruction = currentCue?.spokenText ?? currentCue?.text ?? hint;
  function playInstruction(text: string) {
    if (currentCue) heard.current.add(currentCue.key);
    setNeedsTap(false);
    speak(text, language, reportFailure);
  }
  function toggle() {
    try { sessionStorage.setItem(preference, active ? 'yes' : 'no'); } catch { /* Some webviews disable storage. */ }
    setEnabled(!active);
    setNeedsTap(false);
    if (active) { stopVoice(); return; }
    playInstruction(instruction ?? t('음성 안내를 시작합니다. 태그를 비추세요.'));
  }
  return <div className="indoor-voice">
    {instruction && <button type="button" onClick={() => playInstruction(instruction)}>{t('안내 다시 듣기')}</button>}
    <button className="settings-trigger voice-toggle" type="button" aria-pressed={active} onClick={toggle}>
      {active ? t('음성 안내 끄기') : t('음성 안내 켜기')}
    </button>
  </div>;
}
