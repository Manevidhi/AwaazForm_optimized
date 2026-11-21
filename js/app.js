import { t, getLang, setLang, applyStatic } from './i18n.js';
import {
  SAMPLE_FORMS, parseText, normalize, labelFor, displayValue, fieldPrefill,
  EXPIRY_MS, STORAGE_KEY, PREFS_KEY, buildFormUrl, cleanAnswer,
} from './data.js';
import { listen, stopListening, speak, speechInputSupported, speechOutputSupported } from './speech.js';
import { serverOnline, serverValidate, serverParseText, serverExtractText, serverParseUrl, serverTranslate } from './api.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const L = () => getLang();

// ---------- Hindi: questions shown in Hindi, answers saved in the form's language ----------
const HINDI_WORD_RE = /[\u0905-\u0939\u0958-\u095F]/;   // Hindi letters (digits alone need no translation)
const hiCache = new Map();

// Translates one piece of text to Hindi, once. Rejects if the server cannot translate it.
function toHindi(text) {
  if (!text || HINDI_WORD_RE.test(text)) return Promise.resolve(text);
  if (!hiCache.has(text)) {
    hiCache.set(text, serverTranslate(text, 'hi').then((out) => {
      if (!out) throw new Error('translation unavailable');
      return out;
    }).catch((err) => { hiCache.delete(text); throw err; }));
  }
  return hiCache.get(text);
}

// Adds Hindi labels, hints and options to the form, in place. The English text is kept,
// because the form and the saved answers always use the form's own language.
async function ensureHindi(form) {
  const jobs = [];
  for (const f of form.fields) {
    const label = f.label.en;
    if (label && (!f.label.hi || f.label.hi === label)) jobs.push(toHindi(label).then((v) => { f.label.hi = v; }));
    if (f.hint?.en && (!f.hint.hi || f.hint.hi === f.hint.en)) jobs.push(toHindi(f.hint.en).then((v) => { f.hint.hi = v; }));
    for (const o of f.options || []) {
      const eng = o.en || o.v;
      if (eng && (!o.hi || o.hi === eng)) jobs.push(toHindi(eng).then((v) => { o.hi = v; }));
    }
  }
  await Promise.all(jobs);
}

// Translates a Hindi answer into the form's language (English).
// Speech recognition and translation add marks that are not part of an answer: a full stop
// after a name or number, a bar ("|") or a Hindi sentence mark (।). They are removed before checking.
async function toEnglish(text) {
  const out = await serverTranslate(cleanAnswer(text), 'en');
  if (!out) throw new Error('translation unavailable');
  return cleanAnswer(out);
}

// Hands-free voice mode: the app reads each question, listens, reads the answer back and waits
// for yes or no. `voice.run` is a token: any manual action or "stop" changes it and ends the loop.
const voice = { on: false, offering: false, run: 0 };

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'correct', 'right', 'ok', 'okay', 'sure',
  'haan', 'han', 'ha', 'ji', 'sahi', 'theek', 'thik', 'हाँ', 'हां', 'हा', 'जी', 'सही', 'ठीक', 'ओके']);
const NO_WORDS = new Set(['no', 'nope', 'not', 'wrong', 'incorrect', 'change', 'edit',
  'nahi', 'nahin', 'na', 'galat', 'badlo', 'badlen', 'नहीं', 'नही', 'ना', 'गलत', 'बदलें', 'बदलो', 'बदल']);

// Words of a spoken reply: lower case, punctuation removed (Devanagari vowel signs are kept).
const wordsOf = (text) => String(text || '').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

// true = yes, false = no, null = not clear.
function yesNo(text) {
  const words = wordsOf(text);
  if (words.some((w) => NO_WORDS.has(w))) return false;
  if (words.some((w) => YES_WORDS.has(w))) return true;
  return null;
}

// Spoken commands while answering: 'stop', 'repeat', 'back', 'skip', or null for an answer.
function voiceCommand(text) {
  const w = wordsOf(text).join(' ');
  if (/\b(stop|pause|band karo)\b|रुको|बंद करो/.test(w)) return 'stop';
  if (/\b(repeat|again|say again|dobara)\b|दोहराओ|दोहराएँ|फिर से/.test(w)) return 'repeat';
  if (/\b(back|previous|go back)\b|पीछे/.test(w)) return 'back';
  if (/\b(skip|next question)\b|छोड़ो|छोड़ें/.test(w)) return 'skip';
  return null;
}

const state = {
  form: null,
  idx: 0,
  answers: {},
  pending: null,        // { value, raw } waiting for confirmation (FR4)
  autoRead: true,
  micOK: false,
  listening: false,
  saveOn: false,
  returnToReview: false,
  prefs: {},
};

// ---------- Small helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids.map((k) => (typeof k === 'string' ? document.createTextNode(k) : k)));
  return n;
}
const current = () => state.form.fields[state.idx];
const visibleScreen = () => document.querySelector('.screen:not([hidden])')?.id.replace('screen-', '');
const hasAnswer = (f) => state.answers[f.id] !== undefined && state.answers[f.id] !== '';

