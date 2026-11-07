'use strict';
/* ==========================================================
   MR TRACKER — flexo changeover timer
   All times are stored as timestamps; displays are computed
   from them, so a killed app / locked phone never loses time.
   ========================================================== */

const PRESSES = [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CODES = {
  Y: ['Make Ready Sleeve', 'Make Ready Time', 'Dirty Anilox', 'Wait for Ink', 'Chamber Problem', 'Anilox Change', 'Wrong Sequence', 'Other'],
  R: ['Mechanical Problem', 'Electrical Problem', 'Maintenance (Mech + Elec)', 'Blade Change', 'No Operator', 'No Assistant', 'Housekeeping', 'Other'],
};
const FIRST_CODE = 'Make Ready Sleeve';
const RATINGS = [
  { max: 30, label: 'IDEAL', cls: 'ideal', color: '#1FBF6A' },
  { max: 45, label: 'ACCEPTABLE', cls: 'acceptable', color: '#FFC400' },
  { max: 60, label: 'NOT SATISFACTORY', cls: 'notsat', color: '#FF7A1A' },
  { max: Infinity, label: 'OVER LIMIT', cls: 'over', color: '#E5322D' },
];
const GAUGE_MAX_MIN = 75;
const UNDO_MS = 30000;
const PALETTE = {
  Y: ['#FFC400', '#FFE066', '#D99E00', '#FFF0A8', '#A87D00', '#FFAE00', '#EED58A', '#8A6A10'],
  R: ['#E5322D', '#FF7A70', '#A81F1B', '#FFB0A8', '#70120F', '#D9534F', '#F09088', '#4A0C0A'],
};
const LS = { session: 'mrt.session', names: 'mrt.names', settings: 'mrt.settings', lastPress: 'mrt.lastPress' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function lsGet(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { } }

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtMS(ms) { // mm:ss, or h:mm:ss past one hour
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
const fmtClock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const min2 = (ms) => Math.round(ms / 600) / 100;
const rating = (ms) => RATINGS.find((r) => ms / 60000 <= r.max);
const initials = (n) => String(n || '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '--';
const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { } };

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const r = indexedDB.open('mrtracker', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('history', { keyPath: 'id' });
      d.createObjectStore('photos', { keyPath: 'id' });
      d.createObjectStore('queue', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
    put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
    del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
    all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  };
})();

/* ---------- session model ---------- */
let S = lsGet(LS.session, null);
const save = () => lsSet(LS.session, S);
const current = () => S && S.segments[S.segments.length - 1];

function totals(s, now = Date.now()) {
  const stop = s.endedAt ?? now;
  let y = 0, r = 0;
  const byCode = {};
  for (const g of s.segments) {
    const d = Math.max(0, (g.end ?? stop) - g.start);
    if (g.cat === 'Y') y += d; else r += d;
    const k = g.cat + '|' + g.code;
    byCode[k] = (byCode[k] || 0) + d;
  }
  return { y, r, global: s.startedAt ? stop - s.startedAt : 0, byCode };
}

function newSegment(cat, code, start, note = '') {
  return { id: uid('g'), cat, code, start, end: null, note, photos: [] };
}

function startSession() {
  const t = Date.now();
  S.startedAt = t;
  S.segments = [newSegment('Y', FIRST_CODE, t)];
  save();
  vibrate([60, 40, 120]);
  keepAwake(true);
  renderTimer(true);
  flashCard();
}

function switchCode(cat, code, note = '') {
  const cur = current();
  if (cur && cur.cat === cat && cur.code === code && code !== 'Other') {
    toast(`${code} is already running`);
    return;
  }
  const t = Date.now();
  if (cur) cur.end = t;
  S.segments.push(newSegment(cat, code, t, note));
  S.undoUntil = t + UNDO_MS;
  save();
  vibrate(cat === 'R' ? [120, 60, 120] : 70);
  renderTimer(true);
  flashCard();
}

async function undoLast() {
  if (!S || !S.undoUntil || Date.now() > S.undoUntil || S.segments.length < 2) return;
  const removed = S.segments.pop();
  current().end = null;
  S.undoUntil = null;
  save();
  for (const pid of removed.photos) DB.del('photos', pid).catch(() => { });
  vibrate(40);
  toast(`Undone · back to ${current().code}`);
  renderTimer(true);
  flashCard();
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now; retried on visibility change */ }
}

/* ---------- navigation ---------- */
let screen = 'setup';
function show(name) {
  screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name));
  document.body.classList.toggle('red-mode', name === 'timer' && current()?.cat === 'R');
  if (name === 'setup') renderSetup();
  if (name === 'timer') renderTimer(true);
  if (name === 'history') { setHistSelect(false); renderHistory(); }
  if (name === 'settings') renderSettings();
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, cls = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + cls;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- modal ---------- */
function confirmModal({ title, text = '', yes = 'YES', no = 'CANCEL', tone = 'green' }) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-text').hidden = !text;
    $('#modal-yes').innerHTML = `<span>${esc(yes)}</span>`;
    $('#modal-no').innerHTML = `<span>${esc(no)}</span>`;
    $('#modal-yes').classList.toggle('danger', tone === 'red');
    $('#modal-stripe').classList.toggle('red', tone === 'red');
    const m = $('#modal');
    m.hidden = false;
    const done = (v) => { m.hidden = true; $('#modal-yes').onclick = $('#modal-no').onclick = null; resolve(v); };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
  });
}

