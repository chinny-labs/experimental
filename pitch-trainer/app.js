'use strict';

// ---------- Music data ----------

const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const PC_FULL = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
// Computer-keyboard piano layout (home row = white keys, row above = black keys).
const PIANO_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11 };
const INT_HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

const INTERVALS = {
  1: { short: 'm2', name: 'Minor 2nd', song: 'Jaws' },
  2: { short: 'M2', name: 'Major 2nd', song: 'Happy Birthday' },
  3: { short: 'm3', name: 'Minor 3rd', song: 'Greensleeves' },
  4: { short: 'M3', name: 'Major 3rd', song: 'When the Saints' },
  5: { short: 'P4', name: 'Perfect 4th', song: 'Here Comes the Bride' },
  6: { short: 'TT', name: 'Tritone', song: 'The Simpsons' },
  7: { short: 'P5', name: 'Perfect 5th', song: 'Twinkle Twinkle' },
  8: { short: 'm6', name: 'Minor 6th', song: 'The Entertainer' },
  9: { short: 'M6', name: 'Major 6th', song: 'My Bonnie' },
  10: { short: 'm7', name: 'Minor 7th', song: 'Somewhere (West Side Story)' },
  11: { short: 'M7', name: 'Major 7th', song: 'Take On Me' },
  12: { short: 'P8', name: 'Octave', song: 'Somewhere Over the Rainbow' },
};

// Order in which items are introduced by the level system. Early items are
// far apart in sound so they're easy to tell apart; close neighbours come later.
const MODES = {
  pp: {
    order: [0, 7, 4, 9, 2, 5, 11, 6, 10, 3, 1, 8],
    startCount: 3,
    label: (pc) => PC_NAMES[pc],
    fullLabel: (pc) => PC_FULL[pc],
    blurb: 'Hear a single note and name it, with no reference note. Start with a few notes that sound very different and add more as you improve.',
  },
  int: {
    order: [4, 7, 12, 5, 3, 2, 9, 1, 8, 10, 11, 6],
    startCount: 3,
    label: (s) => INTERVALS[s].short,
    fullLabel: (s) => INTERVALS[s].name,
    blurb: 'Hear two notes and name the distance between them. This is relative pitch, the skill behind playing by ear and transcribing.',
  },
};
for (const m of Object.values(MODES)) m.maxLevel = m.order.length - m.startCount + 1;

const WINDOW = 20; // answers considered for levelling up
const NEEDED = 16; // correct answers in the window to level up (80%)

// ---------- Persistent state ----------

const STORE_KEY = 'pitch-trainer-v1';

function defaultState() {
  return {
    mode: 'pp',
    autoNext: true,
    volume: 0.7,
    pp: { style: 'levels', level: 1, maxLevel: 1, recent: [], custom: [0, 4, 7], range: 'narrow', mask: true, labels: true },
    int: { style: 'levels', level: 1, maxLevel: 1, recent: [], custom: [4, 7, 12], direction: 'asc', songs: true },
    stats: { pp: {}, int: {} },
  };
}

function loadState() {
  const base = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') {
      return {
        ...base,
        ...saved,
        pp: { ...base.pp, ...saved.pp },
        int: { ...base.int, ...saved.int },
        stats: { ...base.stats, ...saved.stats },
      };
    }
  } catch (_) { /* storage unavailable or corrupt: start fresh */ }
  return base;
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
}

const state = loadState();
const sessions = { pp: { asked: 0, correct: 0, streak: 0 }, int: { asked: 0, correct: 0, streak: 0 } };
let question = null; // { mode, item, notes, kind, answered, given }
let recentItems = [];
let autoTimer = null;

const cfg = () => state[state.mode];
const mode = () => MODES[state.mode];

function activeItems(modeKey = state.mode) {
  const c = state[modeKey];
  const m = MODES[modeKey];
  if (c.style === 'custom') return m.order.filter((i) => c.custom.includes(i));
  return m.order.slice(0, m.startCount - 1 + c.level);
}