function show(name) {
  $('.navlinks').hidden = name !== 'start';
  $$('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  document.querySelector(`#screen-${name} h2`)?.focus();
  window.scrollTo({ top: 0 });
}

function owl(on) { $$('.owl').forEach((o) => o.classList.toggle('talking', on)); }
function owlHappy() {
  $$('.owl').forEach((o) => {
    o.classList.add('happy');
    setTimeout(() => o.classList.remove('happy'), 1100);
  });
}

let toastTimer;
function showToast(msg) {
  const x = $('#toast');
  x.textContent = msg;
  x.classList.add('show');
  $('#live').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => x.classList.remove('show'), 3800);
}

function speakText(text, lang = L()) {
  const ok = speak(text, lang, { onStart: () => owl(true), onEnd: () => owl(false) });
  if (!ok && lang === 'hi') showToast(t('noHindiVoice'));
}

function openDlg(id) {
  const d = document.getElementById(id);
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}

// ---------- Preferences ----------
function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { /* ignore */ }
  state.prefs = {
    lang: 'en',
    autoRead: true,
    contrast: window.matchMedia('(prefers-contrast: more)').matches,
    large: false,
    ...saved,
  };
  setLang(state.prefs.lang);
  state.autoRead = state.prefs.autoRead;
  document.body.classList.toggle('hc', !!state.prefs.contrast);
  document.documentElement.classList.toggle('large', !!state.prefs.large);
}

function savePrefs() {
  state.prefs.autoRead = state.autoRead;
  state.prefs.contrast = document.body.classList.contains('hc');
  state.prefs.large = document.documentElement.classList.contains('large');
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* ignore */ }
}

function updateToggles() {
  const set = (id, on) => $(id).setAttribute('aria-pressed', String(on));
  set('#btnAutoRead', state.autoRead);
  set('#btnContrast', document.body.classList.contains('hc'));
  set('#btnLarge', document.documentElement.classList.contains('large'));
  $$('[data-lang-btn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.langBtn === L())));
}

// ---------- Saved progress (F10) ----------
function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s) return null;
    if (Date.now() - s.savedAt > EXPIRY_MS) { clearSaved(); return null; }
    return s;
  } catch { return null; }
}
function persist() {
  if (!state.saveOn || !state.form) return;
  // Sensitive values are never kept, per data-minimisation rules.
  const answers = {};
  state.form.fields.forEach((f) => {
    if (f.type !== 'sensitive' && state.answers[f.id] !== undefined) answers[f.id] = state.answers[f.id];
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), form: state.form, answers, idx: state.idx }));
  } catch { /* storage full or blocked */ }
}
function clearSaved() { localStorage.removeItem(STORAGE_KEY); }
function renderResume() {
  $('#resumeBox').hidden = !loadSaved();
  renderStorage();
}

// Shows where saved progress lives and when it expires (storage section).
function renderStorage() {
  const s = loadSaved();
  const box = $('#storeStatus');
  if (!s) { box.textContent = t('storeStatusNone'); return; }
  const hours = Math.max(0, Math.round((EXPIRY_MS - (Date.now() - s.savedAt)) / 3600000));
  box.textContent = t('storeStatusHas', Object.keys(s.answers || {}).length, hours);
}

// ---------- Starting a form ----------
function startForm(form) {
  state.form = form;
  state.answers = {};
  state.idx = 0;
  state.pending = null;
  state.returnToReview = false;
  state.saveOn = $('#saveProgress').checked;
  $('#formTitle').textContent = form.title[L()] || form.title.en;
  show('flow');
  offerVoice();   // starts first, so the question is not read aloud twice
  askQuestion();
}

function onResume() {
  const s = loadSaved();
  if (!s) return renderResume();
  state.form = s.form;
  state.answers = s.answers || {};
  state.idx = Math.min(s.idx || 0, s.form.fields.length - 1);
  state.pending = null;
  state.returnToReview = false;
  state.saveOn = true;
  $('#saveProgress').checked = true;
  $('#formTitle').textContent = s.form.title[L()] || s.form.title.en;
  show('flow');
  offerVoice();
  askQuestion();
}

// ---------- Guided flow (FR1, FR2, FR3, FR7) ----------
// Google Forms only: show the real form inside the app, filled with the answers confirmed so far.
// It reloads only when those answers change. Nothing is submitted.
function renderFormPanel() {
  const panel = $('#formPanel');
  const built = state.form && state.form.sourceUrl ? buildFormUrl(state.form, state.answers, { embedded: true }) : null;
  panel.hidden = !built;
  if (!built) return;
  const frame = $('#formPreview');
  if (frame.dataset.url !== built.url) { frame.dataset.url = built.url; frame.src = built.url; }
}