/* ---------- bottom sheet ---------- */
function openSheet({ kicker, title, color = 'var(--yellow)', html, cls = '' }) {
  const sh = $('#sheet');
  sh.style.setProperty('--sheet-c', color);
  sh.className = 'sheet ' + cls;
  $('#sheet-kicker').textContent = kicker;
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  sh.hidden = false;
  $('#scrim').hidden = false;
  return $('#sheet-body');
}
function closeSheet() {
  const sh = $('#sheet');
  if (sh.hidden) return;
  sh.classList.add('closing');
  $('#scrim').hidden = true;
  setTimeout(() => { sh.hidden = true; sh.classList.remove('closing'); }, 190);
}
$('#scrim').addEventListener('click', closeSheet);

function openCodeSheet(cat) {
  const t = totals(S);
  const cur = current();
  const color = cat === 'Y' ? 'var(--yellow)' : 'var(--red)';
  const html = CODES[cat].map((code) => {
    const acc = t.byCode[cat + '|' + code] || 0;
    const isCur = cur && cur.cat === cat && cur.code === code;
    return `<button class="code-row${isCur ? ' current' : ''}" data-code="${esc(code)}">
      <span class="bar"></span>
      <span class="nm">${esc(code)}${isCur ? '<span class="run">RUNNING</span>' : ''}</span>
      <span class="acc">${acc ? fmtMS(acc) : '—'}</span>
    </button>`;
  }).join('');
  const body = openSheet({
    kicker: cat === 'Y' ? 'YELLOW · COUNTS AS EFFECTIVE MR' : 'RED · DOWNTIME, COUNTED APART',
    title: cat === 'Y' ? 'Make Ready activity' : 'Red code',
    color, html,
  });
  body.onclick = (e) => {
    const row = e.target.closest('.code-row');
    if (!row) return;
    const code = row.dataset.code;
    if (code === 'Other') {
      openNoteSheet({
        kicker: cat === 'Y' ? 'YELLOW · OTHER' : 'RED · OTHER',
        title: 'What is happening?',
        color, required: true,
        onSave: (note) => switchCode(cat, 'Other', note),
      });
    } else {
      closeSheet();
      switchCode(cat, code);
    }
  };
}

function openNoteSheet({ kicker, title, color, required, initial = '', onSave }) {
  const body = openSheet({
    kicker, title, color,
    html: `<textarea class="note" id="note-input" maxlength="500" placeholder="${required ? 'Required — describe the activity' : 'Optional note'}">${esc(initial)}</textarea>
      <div class="sheet-actions">
        <button class="btn btn-steel small" data-act="cancel"><span>CANCEL</span></button>
        <button class="btn btn-green small" data-act="save"><span>SAVE</span></button>
      </div>`,
  });
  const ta = $('#note-input');
  setTimeout(() => ta.focus(), 250);
  body.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeSheet();
    if (act === 'save') {
      const v = ta.value.trim();
      if (required && !v) { toast('Please write a note', 'err'); ta.focus(); return; }
      closeSheet();
      onSave(v);
    }
  };
}

/* ---------- SETUP screen ---------- */
const form = { press: lsGet(LS.lastPress, null) };
const names = () => lsGet(LS.names, { operator: [], supervisor: [] });

function renderSetup() {
  $('#press-grid').innerHTML = PRESSES.map((p) =>
    `<button class="press-tile${form.press === p ? ' sel' : ''}" data-press="${p}"><small>PRESS</small><b>${pad(p)}</b></button>`
  ).join('');
  renderChips('operator');
  renderChips('supervisor');
  validateSetup();
  updatePendingBadge();
}

$('#press-grid').addEventListener('click', (e) => {
  const t = e.target.closest('[data-press]');
  if (!t) return;
  form.press = Number(t.dataset.press);
  vibrate(25);
  $$('.press-tile').forEach((el) => el.classList.toggle('sel', el === t));
  validateSetup();
});

function renderChips(kind) {
  const input = $('#f-' + kind);
  const q = input.value.trim().toLowerCase();
  const list = names()[kind]
    .filter((n) => !q || (n.toLowerCase().includes(q) && n.toLowerCase() !== q))
    .slice(0, 8);
  $(`[data-chips="${kind}"]`).innerHTML = list.map((n) => `<button class="chip" data-name="${esc(n)}">${esc(n)}</button>`).join('');
}

