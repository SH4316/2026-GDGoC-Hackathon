// 음성 안내(말하기)와 음성 입력(듣기). 브라우저 내장 기능을 쓴다.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canListen = !!Recognition;
export const canSpeak = 'speechSynthesis' in window;

/**
 * 아이폰은 사용자의 터치 안에서 한 번 말을 시켜야 이후 자동 안내가 나온다.
 * 시작 버튼을 누를 때 호출한다.
 */
export function unlockSpeech() {
  if (!canSpeak) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (e) {
    /* 무시 */
  }
}

/** urgent면 하던 말을 끊고 바로 말한다 */
export function speak(text, lang, { urgent = false } = {}) {
  if (!canSpeak || !text) return;
  try {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 1.0;
    speechSynthesis.speak(u);
  } catch (e) {
    /* 무시 */
  }
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}

/**
 * 한 문장을 듣는다. 인식 후보 문장들의 배열을 돌려준다 (못 들으면 빈 배열).
 * 사용자의 터치 안에서 호출해야 한다.
 */
export function listenOnce(lang) {
  return new Promise((resolve) => {
    if (!Recognition) {
      resolve([]);
      return;
    }
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    let done = false;
    const finish = (list) => {
      if (done) return;
      done = true;
      resolve(list);
    };
    rec.onresult = (e) => {
      const list = [];
      for (const alt of e.results[0]) list.push(alt.transcript);
      finish(list);
    };
    rec.onerror = () => finish([]);
    rec.onend = () => finish([]);
    try {
      rec.start();
    } catch (e) {
      finish([]);
    }
    // 아무 말도 없으면 8초 뒤 끝낸다
    setTimeout(() => {
      try {
        rec.stop();
      } catch (e) {
        /* 무시 */
      }
    }, 8000);
  });
}