let askToken = 0;
async function askQuestion(prefill) {
  const token = ++askToken;
  let hindiFailed = false;
  if (L() === 'hi' && state.form) {
    try { await ensureHindi(state.form); }
    catch { hindiFailed = true; showToast(t('hiUnavailable')); }
    if (token !== askToken) return;
  }
  const f = current();
  const n = state.form.fields.length;
  const lang = L();
  state.pending = null;
  renderFormPanel();
  $('#readback').hidden = true;
  $('#answerArea').hidden = false;

  $('#qCount').textContent = t('questionOf', state.idx + 1, n);
  $('#progressBar').setAttribute('aria-valuemax', String(n));
  $('#progressBar').setAttribute('aria-valuenow', String(state.idx));
  $('#progressFill').style.width = `${(state.idx / n) * 100}%`;
  renderDots();

  $('#qTitle').textContent = labelFor(f, lang);
  const badge = $('#qReq');
  badge.textContent = f.required ? t('required') : t('optional');
  badge.className = `badge ${f.required ? 'req' : 'opt'}`;
  $('#qHint').textContent = f.hint ? (f.hint[lang] || f.hint.en || '') : '';
  $('#flagNote').hidden = !f.flag;
  $('#flagNote').textContent = f.flag ? t('flagged') : '';
  $('#fieldError').textContent = hindiFailed ? t('hiUnavailable') : '';

  const value = prefill ?? fieldPrefill(f, state.answers[f.id]);
  const isSel = f.type === 'select';
  $('#selectField').hidden = !isSel;
  $('#textField').hidden = isSel;

  if (isSel) {
    renderOptions(f, lang);
    $('#answerSelect').value = value;
  } else {
    const inp = $('#answerInput');
    inp.value = value;
    inp.type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
    inp.inputMode = ['phone', 'pin', 'number', 'sensitive'].includes(f.type) ? 'numeric' : 'text';
    inp.placeholder = f.type === 'date' ? 'dd/mm/yyyy' : '';
  }

  if (state.autoRead && !voice.on && !voice.offering) readQuestion();
  $('#qTitle').focus();
}

function renderDots() {
  const box = $('#dots');
  box.replaceChildren(...state.form.fields.map((f, i) => {
    const cls = i < state.idx ? 'done' : i === state.idx ? 'current' : '';
    return el('span', { class: `dot ${cls} ${f.flag ? 'flag' : ''}` });
  }));
}

function renderOptions(f, lang) {
  const grid = $('#optionGrid');
  const sel = $('#answerSelect');
  sel.replaceChildren(el('option', { value: '' }, t('chooseOption')));
  grid.replaceChildren();
  f.options.forEach((o, i) => {
    const label = o[lang] || o.en || o.v;
    grid.append(el('button', { type: 'button', class: 'opt-card', 'data-v': o.v },
      el('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)), label));
    sel.append(el('option', { value: o.v }, label));
  });
}

// Position words for choices read aloud: "First option: …", "Second option: …".
const ORDINAL_SAY = {
  en: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'],
  hi: ['पहला', 'दूसरा', 'तीसरा', 'चौथा', 'पाँचवाँ', 'छठा', 'सातवाँ', 'आठवाँ', 'नौवाँ', 'दसवाँ'],
};
// Words a person may say to pick the choice in that position (lower case, as wordsOf returns them).
const ORDINAL_WORDS = [
  ['first', '1st', 'one', '1', 'pehla', 'pahla', 'पहला', 'पहले', 'एक'],
  ['second', '2nd', 'two', '2', 'doosra', 'dusra', 'दूसरा', 'दूसरे', 'दो'],
  ['third', '3rd', 'three', '3', 'teesra', 'तीसरा', 'तीसरे', 'तीन'],
  ['fourth', '4th', 'four', '4', 'chautha', 'चौथा', 'चौथे', 'चार'],
  ['fifth', '5th', 'five', '5', 'paanchwan', 'panchwan', 'पाँचवाँ', 'पांचवां', 'पाँच'],
  ['sixth', '6th', 'six', '6', 'chhatha', 'छठा', 'छठे', 'छह', 'छः'],
  ['seventh', '7th', 'seven', '7', 'satwan', 'सातवाँ', 'सातवां', 'सात'],
  ['eighth', '8th', 'eight', '8', 'aathwan', 'आठवाँ', 'आठवां', 'आठ'],
  ['ninth', '9th', 'nine', '9', 'nauwan', 'नौवाँ', 'नौवां', 'नौ'],
  ['tenth', '10th', 'ten', '10', 'dasvan', 'दसवाँ', 'दसवां', 'दस'],
];

function questionText(f) {
  const lang = L();
  let text = `${labelFor(f, lang)}.`;
  const hint = f.hint && (f.hint[lang] || f.hint.en);
  if (hint) text += ` ${hint}`;
  if (f.type === 'select') {
    const names = ORDINAL_SAY[lang] || ORDINAL_SAY.en;
    const list = f.options.map((o, i) =>
      `${names[i] || String(i + 1)} ${t('optionWord')}: ${o[lang] || o.en || o.v}.`);
    text += ` ${t('optionsSay')} ${list.join(' ')} ${t('sayOption')}`;
  }
  return text;
}

// The choice the person named: by its words, or by its position ("first", "2nd", "दूसरा").
// Returns { v, label } or null.
function pickOption(f, heard, lang) {
  // Devanagari digits to ASCII, so "२" works like "2".
  const digits = heard.replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)));
  const spoken = ` ${wordsOf(digits).join(' ')} `;
  for (const o of f.options) {
    const label = o[lang] || o.en || o.v;
    const words = wordsOf(label).join(' ');
    if (words && spoken.includes(` ${words} `)) return { v: o.v, label };
  }
  for (let i = 0; i < f.options.length && i < ORDINAL_WORDS.length; i++) {
    if (ORDINAL_WORDS[i].some((w) => spoken.includes(` ${w} `))) {
      const o = f.options[i];
      return { v: o.v, label: o[lang] || o.en || o.v };
    }
  }
  return null;
}