function bindChips(kind) {
  const box = $(`[data-chips="${kind}"]`);
  let pressTimer = null, longFired = false;
  box.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    longFired = false;
    pressTimer = setTimeout(async () => {
      longFired = true;
      c.classList.add('deleting');
      vibrate(50);
      const ok = await confirmModal({ title: 'Remove name?', text: `"${c.dataset.name}" will be removed from the saved list.`, yes: 'REMOVE', tone: 'red' });
      if (ok) {
        const all = names();
        all[kind] = all[kind].filter((n) => n !== c.dataset.name);
        lsSet(LS.names, all);
      }
      renderChips(kind);
    }, 550);
  });
  const cancel = () => clearTimeout(pressTimer);
  box.addEventListener('pointerup', cancel);
  box.addEventListener('pointerleave', cancel);
  box.addEventListener('pointercancel', cancel);
  box.addEventListener('contextmenu', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || longFired) return;
    $('#f-' + kind).value = c.dataset.name;
    renderChips(kind);
    validateSetup();
  });
  $('#f-' + kind).addEventListener('input', () => { renderChips(kind); validateSetup(); });
}
bindChips('operator');
bindChips('supervisor');
['#f-job', '#f-item'].forEach((s) => $(s).addEventListener('input', validateSetup));
// Enter moves to next field
['#f-job', '#f-item', '#f-operator', '#f-supervisor'].forEach((s, i, arr) => {
  $(s).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (arr[i + 1]) $(arr[i + 1]).focus(); else $(s).blur();
  });
});

function setupValues() {
  return {
    press: form.press,
    job: $('#f-job').value.trim(),
    item: $('#f-item').value.trim(),
    operator: $('#f-operator').value.trim().replace(/\s+/g, ' '),
    supervisor: $('#f-supervisor').value.trim().replace(/\s+/g, ' '),
  };
}
function validateSetup() {
  const v = setupValues();
  $('#btn-ready').disabled = !(v.press && v.job && v.item && v.operator && v.supervisor);
}

function rememberName(kind, name) {
  const all = names();
  const list = all[kind].filter((n) => n.toLowerCase() !== name.toLowerCase());
  list.unshift(name);
  all[kind] = list.slice(0, 40);
  lsSet(LS.names, all);
}

$('#btn-ready').addEventListener('click', () => {
  const v = setupValues();
  rememberName('operator', v.operator);
  rememberName('supervisor', v.supervisor);
  lsSet(LS.lastPress, v.press);
  S = { id: uid('S'), ...v, createdAt: Date.now(), startedAt: null, endedAt: null, segments: [], alerts: [], undoUntil: null };
  save();
  ['#f-job', '#f-item'].forEach((s) => { $(s).value = ''; });
  show('timer');
});

/* ---------- TIMER screen ---------- */
let lastSegCount = -1;

function renderTimer(full = false) {
  if (!S) return;
  const now = Date.now();
  const t = totals(S, now);
  const cur = current();
  const running = !!S.startedAt && !S.endedAt;

  if (full) {
    $('#t-press').textContent = pad(S.press);
    $('#t-job').textContent = S.job;
    $('#t-item').textContent = S.item;
    $('#t-crew').textContent = initials(S.operator);
    $('#dock-start').hidden = running;
    $('#dock-run').hidden = !running;
    $('#t-started').textContent = S.startedAt ? 'since ' + fmtClock(S.startedAt) : '';
  }
  $('#scr-timer').classList.toggle('running', running);

  $('#t-global').textContent = fmtHMS(t.global);
  $('#t-yellow').textContent = fmtMS(t.y);
  $('#t-red').textContent = fmtMS(t.r);
  $('#t-redpct').textContent = `${t.global ? Math.round((t.r / t.global) * 100) : 0}% of global`;

  const r = rating(t.y);
  const chip = $('#t-rating');
  chip.textContent = r.label;
  chip.className = 'rating-chip ' + r.cls;
  const g = $('#t-gauge');
  g.style.width = Math.min(100, (t.y / 60000 / GAUGE_MAX_MIN) * 100) + '%';
  g.style.background = r.color;
  g.style.color = r.color;

  // active code card
  const card = $('#t-active');
  if (cur) {
    if (full || card.dataset.cat !== cur.cat || card.dataset.seg !== cur.id) {
      card.dataset.cat = cur.cat;
      card.dataset.seg = cur.id;
      $('#t-active-cat').textContent = cur.cat === 'Y' ? 'YELLOW · MAKE READY' : 'RED CODE · DOWNTIME';
      $('#t-active-code').textContent = cur.code;
      $('#t-ac-actions').hidden = false;
      $('#btn-photo').hidden = cur.cat !== 'R';
      document.body.classList.toggle('red-mode', cur.cat === 'R' && screen === 'timer');
      renderAttach();
    }
    $('#t-seg').textContent = fmtMS(now - cur.start);
  } else {
    card.dataset.cat = 'idle';
    card.dataset.seg = '';
    $('#t-active-cat').textContent = 'STANDBY';
    $('#t-active-code').textContent = 'Press START to begin';
    $('#t-seg').textContent = '00:00';
    $('#t-ac-actions').hidden = true;
    document.body.classList.remove('red-mode');
  }

  // timeline
  const tl = $('#t-timeline');
  if (S.segments.length !== lastSegCount || full) {
    lastSegCount = S.segments.length;
    tl.innerHTML = S.segments.map((s, i) => `<i class="${s.cat}${i === S.segments.length - 1 && running ? ' live' : ''}"></i>`).join('');
  }
  const kids = tl.children;
  S.segments.forEach((s, i) => { if (kids[i]) kids[i].style.flexGrow = Math.max(1, ((s.end ?? now) - s.start) / 1000); });

  // undo
  const left = S.undoUntil ? Math.ceil((S.undoUntil - now) / 1000) : 0;
  $('#btn-undo').hidden = !(running && left > 0);
  if (left > 0) $('#t-undo').textContent = `UNDO LAST CODE · ${left}`;

  if (running) checkAlerts(t);
}