function newestItem() {
  const c = cfg();
  if (c.style !== 'levels' || c.level === 1) return null;
  return mode().order[mode().startCount - 2 + c.level];
}

// ---------- Audio ----------

const Sound = (() => {
  let ctx = null;
  let master = null;
  let wave = null;
  let live = [];

  function init() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = state.volume;
      master.connect(comp);
      comp.connect(ctx.destination);
      // Harmonic recipe for a soft, piano-like tone.
      const h = [0, 1, 0.45, 0.25, 0.14, 0.09, 0.05, 0.035, 0.02, 0.012];
      wave = ctx.createPeriodicWave(new Float32Array(h.length), Float32Array.from(h));
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function note(midi, when, dur, vel) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = f;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(f * 10, 14000), when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2.5, 500), when + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vel, when + 0.008);
    g.gain.exponentialRampToValueAtTime(vel * 0.4, when + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(when);
    osc.stop(when + dur + 0.05);

    const voice = { osc, g };
    live.push(voice);
    osc.onended = () => {
      live = live.filter((v) => v !== voice);
      g.disconnect();
    };
  }

  function stop() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const { osc, g } of live) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      try { osc.stop(t + 0.06); } catch (_) { /* already stopped */ }
    }
    live = [];
  }

  // events: [{ midi, at (seconds from now), dur, vel }]
  function play(events) {
    init();
    stop();
    const t0 = ctx.currentTime + 0.06;
    for (const e of events) note(e.midi, t0 + e.at, e.dur ?? 1.5, e.vel ?? 0.5);
  }

  function setVolume(v) {
    if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  }

  return { play, stop, setVolume, init };
})();

const noteName = (midi) => PC_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// A fast run of random notes that wipes out the memory of the previous pitch.
function maskEvents() {
  const ev = [];
  for (let i = 0; i < 6; i++) ev.push({ midi: randInt(45, 86), at: i * 0.075, dur: 0.22, vel: 0.22 });
  return ev;
}

function intervalEvents(notes, kind, offset = 0) {
  if (kind === 'harm') return notes.map((midi) => ({ midi, at: offset, dur: 1.8, vel: 0.4 }));
  return [
    { midi: notes[0], at: offset, dur: 1.1 },
    { midi: notes[1], at: offset + 0.75, dur: 1.5 },
  ];
}

function playQuestion(withMask) {
  if (!question) return;
  if (question.mode === 'pp') {
    const lead = withMask ? 0.95 : 0;
    Sound.play([...(withMask ? maskEvents() : []), { midi: question.notes[0], at: lead, dur: 1.8, vel: 0.55 }]);
  } else {
    Sound.play(intervalEvents(question.notes, question.kind));
  }
}

// Plays an answer option, used for exploring and for comparing after a miss.
function playItem(item) {
  if (state.mode === 'pp') {
    let midi = 60 + item;
    if (question && question.mode === 'pp' && question.answered) {
      midi = question.notes[0] - question.item + item; // same octave as the question
    }
    Sound.play([{ midi, at: 0, dur: 1.6, vel: 0.55 }]);
  } else {
    let root = 60;
    let kind = cfg().direction === 'harm' ? 'harm' : cfg().direction === 'desc' ? 'desc' : 'asc';
    if (question && question.mode === 'int' && question.answered) {
      root = Math.min(...question.notes);
      kind = question.kind;
    }
    Sound.play(intervalEvents(intervalNotes(root, item, kind), kind));
  }
}

function intervalNotes(low, semis, kind) {
  const high = low + semis;
  return kind === 'desc' ? [high, low] : [low, high];
}

// ---------- Question flow ----------

function accuracy(modeKey, item) {
  const s = state.stats[modeKey][item];
  return s && s.n ? (s.ok + 1) / (s.n + 2) : 0.5;
}