// Every answer, for reading aloud on the final preview (sensitive answers are not read out).
function readAllText() {
  const lang = L();
  return state.form.fields
    .filter((f) => hasAnswer(f) && f.type !== 'sensitive')
    .map((f) => `${labelFor(f, lang)}: ${displayValue(f, state.answers[f.id], lang)}.`)
    .join(' ');
}

function readQuestion() {
  speakText(questionText(current()), L());
}

// Checks an answer for the current question. Returns { res, text }; res.valid says whether it is accepted.
async function checkAnswer(f, raw) {
  const text = cleanAnswer(raw);
  const hindiWords = L() === 'hi' && f.type !== 'sensitive' && HINDI_WORD_RE.test(text);
  let res;
  try {
    if (hindiWords && f.type !== 'select') {
      res = normalize(f, await toEnglish(text));
    } else {
      // Server check is off by default (answers stay on the device); see SERVER_VALIDATION in api.js.
      res = (await serverValidate(f, text)) || normalize(f, text);
      if (!res.valid && hindiWords) res = normalize(f, await toEnglish(text));
    }
  } catch { res = { valid: false, err: 'hiUnavailable' }; }
  return { res, text };
}

async function submitRaw(raw) {
  const f = current();
  const { res, text } = await checkAnswer(f, raw);
  if (!res.valid) return fail(t(res.err));
  state.pending = { value: res.value, raw: text };
  showReadback();
}

function fail(msg) {
  $('#fieldError').textContent = msg;
  (current().type === 'select' ? $('#answerSelect') : $('#answerInput')).focus();
  $('#live').textContent = msg;
  speakText(msg);
}

// ---------- Read-back and confirmation (FR4) ----------
function showReadback() {
  const f = current();
  $('#answerArea').hidden = true;
  $('#readback').hidden = false;
  $('#rbValue').textContent = displayValue(f, state.pending.value, L()) || t('skipped');
  $('#rbQ').textContent = t('readbackQ');
  // Hindi answer: show what was said, and the value that is saved in the form's language.
  const said = state.pending.raw;
  const formValue = displayValue(f, state.pending.value, 'en');
  const differs = displayValue(f, state.pending.value, L()) !== formValue;
  const saidHindi = HINDI_WORD_RE.test(said) && f.type !== 'sensitive';
  $('#rbSaid').hidden = !saidHindi;
  $('#rbSaid').textContent = saidHindi ? `${t('youSaid')}: ${said}` : '';
  const showNote = f.type !== 'sensitive' && (saidHindi || differs) && !!state.pending.value;
  $('#rbNote').hidden = !showNote;
  $('#rbNote').textContent = showNote ? `${t('formLangNote')} ${formValue}` : '';
  $('#rbValue').focus();
  readbackSpeak();
}

function readbackSpeak() {
  if (voice.on) return;   // the voice loop reads the answer back itself
  const f = current();
  const shown = displayValue(f, state.pending?.value, L()) || t('skipped');
  speakText(`${t('youSaid')}: ${shown}. ${t('readbackQ')}`);
}

function confirmAnswer() {
  if (!state.pending) return;
  state.answers[current().id] = state.pending.value;
  state.pending = null;
  persist();
  owlHappy();
  state.idx++;
  if (state.returnToReview || state.idx >= state.form.fields.length) {
    state.returnToReview = false;
    state.idx = state.form.fields.length - 1;
    goReview();
    return null;
  }
  return askQuestion();
}

function editAnswer() {
  const raw = state.pending?.raw ?? '';
  state.pending = null;
  askQuestion(raw);
}

function goBack() {
  if (state.idx === 0) {
    // On the first question, Back returns to the screen the form came from.
    const pasted = state.form?.id === 'custom';
    show(pasted ? 'paste' : 'start');
    if (!pasted) renderResume();
    return;
  }
  state.idx--;
  askQuestion();
}

function repeat() {
  if (!$('#readback').hidden && state.pending) readbackSpeak();
  else readQuestion();
}

// ---------- Voice input (F3, FR5) ----------
function onMic() {
  if (state.listening) { stopListening(); return; }
  if (!speechInputSupported) return fail(t('noVoiceSupport'));
  if (!state.micOK) return openDlg('consentDlg');
  startMic();
}

function startMic() {
  window.speechSynthesis?.cancel();
  setMic(true);
  listen(L())
    .then(({ text, confidence }) => {
      setMic(false);
      if (confidence < 0.6) return fail(t('lowConfidence'));
      if (current().type !== 'select') $('#answerInput').value = text;
      submitRaw(text);
    })
    .catch((err) => {
      setMic(false);
      if (err.code === 'not-allowed') fail(t('micDenied'));
      else if (err.code === 'no-speech') fail(t('noSpeech'));
      else fail(t('noVoiceSupport'));
    });
}