function renderAttach() {
  const cur = current();
  if (!cur) return;
  const bits = [];
  if (cur.note) bits.push('✎ ' + cur.note);
  if (cur.photos.length) bits.push(`📷 ${cur.photos.length}`);
  $('#t-attach').textContent = bits.join('  ·  ');
}

function flashCard() {
  const c = $('#t-active');
  c.classList.remove('flash');
  void c.offsetWidth;
  c.classList.add('flash');
}

function checkAlerts(t) {
  const m = t.y / 60000;
  for (const th of [30, 45, 60]) {
    if (m >= th && !S.alerts.includes(th)) {
      S.alerts.push(th);
      save();
      const r = rating(t.y + 1000);
      toast(`Effective MR passed ${th} min · ${r.label}`, r.cls);
      vibrate([300, 120, 300, 120, 300]);
    }
  }
}

setInterval(() => { if (screen === 'timer') renderTimer(); }, 250);

$('#btn-start').addEventListener('click', startSession);
$('#btn-mr').addEventListener('click', () => openCodeSheet('Y'));
$('#btn-redcode').addEventListener('click', () => openCodeSheet('R'));
$('#btn-undo').addEventListener('click', undoLast);

$('#btn-note').addEventListener('click', () => {
  const cur = current();
  if (!cur) return;
  openNoteSheet({
    kicker: (cur.cat === 'Y' ? 'YELLOW · ' : 'RED · ') + cur.code.toUpperCase(),
    title: 'Note for this code',
    color: cur.cat === 'Y' ? 'var(--yellow)' : 'var(--red)',
    required: cur.code === 'Other',
    initial: cur.note,
    onSave: (v) => { cur.note = v; save(); renderAttach(); toast('Note saved'); },
  });
});

$('#btn-photo').addEventListener('click', () => $('#photo-input').click());
$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const cur = current();
  if (!file || !cur) return;
  try {
    const blob = await compressImage(file, 1280, 0.75);
    const d = new Date();
    const name = `${safeName(S.job)}_seg${S.segments.length}_${cur.code.replace(/[^A-Za-z0-9]+/g, '-')}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
    const id = uid('p');
    await DB.put('photos', { id, sessionId: S.id, name, blob });
    cur.photos.push(id);
    save();
    renderAttach();
    vibrate(40);
    toast('Photo attached');
  } catch (err) {
    toast('Could not save photo', 'err');
  }
});

async function compressImage(file, max, q) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', q));
}

$('#btn-menu').addEventListener('click', () => {
  const body = openSheet({
    kicker: `PRESS ${pad(S.press)} · JOB ${S.job}`, title: 'Changeover', color: 'var(--muted)', cls: 'sheet-menu',
    html: `<button class="code-row" data-act="discard"><span class="bar" style="background:var(--red)"></span><span class="nm">Discard this changeover</span><span class="acc"></span></button>
      <button class="code-row" data-act="close"><span class="bar"></span><span class="nm">Close menu</span><span class="acc"></span></button>`,
  });
  body.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeSheet();
    if (act === 'discard') {
      const ok = await confirmModal({ title: 'Discard changeover?', text: 'All recorded times for this job will be deleted. This cannot be undone.', yes: 'DISCARD', no: 'KEEP', tone: 'red' });
      if (!ok) return;
      for (const g of S.segments) for (const pid of g.photos) DB.del('photos', pid).catch(() => { });
      S = null;
      lsDel(LS.session);
      keepAwake(false);
      show('setup');
    }
  };
});

$('#btn-release').addEventListener('click', async () => {
  vibrate(60);
  const t = totals(S);
  // Timer keeps running while the question is open.
  const ok = await confirmModal({
    title: 'Make Ready finished?',
    text: `Effective MR ${fmtMS(t.y)} · Global ${fmtHMS(t.global)}. Confirming stops all timers and sends the report to Drive.`,
    yes: 'YES, RELEASE', no: 'NO, CONTINUE',
  });
  if (!ok) { toast(`Continuing · ${current().code}`); return; }
  finishSession();
});

async function finishSession() {
  const t0 = Date.now();
  current().end = t0;
  S.endedAt = t0;
  S.undoUntil = null;
  const t = totals(S);
  const rec = {
    ...S,
    totals: { y: t.y, r: t.r, global: t.global },
    rating: rating(t.y).label,
    photoUrls: {},
    upload: { status: 'queued' },
  };
  await DB.put('history', rec);
  await DB.put('queue', { id: rec.id, at: t0 });
  lsDel(LS.session);
  S = null;
  keepAwake(false);
  document.body.classList.remove('red-mode');
  vibrate([80, 60, 80, 60, 240]);
  showSummary(rec, false);
  processQueue();
}

/* ---------- SUMMARY screen ---------- */
let summaryRec = null;

function showSummary(rec, fromHistory) {
  summaryRec = rec;
  $('#btn-sum-back').hidden = !fromHistory;
  $('#btn-sum-delete').hidden = !fromHistory;
  $('#btn-new').innerHTML = fromHistory ? '<span>BACK TO HISTORY</span>' : '<span>NEW CHANGEOVER</span>';
  $('#btn-new').dataset.mode = fromHistory ? 'history' : 'new';
  show('summary');
  renderSummary();
  $('#sum-body').scrollTop = 0;
}

function aggregate(rec) {
  const map = new Map();
  for (const g of rec.segments) {
    const k = g.cat + '|' + g.code;
    map.set(k, (map.get(k) || 0) + (g.end - g.start));
  }
  const idx = { Y: 0, R: 0 };
  return [...map.entries()]
    .map(([k, ms]) => ({ cat: k[0], code: k.slice(2), ms }))
    .sort((a, b) => (a.cat === b.cat ? b.ms - a.ms : a.cat === 'Y' ? -1 : 1))
    .map((x) => ({ ...x, color: PALETTE[x.cat][idx[x.cat]++ % PALETTE[x.cat].length] }));
}

function donutSVG(items, total) {
  const R = 80, C = 2 * Math.PI * R;
  let off = 0;
  const segs = items.map((it, i) => {
    const len = total ? (it.ms / total) * C : 0;
    const gap = items.length > 1 ? Math.min(2, len / 3) : 0;
    const s = `<circle class="seg" cx="100" cy="100" r="${R}" fill="none" stroke="${it.color}" stroke-width="26"
      stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-off}" style="animation-delay:${i * 60}ms"/>`;
    off += len;
    return s;
  }).join('');
  return `<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="${R}" fill="none" stroke="#0B0D10" stroke-width="30"/>${segs}</svg>`;
}