function pickItem() {
  const items = activeItems();
  const newest = newestItem();
  const last2 = recentItems.slice(-2);
  const blocked = last2.length === 2 && last2[0] === last2[1] ? last2[0] : null;
  const pool = items.filter((i) => i !== blocked);
  const weights = pool.map((i) => {
    let w = 0.6 + (1 - accuracy(state.mode, i)) * 2; // weaker items come up more
    if (i === newest) w *= 1.6;
    return w;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) {
    r -= weights[k];
    if (r <= 0) return pool[k];
  }
  return pool[pool.length - 1];
}

function newQuestion() {
  clearTimeout(autoTimer);
  const item = pickItem();
  recentItems = [...recentItems.slice(-5), item];
  if (state.mode === 'pp') {
    const octaves = cfg().range === 'wide' ? [48, 60, 72] : [60];
    const base = octaves[randInt(0, octaves.length - 1)];
    question = { mode: 'pp', item, notes: [base + item], answered: false };
  } else {
    let kind = cfg().direction;
    if (kind === 'mixed') kind = ['asc', 'desc', 'harm'][randInt(0, 2)];
    const low = randInt(53, 67);
    question = { mode: 'int', item, kind, notes: intervalNotes(low, item, kind), answered: false };
  }
  renderQuiz();
  playQuestion(state.mode === 'pp' && cfg().mask);
}

function answer(item) {
  if (!question || question.answered) {
    playItem(item);
    return;
  }
  if (!activeItems().includes(item)) return;
  clearTimeout(autoTimer);
  question.answered = true;
  question.given = item;
  const ok = item === question.item;

  const session = sessions[state.mode];
  session.asked++;
  if (ok) { session.correct++; session.streak++; } else { session.streak = 0; }

  const s = (state.stats[state.mode][question.item] ||= { n: 0, ok: 0, conf: {} });
  s.n++;
  if (ok) s.ok++;
  else s.conf[item] = (s.conf[item] || 0) + 1;

  if (ok) {
    if (question.mode === 'pp') Sound.play([{ midi: question.notes[0], at: 0, dur: 1.2, vel: 0.45 }]);
  } else {
    // Play the right answer again so the miss is immediately corrected by ear.
    playQuestion(false);
  }

  if (cfg().style === 'levels') trackLevel(ok);
  saveState();
  renderQuiz();
  renderSetup();
  renderStats();

  if (ok && state.autoNext) autoTimer = setTimeout(newQuestion, 1100);
}

function trackLevel(ok) {
  const c = cfg();
  const m = mode();
  c.recent = [...c.recent, ok].slice(-WINDOW);
  const correct = c.recent.filter(Boolean).length;
  if (correct < NEEDED) return;
  if (c.level < m.maxLevel) {
    c.level++;
    c.maxLevel = Math.max(c.maxLevel, c.level);
    c.recent = [];
    const added = m.order[m.startCount - 2 + c.level];
    toast(`Level ${c.level}! New: ${m.fullLabel(added)}`);
  } else if (c.recent.length === WINDOW && !c.mastered) {
    c.mastered = true;
    toast(state.mode === 'pp' ? 'All 12 notes mastered!' : 'All 12 intervals mastered!');
  }
}

function clearQuestion() {
  question = null;
  clearTimeout(autoTimer);
  Sound.stop();
}

function setLevel(level) {
  const c = cfg();
  c.level = Math.max(1, Math.min(level, c.maxLevel));
  c.recent = [];
  clearQuestion();
  saveState();
  renderAll();
}

// ---------- Rendering ----------

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

function renderAll() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)));
  $('#blurb').textContent = mode().blurb;
  document.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== state.mode; });
  renderSetup();
  renderQuiz();
  renderStats();
  syncSettings();
}