function setMic(on) {
  state.listening = on;
  const b = $('#btnMic');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  $('#micLabel').textContent = on ? t('micStop') : t('mic');
  $('#waves').classList.toggle('on', on);
  $('#micStatus').textContent = on ? t('listening') : '';
}

// ---------- Keyboard shortcuts (spec section 9) ----------
function onKey(e) {
  if (document.querySelector('dialog[open]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName)) return;
  const inFlow = visibleScreen() === 'flow';
  if (inFlow && (voice.on || voice.offering) && ['Space', 'KeyR', 'KeyE', 'Enter'].includes(e.code)) stopVoice();
  const rb = !$('#readback').hidden;
  const key = e.key.toLowerCase();
  if (e.code === 'Space' && inFlow && !rb) { e.preventDefault(); onMic(); }
  else if (key === 'r' && inFlow) repeat();
  else if (e.key === 'Enter' && inFlow && rb) confirmAnswer();
  else if (key === 'e' && inFlow && rb) editAnswer();
}

// ---------- Hands-free voice mode ----------
function setVoiceStatus(text) {
  $('#voiceStatus').textContent = text;
}

function updateVoiceUI() {
  const on = voice.on || voice.offering;
  $('#btnVoice').setAttribute('aria-pressed', String(on));
  $('#btnVoice').textContent = on ? t('voiceToggleOn') : t('voiceToggleOff');
  setVoiceStatus(on ? t('voiceOnStatus') : t('voiceOffStatus'));
}

// Ends the voice mode at once: stops speaking and listening, and any loop still waiting exits.
function stopVoice() {
  voice.run++;
  voice.on = false;
  voice.offering = false;
  stopListening();
  window.speechSynthesis?.cancel?.();
  updateVoiceUI();
}

// Speaks a text and resolves when it has been spoken (or after a safe time limit).
function sayAndWait(text, lang = L()) {
  return new Promise((resolve) => {
    if (!speechOutputSupported) return resolve();
    const limit = setTimeout(resolve, Math.max(4000, text.length * 120));
    setVoiceStatus(t('voiceSpeaking'));
    speak(text, lang, { onEnd: () => { clearTimeout(limit); resolve(); } });
  });
}

// Listens for one spoken reply. Resolves with the text, or '' when nothing was heard in time.
async function listenFor(token, ms = 12000) {
  if (!speechInputSupported) return '';
  setVoiceStatus(t('voiceListening'));
  let timer;
  let blocked = false;
  try {
    const heard = await Promise.race([
      listen(L()).then((r) => r.text).catch((err) => {
        // No microphone or no permission: stop, rather than repeating "I did not hear" forever.
        if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(err?.code)) blocked = true;
        return '';
      }),
      new Promise((resolve) => { timer = setTimeout(() => { stopListening(); resolve(''); }, ms); }),
    ]);
    if (blocked && token === voice.run) { stopVoice(); showToast(t('micDenied')); return ''; }
    return token === voice.run ? heard : '';
  } finally {
    clearTimeout(timer);
  }
}

// At the start of a form: ask, by voice, whether to use hands-free mode. Yes or no is spoken.
async function offerVoice() {
  if (!speechInputSupported || !speechOutputSupported) return;
  const token = ++voice.run;
  voice.offering = true;
  updateVoiceUI();
  try {
    for (let tries = 0; tries < 2 && token === voice.run; tries++) {
      await sayAndWait(t('askVoice'));
      const answer = yesNo(await listenFor(token, 9000));
      if (token !== voice.run) return;
      if (answer === true) {
        voice.offering = false;
        state.micOK = true;   // a spoken yes is the consent to listen
        return runVoice(token);
      }
      if (answer === false) break;
    }
    if (token !== voice.run) return;
    voice.offering = false;
    updateVoiceUI();
    await sayAndWait(t('voiceOffSaid'));
    if (state.autoRead && visibleScreen() === 'flow') readQuestion();
  } finally {
    if (token === voice.run) { voice.offering = false; updateVoiceUI(); }
  }
}

// Started by the Hands-free button.
function startVoice() {
  if (!speechInputSupported || !speechOutputSupported) return;
  state.micOK = true;
  runVoice(++voice.run);
}

// The whole form, by voice: question, answer, read-back, yes or no, next question.
async function runVoice(token) {
  voice.on = true;
  updateVoiceUI();
  while (token === voice.run && visibleScreen() === 'flow') {
    await askQuestion();
    if (token !== voice.run) return;
    const f = current();
    await sayAndWait(questionText(f));
    if (token !== voice.run) return;

    const heard = await listenFor(token, 15000);
    if (token !== voice.run) return;
    if (!heard) { await sayAndWait(t('voiceNotHeard')); continue; }

    const command = voiceCommand(heard);
    if (command === 'stop') { stopVoice(); await sayAndWait(t('voiceStopped')); return; }
    if (command === 'repeat') continue;
    if (command === 'back') { if (state.idx > 0) state.idx--; continue; }
    if (command === 'skip') {
      if (f.required) { await sayAndWait(t('voiceRequired')); continue; }
      state.idx++;
      if (state.idx >= state.form.fields.length) { state.idx = state.form.fields.length - 1; goReview(); break; }
      continue;
    }

    // A choice is picked by name or position and selected at once: no yes or no for choices.
    if (f.type === 'select') {
      const picked = pickOption(f, heard, L());
      if (!picked) { await sayAndWait(t('voiceNotOption')); continue; }
      state.pending = { value: picked.v, raw: picked.label };
      await sayAndWait(`${t('voiceSelected')} ${picked.label}.`);
      if (token !== voice.run) return;
      await confirmAnswer();
      continue;
    }

    const { res, text } = await checkAnswer(f, heard);
    if (token !== voice.run) return;
    if (!res.valid) { await sayAndWait(`${t(res.err)} ${t('voiceTryAgain')}`); continue; }

    state.pending = { value: res.value, raw: text };
    showReadback();
    let decision = null;
    for (let tries = 0; tries < 3 && decision === null && token === voice.run; tries++) {
      const shown = displayValue(f, res.value, L()) || t('skipped');
      await sayAndWait(`${t('youSaid')}: ${shown}. ${t('readbackQ')} ${t('sayYesNo')}`);
      if (token !== voice.run) return;
      const reply = await listenFor(token, 10000);
      if (token !== voice.run) return;
      if (voiceCommand(reply) === 'repeat') continue;
      decision = yesNo(reply);
    }
    if (token !== voice.run) return;
    if (decision === true) {
      await confirmAnswer();
    } else {
      state.pending = null;
      await askQuestion(decision === false ? text : undefined);
    }
  }
  if (token !== voice.run) return;

  // All questions answered: ask whether to read all the answers aloud, then open the
  // completed form and ask the person to check it and submit it themselves.
  if (visibleScreen() === 'review') {
    let readAll = null;
    for (let tries = 0; tries < 2 && readAll === null && token === voice.run; tries++) {
      await sayAndWait(t('voiceReadAllPrompt'));
      readAll = yesNo(await listenFor(token, 12000));
      if (token !== voice.run) return;
    }
    if (readAll === null) {
      stopVoice();
      await sayAndWait(t('voiceStayReview'));
      return;
    }
    stopVoice();
    if (readAll) await sayAndWait(`${t('voiceReadAllIntro')} ${readAllText()}`);
    onFinish();
    await sayAndWait(t('voiceDone'));
  }
}

// ---------- Review (F8, FR8) ----------
function goReview() {
  renderReview();
  show('review');
  const missing = state.form.fields.filter((f) => f.required && !hasAnswer(f)).length;
  if (missing) $('#live').textContent = t('missingCount', missing);
}

function renderReview() {
  const f = state.form;
  const lang = L();
  const list = $('#reviewList');
  let missing = 0;
  let answered = 0;

  list.replaceChildren(...f.fields.map((fld, i) => {
    const has = hasAnswer(fld);
    if (has) answered++;
    else if (fld.required) missing++;
    const shown = has
      ? displayValue(fld, state.answers[fld.id], lang)
      : (fld.required ? t('missing') : t('skipped'));
    const name = labelFor(fld, lang);
    return el('li', { class: `review-item ${fld.required && !has ? 'bad' : ''}` },
      el('p', { class: 'rq' }, name),
      el('p', { class: 'rv' }, shown),
      el('button', { type: 'button', class: 'btn small', 'data-edit': String(i), 'aria-label': `${t('change')}: ${name}` }, `✏️ ${t('change')}`));
  }));

  $('#reviewSummary').textContent = t('answeredCount', answered, f.fields.length);
  $('#missingNote').textContent = missing ? t('missingCount', missing) : '';
  $('#btnFinish').disabled = missing > 0;
  buildPrintSheet();
}

function onReviewEdit(e) {
  const b = e.target.closest('[data-edit]');
  if (!b) return;
  state.idx = Number(b.dataset.edit);
  state.returnToReview = true;
  state.pending = null;
  show('flow');
  askQuestion();
}

// Google Forms only: the real form, with the confirmed answers filled in, shown inside the app.
// "Open in a new tab" is kept as a fallback. Nothing is submitted.
let fillUrl = null;
function renderFill() {
  const fill = state.form && state.form.sourceUrl ? buildFormUrl(state.form, state.answers, { embedded: true }) : null;
  fillUrl = fill ? buildFormUrl(state.form, state.answers).url : null;
  $('#btnOpenForm').hidden = !fill;
  $('#fillNote').hidden = !fill;
  $('#donePanel').hidden = !fill;
  // The usual line says "type these values yourself", which is wrong when we can fill the form.
  $('#screen-done [data-i18n="doneSub"]').textContent = t(fill ? 'doneSubFill' : 'doneSub');
  if (!fill) return;
  $('#fillNote').textContent = t('fillNote', fill.filled) + (fill.left ? ` ${t('fillLeft', fill.left)}` : '');
  const frame = $('#doneFrame');
  if (frame.dataset.url !== fill.url) { frame.dataset.url = fill.url; frame.src = fill.url; }
}
function openFilledForm() {
  if (fillUrl) window.open(fillUrl, '_blank', 'noopener,noreferrer');
}

function onFinish() {
  clearSaved();
  renderFill();
  show('done');
  confetti();
  owlHappy();
  $('#live').textContent = `${t('doneTitle')} ${t('doneSub')}`;
}

// ---------- Export: PDF via print dialog, copy (F8) ----------
function buildPrintSheet() {
  const f = state.form;
  const lang = L();
  const sheet = $('#printSheet');
  sheet.lang = lang;
  const date = new Date().toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN');
  sheet.replaceChildren(
    el('h1', {}, f.title[lang] || f.title.en),
    el('p', {}, `${t('pdfHeading')} · ${t('printedOn')}: ${date}`),
    el('dl', {}, ...f.fields.flatMap((fld) => [
      el('dt', {}, labelFor(fld, lang)),
      el('dd', {}, displayValue(fld, state.answers[fld.id], lang) || '-'),
    ])),
  );
}

function exportPdf() {
  buildPrintSheet();
  const old = document.title;
  document.title = `AwaazForm - ${state.form.title[L()] || state.form.title.en}`;
  window.print();
  setTimeout(() => { document.title = old; }, 800);
}

async function copyAnswers() {
  const lang = L();
  const text = state.form.fields
    .map((f) => `${labelFor(f, lang)}: ${displayValue(f, state.answers[f.id], lang) || '-'}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('copied'));
  } catch {
    showToast(t('copyFail'));
  }
}

// ---------- Paste a form link (the server reads its questions) ----------
const LINK_ERRORS = {
  blocked: 'linkBlocked',
  needs_signin: 'linkNeedsSignin',
  no_questions: 'linkNoQuestions',
  not_html: 'linkNoQuestions',
  too_large: 'linkNoQuestions',
  fetch_failed: 'linkFetchFailed',
};

// Works for Google Forms and ordinary public HTML forms. The questions then run through the
// same guided flow as pasted text: every answer is checked, read back, and saved only after
// the user confirms it. Google Forms gets a pre-filled link on the last screen.
async function onLinkSubmit(e) {
  e.preventDefault();
  const msg = $('#linkMsg');
  const raw = $('#formLink').value.trim();
  let url = null;
  try { url = new URL(raw); } catch { /* not a link */ }
  if (!url) { msg.textContent = t('linkInvalid'); return; }
  if (url.protocol !== 'https:') { msg.textContent = t('linkHttps'); return; }

  msg.textContent = t('linkReading');
  const r = await serverParseUrl(url.href);
  if (r.offline) { msg.textContent = t('linkOffline'); return; }
  if (!r.ok) { msg.textContent = `${t(LINK_ERRORS[r.code] || 'linkFetchFailed')} ${t('linkFallback')}`; return; }

  msg.textContent = t('linkFound', r.fields.length);
  startForm({ id: 'link', title: r.title, fields: r.fields, sourceUrl: r.sourceUrl });
  if (r.flagged) showToast(t('flagCount', r.flagged));
}

// ---------- Paste & upload (F1) ----------
async function onPasteSubmit(e) {
  e.preventDefault();
  const text = $('#pasteText').value;
  // Only the question text goes to the server, never answers. Falls back to the on-device parser.
  const fields = (await serverParseText(text)) || parseText(text);
  if (!fields.length) {
    $('#pasteErr').textContent = t('noQuestions');
    return;
  }
  $('#pasteErr').textContent = '';
  const flagged = fields.filter((f) => f.flag).length;
  startForm({ id: 'custom', title: { en: 'My form', hi: 'मेरा फॉर्म' }, fields });
  if (flagged) showToast(t('flagCount', flagged));
}

function loadPdfLib() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = el('script', { src: `${PDFJS}/pdf.min.js` });
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      resolve();
    };
    s.onerror = () => reject(new Error(t('noPdfLib')));
    document.head.append(s);
  });
}

async function pdfToText(file) {
  await loadPdfLib();
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > 20) throw new Error(t('pdfPages'));
  let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return out;
}

async function onFile(e) {
  const file = e.target.files[0];
  const msg = $('#uploadMsg');
  if (!file) return;
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['txt', 'pdf'].includes(ext)) throw new Error(t('fileType'));
    if (file.size > 5 * 1024 * 1024) throw new Error(t('fileBig'));
    let text;
    if (ext === 'pdf') {
      const head = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
      if (head !== '%PDF-') throw new Error(t('fileType'));
      text = (await serverExtractText(file)) || (await pdfToText(file));
    } else {
      text = await file.text();
    }
    if (!text.trim()) throw new Error(t('pdfNoText'));
    $('#pasteText').value = text.trim();
    msg.textContent = t('fileLoaded');
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ---------- Confetti (celebration, skipped for reduced motion) ----------
function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti');
  const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff'];
  box.replaceChildren(...Array.from({ length: 60 }, (_, i) => {
    const s = el('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.6}s`;
    s.style.setProperty('--drift', `${Math.random() * 200 - 100}px`);
    return s;
  }));
  setTimeout(() => box.replaceChildren(), 3600);
}