function renderSummary() {
  const rec = summaryRec;
  if (!rec) return;
  const t = rec.totals;
  const r = rating(t.y);
  const items = aggregate(rec);
  const notes = rec.segments.filter((g) => g.note);
  $('#sum-body').innerHTML = `
    <div class="panel hero">
      <div class="kicker">EFFECTIVE MAKE READY</div>
      <div class="big">${fmtMS(t.y)}</div>
      <span class="rating-chip ${r.cls}">${r.label}</span>
      <div class="target">TARGET 30 · ACCEPTABLE 45 · MAX 60 MIN</div>
      <div class="stats3">
        <div class="stat"><small>GLOBAL</small><b>${fmtMS(t.global)}</b></div>
        <div class="stat r"><small>RED</small><b>${fmtMS(t.r)}</b></div>
        <div class="stat"><small>EVENTS</small><b>${rec.segments.length}</b></div>
      </div>
    </div>
    <div id="sum-upload"></div>
    <div class="panel dist">
      <div class="donut">${donutSVG(items, t.global)}
        <div class="center"><small>GLOBAL</small><b>${fmtMS(t.global)}</b></div>
      </div>
      <ul class="legend">${items.map((it) => `
        <li><span class="sw" style="background:${it.color}"></span>
          <span class="nm">${esc(it.code)}<em>${it.cat === 'Y' ? 'YEL' : 'RED'}</em></span>
          <span class="mn">${fmtMS(it.ms)}</span>
          <span class="pc">${t.global ? Math.round((it.ms / t.global) * 100) : 0}%</span></li>`).join('')}
      </ul>
    </div>
    <dl class="panel meta">
      <dt>PRESS</dt><dd>${pad(rec.press)}</dd>
      <dt>JOB</dt><dd>${esc(rec.job)}</dd>
      <dt>ITEM</dt><dd>${esc(rec.item)}</dd>
      <dt>OPERATOR</dt><dd>${esc(rec.operator)}</dd>
      <dt>SUPERVISOR</dt><dd>${esc(rec.supervisor)}</dd>
      <dt>DATE</dt><dd>${fmtDate(rec.startedAt)}</dd>
      <dt>START · END</dt><dd>${fmtClock(rec.startedAt)} → ${fmtClock(rec.endedAt)}</dd>
    </dl>
    ${notes.length ? `<div class="panel notes"><h4>NOTES</h4>${notes.map((g) => `<p><b>${esc(g.code)}:</b> ${esc(g.note)}</p>`).join('')}</div>` : ''}
  `;
  renderUploadCard();
}