function renderSetup() {
  const c = cfg();
  const m = mode();
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.style === c.style)));
  const levels = c.style === 'levels';
  $('#levels-panel').hidden = !levels;
  $('#custom-panel').hidden = levels;

  const chips = $('#chips');
  chips.replaceChildren();
  if (levels) {
    $('#lvl-label').textContent = `Level ${c.level}`;
    $('#lvl-of').textContent = `of ${m.maxLevel}`;
    $('#lvl-down').disabled = c.level <= 1;
    $('#lvl-up').disabled = c.level >= c.maxLevel;
    const correct = c.recent.filter(Boolean).length;
    $('#lvl-bar').style.width = `${Math.min(100, (correct / NEEDED) * 100)}%`;
    $('#lvl-hint').textContent = c.level < m.maxLevel
      ? `${correct} of your last ${WINDOW} right. Get ${NEEDED} to unlock level ${c.level + 1}.`
      : `Final level. ${correct} of your last ${WINDOW} right.`;
    const newest = newestItem();
    for (const item of activeItems()) {
      chips.append(el('button', {
        class: `chip on${item === newest ? ' new' : ''}`,
        title: `Hear ${m.fullLabel(item)}`,
        onclick: () => playItem(item),
      }, m.label(item)));
    }
  } else {
    for (const item of m.order.slice().sort((a, b) => a - b)) {
      const on = c.custom.includes(item);
      chips.append(el('button', {
        class: `chip${on ? ' on' : ''}`,
        'aria-pressed': String(on),
        onclick: () => toggleCustom(item),
      }, m.label(item)));
    }
  }
}

function toggleCustom(item) {
  const c = cfg();
  if (c.custom.includes(item)) {
    if (c.custom.length <= 2) { toast('Keep at least two'); return; }
    c.custom = c.custom.filter((i) => i !== item);
  } else {
    c.custom = [...c.custom, item];
  }
  clearQuestion();
  saveState();
  renderSetup();
  renderQuiz();
}

function renderQuiz() {
  const m = mode();
  const q = question && question.mode === state.mode ? question : null;
  const session = sessions[state.mode];

  $('#session').textContent = `Session ${session.correct} / ${session.asked}`;
  $('#streak').textContent = session.streak >= 3 ? `🔥 ${session.streak} in a row` : '';

  const icon = $('#play-icon');
  const label = $('#play-label');
  if (!q) { icon.textContent = '▶'; label.textContent = 'Start'; }
  else if (!q.answered) { icon.textContent = '↻'; label.textContent = 'Replay'; }
  else { icon.textContent = '→'; label.textContent = 'Next'; }
  $('#replay').hidden = !(q && q.answered);

  const prompt = $('#prompt');
  if (!q) prompt.textContent = state.mode === 'pp' ? 'Press Start, then name the note you hear.' : 'Press Start, then name the interval you hear.';
  else if (!q.answered) prompt.textContent = state.mode === 'pp' ? 'Which note was that?' : `Which interval? (${{ asc: 'ascending', desc: 'descending', harm: 'played together' }[q.kind]})`;
  else prompt.textContent = 'Tap any answer to hear it and compare.';

  const fb = $('#feedback');
  fb.replaceChildren();
  if (q && q.answered) {
    const ok = q.given === q.item;
    if (ok) {
      fb.append(el('div', { class: 'verdict good' }, `✓ ${m.fullLabel(q.item)}`));
    } else {
      fb.append(
        el('div', { class: 'verdict bad' }, `✗ It was ${m.fullLabel(q.item)}`),
        el('div', { class: 'muted small' }, `You answered ${m.fullLabel(q.given)}`),
        el('div', { class: 'compare' },
          el('button', { onclick: () => playItem(q.item) }, `▶ ${m.label(q.item)} (correct)`),
          el('button', { onclick: () => playItem(q.given) }, `▶ ${m.label(q.given)} (yours)`),
        ),
      );
    }
  }

  const area = $('#answer-area');
  area.replaceChildren(state.mode === 'pp' ? buildAnswerPiano(q) : buildIntervalGrid(q));

  const disp = $('#display-piano');
  if (state.mode === 'int') {
    disp.hidden = false;
    disp.replaceChildren(...buildDisplayPiano(q));
  } else {
    disp.hidden = true;
  }

  const hint = $('#kbd-hint');
  hint.innerHTML = state.mode === 'pp'
    ? '<kbd>Space</kbd> start / replay · <kbd>Enter</kbd> next · keys <kbd>A</kbd>–<kbd>J</kbd> play as a piano (<kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> are the black keys)'
    : '<kbd>Space</kbd> start / replay · <kbd>Enter</kbd> next · number keys pick an answer';
}