// ---------- Language switch without losing answers (FR9) ----------
async function switchLang(code) {
  const f = state.form && current();
  const typed = f && f.type === 'select' ? $('#answerSelect').value : $('#answerInput').value;
  if (code === 'hi' && state.form) {
    try { await ensureHindi(state.form); } catch { /* shown below */ }
  }
  setLang(code);
  state.prefs.lang = code;
  savePrefs();
  applyStatic();
  updateToggles();
  if (state.form) $('#formTitle').textContent = state.form.title[code] || state.form.title.en;

  const s = visibleScreen();
  if (s === 'flow') {
    if (!$('#readback').hidden && state.pending) showReadback();
    else askQuestion(typed);
  } else if (s === 'review') {
    renderReview();
  } else if (s === 'done') {
    renderFill();
  } else if (s === 'start') {
    renderResume();
  }
}

// ---------- Keyboard: dialogs ----------
function bind() {
  $$('[data-lang-btn]').forEach((b) => b.addEventListener('click', () => switchLang(b.dataset.langBtn)));
  $$('[data-sample]').forEach((b) => b.addEventListener('click', () => startForm(structuredClone(SAMPLE_FORMS[b.dataset.sample]))));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
    show(b.dataset.go);
    if (b.dataset.go === 'start') renderResume();
  }));

  $('#btnAutoRead').addEventListener('click', () => { state.autoRead = !state.autoRead; savePrefs(); updateToggles(); });
  $('#btnContrast').addEventListener('click', () => { document.body.classList.toggle('hc'); savePrefs(); updateToggles(); });
  $('#btnLarge').addEventListener('click', () => { document.documentElement.classList.toggle('large'); savePrefs(); updateToggles(); });
  $('#btnHelp').addEventListener('click', () => openDlg('helpDlg'));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#consentAgree').addEventListener('click', () => {
    state.micOK = true;
    $('#consentDlg').close();
    startMic();
  });

  $('#linkForm').addEventListener('submit', onLinkSubmit);
  $('#btnStoreDelete').addEventListener('click', () => { clearSaved(); renderResume(); showToast(t('deleted')); });
  $('#saveProgress').addEventListener('change', (e) => {
    if (!e.target.checked) { clearSaved(); renderResume(); }
  });
  $('#btnResume').addEventListener('click', onResume);
  $('#btnDeleteSaved').addEventListener('click', () => { clearSaved(); renderResume(); showToast(t('deleted')); });

  $('#pasteForm').addEventListener('submit', onPasteSubmit);
  $('#fileInput').addEventListener('change', onFile);

  $('#btnMic').addEventListener('click', onMic);
  $('#btnListenQ').addEventListener('click', readQuestion);
  $('#btnVoice').addEventListener('click', () => {
    if (voice.on || voice.offering) stopVoice();
    else startVoice();
  });
  // Any answer control used by hand takes over from the voice mode.
  $('#screen-flow').addEventListener('click', (e) => {
    if ((voice.on || voice.offering) && e.target.closest('#btnConfirm, #btnEdit, #btnBack, #btnMic, #btnRepeat, #btnListenQ, #optionGrid')) stopVoice();
  }, true);
  $('#answerInput').addEventListener('keydown', (e) => {
    if ((voice.on || voice.offering) && e.key === 'Enter') stopVoice();
  });
  $('#answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = current();
    submitRaw(f.type === 'select' ? $('#answerSelect').value : $('#answerInput').value);
  });
  $('#optionGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.opt-card');
    if (b) submitRaw(b.dataset.v);
  });
  $('#btnBack').addEventListener('click', goBack);
  $('#btnConfirm').addEventListener('click', confirmAnswer);
  $('#btnEdit').addEventListener('click', editAnswer);
  $('#btnRepeat').addEventListener('click', repeat);

  $('#reviewList').addEventListener('click', onReviewEdit);
  $('#btnReviewBack').addEventListener('click', () => {
    state.idx = state.form.fields.length - 1;
    state.returnToReview = true;
    state.pending = null;
    show('flow');
    askQuestion();
  });
  $('#btnFinish').addEventListener('click', onFinish);

  $('#btnOpenForm').addEventListener('click', openFilledForm);
  $('#btnPdf').addEventListener('click', exportPdf);
  $('#btnCopy').addEventListener('click', copyAnswers);
  $('#btnNew').addEventListener('click', () => { show('start'); renderResume(); });

  document.addEventListener('keydown', onKey);
}

function init() {
  loadPrefs();
  applyStatic();
  updateToggles();
  updateVoiceUI();
  renderResume();
  bind();
  // Let the user know when the optional server is connected. Silent if it is off.
  serverOnline().then((on) => { if (on) showToast(t('serverOn')); });
}

init();
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/service-worker.js")
            .then(() => console.log("AwaazForm PWA registered"))
            .catch(error => console.error("PWA registration failed:", error));
    });
}