function renderUploadCard() {
  const box = $('#sum-upload');
  if (!box || !summaryRec) return;
  const u = summaryRec.upload || {};
  const configured = !!getSettings().url;
  let cls, icon, title, sub, btn = '';
  const ico = {
    done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    up: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/><path d="M12 11v5M10 13l2-2 2 2"/>',
  };
  if (u.status === 'done') {
    cls = 'done'; icon = ico.done; title = 'Saved to Drive';
    sub = `Leon / <a href="${esc(u.fileUrl)}" target="_blank" rel="noopener">${esc(u.fileName)}</a>`;
  } else if (u.status === 'uploading') {
    cls = 'uploading'; icon = ico.up; title = 'Uploading…'; sub = 'Sending report to Google Drive';
  } else if (!configured) {
    cls = 'config'; icon = ico.cloud; title = 'Drive not set up'; sub = 'Report is saved here and will upload once linked';
    btn = '<button class="mini" data-go="settings">SET UP</button>';
  } else {
    cls = 'queued'; icon = ico.cloud; title = navigator.onLine ? 'Waiting to upload' : 'Offline · queued';
    sub = u.error ? esc(u.error) : 'Will upload automatically';
    btn = '<button class="mini" id="btn-retry-one">RETRY</button>';
  }
  box.innerHTML = `<div class="panel upload ${cls}">
    <div class="ico"><svg viewBox="0 0 24 24">${icon}</svg></div>
    <div class="txt"><b>${title}</b><span>${sub}</span></div>${btn}</div>`;
  const rb = $('#btn-retry-one');
  if (rb) rb.onclick = () => processQueue(true);
}

$('#btn-sum-back').addEventListener('click', () => show('history'));
$('#btn-sum-delete').addEventListener('click', async () => {
  if (summaryRec && await deleteRecords([summaryRec.id])) show('history');
});
$('#btn-new').addEventListener('click', () => show($('#btn-new').dataset.mode === 'history' ? 'history' : 'setup'));
$('#btn-download').addEventListener('click', () => exportLocal(false));
$('#btn-share').addEventListener('click', () => exportLocal(true));

async function exportLocal(share) {
  if (!summaryRec) return;
  try {
    const blob = await buildXlsx(summaryRec);
    const name = safeName(summaryRec.job) + '.xlsx';
    const file = new File([blob], name, { type: XLSX_MIME });
    if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `MR · Job ${summaryRec.job}` });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || 'Export failed', 'err');
  }
}

/* ---------- Excel ---------- */
const safeName = (s) => String(s).trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'job';
// ExcelJS writes dates as UTC; shift so Excel shows local wall-clock time.
const xlDate = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

async function buildXlsx(rec) {
  if (!window.ExcelJS) throw new Error('Excel engine not loaded — open the app once with internet');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MR Tracker';
  wb.created = new Date();
  const ws = wb.addWorksheet('Changeover', { views: [{ state: 'frozen', ySplit: 1 }] });
  const t = rec.totals;
  const cols = [
    { h: 'Job Number', w: 14 },
    { h: 'Item', w: 16 },
    { h: 'Press', w: 8 },
    { h: 'Operator', w: 20 },
    { h: 'Supervisor', w: 20 },
    { h: 'Date', w: 12, fmt: 'yyyy-mm-dd' },
    { h: 'Segment #', w: 11 },
    { h: 'Category', w: 11 },
    { h: 'Code', w: 26 },
    { h: 'Start Time', w: 20, fmt: 'yyyy-mm-dd hh:mm:ss' },
    { h: 'End Time', w: 20, fmt: 'yyyy-mm-dd hh:mm:ss' },
    { h: 'Duration (min)', w: 15, fmt: '0.00' },
    { h: 'Duration (hh:mm:ss)', w: 19, fmt: '[h]:mm:ss' },
    { h: 'Note', w: 40 },
    { h: 'Photo Link', w: 40 },
    { h: 'Session Yellow Total (min)', w: 24, fmt: '0.00' },
    { h: 'Session Red Total (min)', w: 22, fmt: '0.00' },
    { h: 'Session Global (min)', w: 20, fmt: '0.00' },
    { h: 'Rating', w: 18 },
  ];
  const rows = rec.segments.map((g, i) => {
    const d = g.end - g.start;
    const links = (g.photos || []).map((id) => rec.photoUrls?.[id]).filter(Boolean).join(' | ');
    return [
      String(rec.job), rec.item, Number(rec.press), rec.operator, rec.supervisor,
      xlDate(dayStart(g.start)), i + 1, g.cat === 'Y' ? 'YELLOW' : 'RED', g.code,
      xlDate(g.start), xlDate(g.end), min2(d), d / 86400000,
      g.note || '', links,
      min2(t.y), min2(t.r), min2(t.global), rec.rating,
    ];
  });
  ws.addTable({
    name: 'tblChangeover',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: cols.map((c) => ({ name: c.h, filterButton: true })),
    rows,
  });
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.w;
    if (c.fmt) col.numFmt = c.fmt;
  });
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}

/* ---------- Drive upload (Apps Script) ---------- */
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbz-gHlsLJfb-es5DmVUdbjUJvhgqh3Q7-Zd8m9_elkVbjRPYQEo97Z9W9LspjoEcU7LkQ/exec';
const getSettings = () => lsGet(LS.settings, { url: DEFAULT_URL, token: '' });

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function api(payload) {
  const st = getSettings();
  if (!st.url) throw new Error('Drive not set up');
  const res = await fetch(st.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
    body: JSON.stringify({ ...payload, token: st.token }),
    redirect: 'follow',
  });
  let j;
  try { j = await res.json(); } catch { throw new Error('Unexpected reply from Drive script'); }
  if (!j.ok) throw new Error(j.error || 'Upload failed');
  return j;
}

