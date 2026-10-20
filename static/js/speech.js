// Read-aloud (題目朗讀) and voice input (語音提問) using the browser's own
// speech engines — Chrome (desktop/Android) and Safari support both.
import { toast } from './ui.js';

const CN = '零一二三四五六七八九';
const num = (n) => String(n);

// Turn our text markup into something a zh-TW voice reads naturally.
export function speakable(text) {
  let s = String(text ?? '');
  s = s.replace(/\{([^{}|]+)\|[^{}]+\}/g, '$1');                         // ruby: keep the characters
  s = s.replace(/(\d+)\s*\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, w, a, b) => `${w}又${b}分之${a}`);
  s = s.replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${b}分之${a}`);
  s = s.replace(/(\d+)\s*\/\s*(\d+)/g, (_, a, b) => `${b}分之${a}`);
  s = s.replace(/\\times|×/g, '乘以').replace(/\\div|÷/g, '除以').replace(/\\pi/g, '圓周率');
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '百分之$1').replace(/\^2/g, '的平方').replace(/\^3/g, '的立方');
  s = s.replace(/\\text\{([^{}]*)\}/g, '$1').replace(/\\[a-z]+/g, ' ').replace(/[${}*]/g, '');
  s = s.replace(/＿+|_{2,}/g, '空格').replace(/（\s*）|\(\s*\)/g, '括號');
  s = s.replace(/=/g, '等於').replace(/\+/g, '加').replace(/(\d)\s*-\s*(\d)/g, '$1減$2');
  s = s.replace(/[①②③④⑤⑥⑦⑧⑨]/g, (c) => `第${CN['①②③④⑤⑥⑦⑧⑨'.indexOf(c) + 1]}個，`);
  return s.replace(/\s+/g, ' ').trim() || num('');
}

let speaking = null;

export function canSpeak() { return 'speechSynthesis' in window; }

export function speak(text, btn) {
  if (!canSpeak()) { toast('這台裝置不支援朗讀'); return; }
  const synth = window.speechSynthesis;
  if (speaking) {
    synth.cancel();
    const was = speaking;
    speaking = null;
    if (was === btn) return; // second tap = stop
  }
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.lang = 'zh-TW';
  const voice = synth.getVoices().find((v) => /zh[-_]TW/i.test(v.lang)) || synth.getVoices().find((v) => /^zh/i.test(v.lang));
  if (voice) u.voice = voice;
  u.rate = 0.9;
  speaking = btn || true;
  btn && btn.classList.add('on');
  u.onend = u.onerror = () => { btn && btn.classList.remove('on'); if (speaking === (btn || true)) speaking = null; };
  synth.speak(u);
}

export function speakButton(id) {
  return canSpeak() ? `<button class="icon-btn speak" data-speak="${id}" aria-label="朗讀" title="朗讀">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg></button>` : '';
}

// Wire every [data-speak] button in root; texts maps id → text.
export function bindSpeak(root, texts) {
  root.querySelectorAll('[data-speak]').forEach((b) => b.onclick = () => speak(texts[b.dataset.speak] || '', b));
}

// Browsers only allow the microphone on https pages; on plain http the
// keyboard's own dictation key still works.
export function canListen() { return window.isSecureContext && !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

export function micButton(id) {
  return canListen() ? `<button class="icon-btn mic" data-mic="${id}" aria-label="用說的" title="用說的">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>` : '';
}

// Tap the mic, speak, and the words appear in the input.
export function bindMic(root, onText) {
  root.querySelectorAll('[data-mic]').forEach((b) => b.onclick = () => {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return;
    const input = root.querySelector(`#${b.dataset.mic}`);
    const rec = new R();
    rec.lang = 'zh-TW';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    b.classList.add('on');
    const before = input ? input.value : '';
    rec.onresult = (e) => {
      const t = [...e.results].map((r) => r[0].transcript).join('');
      if (input) input.value = (before ? before + ' ' : '') + t;
      if (e.results[e.results.length - 1].isFinal && onText) onText(input ? input.value : t);
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') toast('請允許瀏覽器使用麥克風'); };
    rec.onend = () => b.classList.remove('on');
    try { rec.start(); } catch { b.classList.remove('on'); }
  });
}