// Builds piano keys spanning [start, start + count). Returns the container.
function buildPiano(start, count, decorate) {
  const piano = el('div', { class: 'piano' });
  const whites = [];
  for (let midi = start; midi < start + count; midi++) if (!BLACK_PCS.has(midi % 12)) whites.push(midi);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let midi = start; midi < start + count; midi++) {
    const pc = midi % 12;
    const black = BLACK_PCS.has(pc);
    const key = el('button', { class: `key ${black ? 'black' : 'white'}`, type: 'button' });
    if (black) {
      key.style.left = `calc(${wi * ww}% - ${ww * 0.3}%)`;
      key.style.width = `${ww * 0.6}%`;
    } else {
      wi++;
    }
    decorate(key, midi, pc);
    piano.append(key);
  }
  return piano;
}

function buildAnswerPiano(q) {
  const active = activeItems();
  const piano = buildPiano(60, 12, (key, midi, pc) => {
    const on = active.includes(pc);
    key.textContent = PC_NAMES[pc];
    key.dataset.pc = pc;
    key.setAttribute('aria-label', PC_FULL[pc]);
    if (!on) key.classList.add('off');
    if (q && q.answered) {
      if (pc === q.item) key.classList.add('good');
      else if (pc === q.given) key.classList.add('bad');
    }
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!on && q && !q.answered) return;
      flashKey(key);
      answer(pc);
    });
    key.addEventListener('click', (e) => {
      // Keyboard activation (Enter/Space on a focused key) has no pointerdown.
      if (e.detail === 0) answer(pc);
    });
  });
  if (!cfg().labels) piano.classList.add('nolabels');
  return piano;
}

function flashKey(key) {
  key.classList.add('pressed');
  setTimeout(() => key.classList.remove('pressed'), 150);
}

function buildIntervalGrid(q) {
  const grid = el('div', { class: 'int-grid' });
  const songs = cfg().songs;
  activeItems().slice().sort((a, b) => a - b).forEach((s, idx) => {
    const info = INTERVALS[s];
    let cls = 'int-btn';
    if (q && q.answered) {
      if (s === q.item) cls += ' good';
      else if (s === q.given) cls += ' bad';
    }
    grid.append(el('button', { class: cls, type: 'button', onclick: () => answer(s) },
      INT_HOTKEYS[idx] ? el('span', { class: 'hk' }, INT_HOTKEYS[idx]) : null,
      el('span', { class: 'short' }, info.short),
      el('span', { class: 'name' }, info.name),
      songs ? el('span', { class: 'song' }, info.song) : null,
    ));
  });
  return grid;
}

// Shows where the two notes of an interval sit, once the question is answered.
function buildDisplayPiano(q) {
  const show = q && q.answered;
  const low = show ? Math.min(...q.notes) : 60;
  const start = low - (low % 12);
  const piano = buildPiano(start, 25, (key, midi) => {
    key.disabled = true;
    key.tabIndex = -1;
    if (show && q.notes.includes(midi)) key.classList.add('mark');
  });
  const caption = el('p', { class: 'muted small caption' },
    show ? q.notes.map(noteName).join(q.kind === 'harm' ? ' + ' : ' → ') : 'The notes appear here after you answer.');
  return [piano, caption];
}

function renderStats() {
  const m = mode();
  const stats = state.stats[state.mode];
  const box = $('#stats');
  box.replaceChildren();
  const items = m.order.slice().sort((a, b) => a - b).filter((i) => stats[i] && stats[i].n);
  if (!items.length) {
    box.append(el('p', { class: 'muted small' }, 'Answer a few questions and your accuracy for each item shows up here.'));
    return;
  }
  for (const i of items) {
    const s = stats[i];
    const pct = Math.round((s.ok / s.n) * 100);
    box.append(el('div', { class: 'stat-row' },
      el('span', { class: 'label' }, m.label(i)),
      el('div', { class: 'stat-bar' }, el('div', { style: `width:${pct}%` })),
      el('span', { class: 'num' }, `${pct}% · ${s.ok}/${s.n}`),
    ));
  }
  const conf = [];
  for (const i of items) {
    for (const [ans, n] of Object.entries(stats[i].conf || {})) conf.push({ asked: i, ans: Number(ans), n });
  }
  conf.sort((a, b) => b.n - a.n);
  if (conf.length) {
    box.append(el('p', { class: 'small', style: 'margin:14px 0 0;font-weight:600' }, 'Most common mix-ups'));
    box.append(el('ul', { class: 'confusions' }, conf.slice(0, 5).map((c) =>
      el('li', {}, `${m.fullLabel(c.asked)} heard as ${m.fullLabel(c.ans)} (${c.n}×)`))));
  }
}