let syncing = false;
async function processQueue(manual = false) {
  if (syncing) return;
  if (!navigator.onLine) { if (manual) toast('No connection — will retry automatically', 'err'); return; }
  if (!getSettings().url) { if (manual) toast('Set up Drive in Settings first', 'err'); updatePendingBadge(); return; }
  syncing = true;
  try {
    const queue = await DB.all('queue');
    for (const item of queue.sort((a, b) => a.at - b.at)) {
      const rec = await DB.get('history', item.id);
      if (!rec) { await DB.del('queue', item.id); continue; }
      try {
        rec.upload = { status: 'uploading' };
        await DB.put('history', rec);
        refreshRec(rec);
        rec.photoUrls = rec.photoUrls || {};
        for (const g of rec.segments) {
          for (const pid of g.photos || []) {
            if (rec.photoUrls[pid]) continue;
            const p = await DB.get('photos', pid);
            if (!p) continue;
            const r = await api({ action: 'photo', job: safeName(rec.job), fileName: p.name, base64: await blobToB64(p.blob) });
            rec.photoUrls[pid] = r.url;
            await DB.put('history', rec);
          }
        }
        const blob = await buildXlsx(rec);
        const r = await api({ action: 'file', fileName: safeName(rec.job), base64: await blobToB64(blob) });
        rec.upload = { status: 'done', fileName: r.name, fileUrl: r.url, at: Date.now() };
        await DB.put('history', rec);
        await DB.del('queue', rec.id);
        for (const pid of Object.keys(rec.photoUrls)) DB.del('photos', pid).catch(() => { });
        toast(`Saved to Drive · ${r.name}`, 'ideal');
      } catch (e) {
        rec.upload = { status: 'queued', error: String(e.message || e) };
        await DB.put('history', rec);
      }
      refreshRec(rec);
    }
  } finally {
    syncing = false;
    updatePendingBadge();
  }
}

function refreshRec(rec) {
  if (summaryRec && summaryRec.id === rec.id) {
    summaryRec = rec;
    if (screen === 'summary') renderUploadCard();
  }
  if (screen === 'history') renderHistory();
}

async function updatePendingBadge() {
  let n = 0;
  try { n = (await DB.all('queue')).length; } catch { }
  $$('[data-pending]').forEach((b) => { b.textContent = n; b.hidden = !n; });
  const sp = $('#s-pending');
  if (sp) sp.textContent = n;
}

window.addEventListener('online', () => processQueue());
setInterval(() => processQueue(), 60000);

/* ---------- SETTINGS screen ---------- */
function renderSettings() {
  const st = getSettings();
  $('#s-url').value = st.url;
  $('#s-token').value = st.token;
  updatePendingBadge();
}
function readSettingsForm() {
  return { url: $('#s-url').value.trim(), token: $('#s-token').value.trim() };
}
$('#btn-s-save').addEventListener('click', () => {
  const st = readSettingsForm();
  if (st.url && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(st.url)) {
    toast('URL must end in /exec (Apps Script web app)', 'err');
    return;
  }
  lsSet(LS.settings, st);
  toast('Settings saved', 'ideal');
  processQueue();
});
$('#btn-s-test').addEventListener('click', async () => {
  lsSet(LS.settings, readSettingsForm());
  try {
    const r = await api({ action: 'ping' });
    toast(`Connected · folder "${r.folder}"`, 'ideal');
    processQueue();
  } catch (e) {
    toast(e.message || 'Connection failed', 'err');
  }
});
$('#btn-s-retry').addEventListener('click', () => processQueue(true));

/* ---------- HISTORY screen ---------- */
async function renderHistory() {
  const body = $('#hist-body');
  let list = [];
  try { list = await DB.all('history'); } catch { }
  list.sort((a, b) => b.endedAt - a.endedAt);
  $('#btn-hist-select').hidden = !list.length;
  if (!list.length) {
    setHistSelect(false);
    body.innerHTML = '<div class="empty">No changeovers recorded yet.</div>';
    return;
  }
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
  const zones = RATINGS.map((r) => ({ ...r, n: list.filter((x) => rating(x.totals.y) === r).length }));
  const group = (key) => {
    const m = {};
    list.forEach((x) => { (m[x[key]] ||= []).push(x.totals.y); });
    return Object.entries(m).map(([k, v]) => ({ k, avg: avg(v), n: v.length })).sort((a, b) => a.avg - b.avg);
  };
  const redByCode = {};
  list.forEach((x) => x.segments.filter((g) => g.cat === 'R').forEach((g) => { redByCode[g.code] = (redByCode[g.code] || 0) + (g.end - g.start); }));
  const topRed = Object.entries(redByCode).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const avgY = avg(list.map((x) => x.totals.y));

  body.innerHTML = `
    <div class="panel hstats">
      <h4>AVERAGE EFFECTIVE MR</h4>
      <div class="hbig"><b>${fmtMS(avgY)}</b><span>${list.length} changeover${list.length > 1 ? 's' : ''}</span></div>
      <div class="zonebar">${zones.map((z) => `<i style="flex:${z.n};background:${z.color}"></i>`).join('')}</div>
      <div class="zonelegend">${zones.map((z) => `<span style="--c:${z.color}">${z.label} ${Math.round((z.n / list.length) * 100)}%</span>`).join('')}</div>
    </div>
    <div class="panel hgroup"><h4>BY PRESS · AVG EFFECTIVE MR</h4>
      ${group('press').map((g) => `<div class="kv"><span>Press ${pad(g.k)} <small style="color:var(--dim)">(${g.n})</small></span><b style="color:${rating(g.avg).color}">${fmtMS(g.avg)}</b></div>`).join('')}
    </div>
    <div class="panel hgroup"><h4>BY OPERATOR · AVG EFFECTIVE MR</h4>
      ${group('operator').map((g) => `<div class="kv"><span>${esc(g.k)} <small style="color:var(--dim)">(${g.n})</small></span><b style="color:${rating(g.avg).color}">${fmtMS(g.avg)}</b></div>`).join('')}
    </div>
    ${topRed.length ? `<div class="panel hgroup"><h4>TOP RED CODES · TOTAL TIME</h4>
      ${topRed.map(([c, ms]) => `<div class="kv"><span>${esc(c)}</span><b style="color:#FF6A63">${fmtMS(ms)}</b></div>`).join('')}</div>` : ''}
    <div class="step-label"><span>${list.length}</span>CHANGEOVERS</div>
    ${list.map((x) => {
      const r = rating(x.totals.y);
      return `<button class="hitem${histSel.has(x.id) ? ' sel' : ''}" data-id="${x.id}">
        <span class="ck"></span>
        <span class="pl">${pad(x.press)}</span>
        <span class="mid"><b>JOB ${esc(x.job)}</b><span>${fmtDate(x.startedAt)} · ${esc(x.operator)}</span></span>
        <span class="rt"><b style="color:${r.color}">${fmtMS(x.totals.y)}</b>${x.upload?.status === 'done' ? '' : '<span class="up">NOT UPLOADED</span>'}</span>
      </button>`;
    }).join('')}
  `;
  body.onclick = async (e) => {
    const it = e.target.closest('.hitem');
    if (!it) return;
    if (histSelecting) {
      const id = it.dataset.id;
      if (histSel.has(id)) histSel.delete(id); else histSel.add(id);
      it.classList.toggle('sel', histSel.has(id));
      vibrate(20);
      updateHistDock();
      return;
    }
    const rec = await DB.get('history', it.dataset.id);
    if (rec) showSummary(rec, true);
  };
}

/* history: select & delete */
let histSelecting = false;
const histSel = new Set();

function setHistSelect(on) {
  histSelecting = on;
  histSel.clear();
  $('#scr-history').classList.toggle('hist-selecting', on);
  $('#btn-hist-select').classList.toggle('on', on);
  $('#btn-hist-select').textContent = on ? 'DONE' : 'SELECT';
  $('#hist-dock').hidden = !on;
  $$('#hist-body .hitem.sel').forEach((el) => el.classList.remove('sel'));
  updateHistDock();
}
function updateHistDock() {
  const n = histSel.size;
  $('#btn-hist-delete').disabled = !n;
  $('#t-hist-delete').textContent = n ? `DELETE (${n})` : 'DELETE';
}
$('#btn-hist-select').addEventListener('click', () => setHistSelect(!histSelecting));
$('#btn-hist-cancel').addEventListener('click', () => setHistSelect(false));
$('#btn-hist-delete').addEventListener('click', async () => {
  if (await deleteRecords([...histSel])) { setHistSelect(false); renderHistory(); }
});

// Removes changeovers from this phone only; files already in Drive stay there.
async function deleteRecords(ids) {
  const recs = (await Promise.all(ids.map((id) => DB.get('history', id)))).filter(Boolean);
  if (!recs.length) return false;
  const pending = recs.filter((r) => r.upload?.status !== 'done').length;
  const what = recs.length === 1 ? `job ${recs[0].job}` : `${recs.length} changeovers`;
  const ok = await confirmModal({
    title: `Delete ${what}?`,
    text: (pending
      ? `${pending === recs.length ? (pending === 1 ? 'It was' : 'They were') : `${pending} of them were`} NOT uploaded to Drive yet and will be lost. `
      : 'Excel files already in Drive are kept. ')
      + 'This only removes them from this phone.',
    yes: 'DELETE', no: 'CANCEL', tone: 'red',
  });
  if (!ok) return false;
  for (const r of recs) {
    for (const g of r.segments) for (const pid of g.photos || []) await DB.del('photos', pid).catch(() => { });
    await DB.del('queue', r.id);
    await DB.del('history', r.id);
  }
  vibrate(60);
  toast(`Deleted ${what}`);
  updatePendingBadge();
  return true;
}

/* ---------- lifecycle ---------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S && S.startedAt && !S.endedAt) keepAwake(true);
  if (screen === 'timer') renderTimer(true);
  processQueue();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

// Restore an unfinished changeover after the app was closed.
if (S && !S.endedAt) {
  show('timer');
  if (S.startedAt) { keepAwake(true); toast('Changeover restored · timers kept running'); }
} else {
  S = null;
  lsDel(LS.session);
  show('setup');
}
processQueue();