function syncSettings() {
  $('#set-range').value = state.pp.range;
  $('#set-mask').checked = state.pp.mask;
  $('#set-labels').checked = state.pp.labels;
  $('#set-dir').value = state.int.direction;
  $('#set-songs').checked = state.int.songs;
  $('#set-auto').checked = state.autoNext;
  $('#set-vol').value = state.volume;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Wiring ----------

function mainAction() {
  const q = question && question.mode === state.mode ? question : null;
  if (!q || q.answered) newQuestion();
  else playQuestion(false);
}

$('#play').addEventListener('click', mainAction);
$('#replay').addEventListener('click', () => playQuestion(false));

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  clearQuestion();
  saveState();
  renderAll();
}));

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  cfg().style = b.dataset.style;
  clearQuestion();
  saveState();
  renderSetup();
  renderQuiz();
}));

$('#lvl-down').addEventListener('click', () => setLevel(cfg().level - 1));
$('#lvl-up').addEventListener('click', () => setLevel(cfg().level + 1));

const bindSetting = (sel, apply) => $(sel).addEventListener('change', (e) => {
  const t = e.target;
  apply(t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value);
  saveState();
  renderQuiz();
});
bindSetting('#set-range', (v) => { state.pp.range = v; });
bindSetting('#set-mask', (v) => { state.pp.mask = v; });
bindSetting('#set-labels', (v) => { state.pp.labels = v; });
bindSetting('#set-dir', (v) => { state.int.direction = v; if (question && question.mode === 'int' && !question.answered) question = null; });
bindSetting('#set-songs', (v) => { state.int.songs = v; });
bindSetting('#set-auto', (v) => { state.autoNext = v; });
$('#set-vol').addEventListener('input', (e) => {
  state.volume = Number(e.target.value);
  Sound.setVolume(state.volume);
  saveState();
});

$('#reset-stats').addEventListener('click', () => {
  const name = state.mode === 'pp' ? 'perfect pitch' : 'interval';
  if (!confirm(`Reset all ${name} stats and level progress?`)) return;
  state.stats[state.mode] = {};
  Object.assign(cfg(), { level: 1, maxLevel: 1, recent: [], mastered: false });
  clearQuestion();
  saveState();
  renderAll();
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'SUMMARY') return;
  const k = e.key.toLowerCase();

  if (k === ' ') {
    e.preventDefault();
    mainAction();
    return;
  }
  if (k === 'enter') {
    if (tag === 'BUTTON') return; // let Enter activate the focused control
    e.preventDefault();
    newQuestion();
    return;
  }
  if (e.repeat) return;
  if (state.mode === 'pp' && k in PIANO_KEYS) {
    const pc = PIANO_KEYS[k];
    const key = document.querySelector(`#answer-area .key[data-pc="${pc}"]`);
    if (key) flashKey(key);
    answer(pc);
  } else if (state.mode === 'int') {
    const idx = INT_HOTKEYS.indexOf(k);
    const items = activeItems().slice().sort((a, b) => a - b);
    if (idx >= 0 && idx < items.length) answer(items[idx]);
  }
});

// iOS only lets audio start from certain gestures, so unlock it on the first one.
const unlock = () => Sound.init();
document.addEventListener('touchend', unlock, { once: true });
document.addEventListener('click', unlock, { once: true });

renderAll();
