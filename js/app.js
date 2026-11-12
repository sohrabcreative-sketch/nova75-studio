import * as P from './protocol.js';
import { PacketLog, connect, connectDemo, reconnect, webHidAvailable } from './device.js';
import { KEYS, LAYOUT } from './layout.js';
import {
  CODE_TO_USAGE,
  KEY_OPTIONS,
  MEDIA_OPTIONS,
  MODIFIERS,
  MOUSE_OPTIONS,
  describeAction,
} from './keys.js';
import { loadFrames, preview } from './screen.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ------------------------------------------------------------------ state

const STORE = 'nova75-studio:v1';
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
})();
/** What this browser last sent: the keyboard cannot report most of it back. */
const state = {
  lighting: { ...P.DEFAULT_LIGHTING, ...saved.lighting },
  perKey: saved.perKey ?? {},
  keymap: { base: saved.keymap?.base ?? {}, fn: saved.keymap?.fn ?? {} },
  dirty: { base: !!saved.dirty?.base, fn: !!saved.dirty?.fn },
  settings: { ...P.DEFAULT_SETTINGS, ...saved.settings },
  consent: !!saved.consent,
};
const save = () => localStorage.setItem(STORE, JSON.stringify(state));

const log = new PacketLog();
let kb = null;
let busy = false;
let battery = null;
let batteryTimer = 0;
let activeTab = 'home';
let screenFile = null;
let screenFrames = [];
let stopPreview = () => {};

// ------------------------------------------------------------------ feedback

function toast(text, kind = '', ms = 4000) {
  const t = el('div', { className: `toast ${kind}`, textContent: text });
  $('toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

function askConsent() {
  if (state.consent || kb?.demo) return Promise.resolve(true);
  const dlg = $('consent');
  return new Promise((resolve) => {
    dlg.returnValue = 'no';
    dlg.addEventListener(
      'close',
      () => {
        const yes = dlg.returnValue === 'yes';
        if (yes) {
          state.consent = true;
          save();
        }
        resolve(yes);
      },
      { once: true },
    );
    dlg.showModal();
  });
}

const modelConfirmed = () => !!kb && (kb.recognised || $('confirm-model').checked);

/** Runs one keyboard operation with the busy state, consent and error reporting around it. */
async function run(label, fn, done, { write = true } = {}) {
  if (!kb || busy) return;
  if (write && !state.consent && !kb.demo) {
    if (!(await askConsent()) || !kb || busy) return;
  }
  busy = true;
  updateGates();
  const t = toast(`${label}…`, 'busy', 0);
  try {
    await fn();
    toast(done);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 9000);
  } finally {
    t.remove();
    busy = false;
    updateGates();
  }
}

// ------------------------------------------------------------------ connection

function updateGates() {
  const usb = kb?.mode === 'usb';
  const ok = !busy && modelConfirmed();
  document.querySelectorAll('.needs-kb').forEach((b) => (b.disabled = !ok));
  document.querySelectorAll('.needs-usb').forEach((b) => (b.disabled = !ok || !usb));
  if (!screenFrames.length || !kb?.hasScreenPipe) $('s-upload').disabled = true;
  $('connect').disabled = busy || !webHidAvailable();
}

function renderConnection() {
  document.body.dataset.mode = kb?.mode ?? 'none';
  const pill = $('status');
  pill.className = `pill ${kb ? (kb.demo ? 'demo' : 'on') : ''}`;
  if (!kb) pill.textContent = 'Not connected';
  else if (kb.mode === 'usb') pill.textContent = `${kb.demo ? 'Demo · ' : ''}USB cable`;
  else pill.textContent = `${kb.demo ? 'Demo · ' : ''}2.4G receiver${battery?.level ? ` · ${battery.level}%` : ''}`;
  $('disconnect').hidden = !kb;
  $('device-card').hidden = !kb;
  $('unrecognised').hidden = !kb || kb.recognised;
  if (!kb) return updateGates();

  $('unrecognised-name').textContent = `It reports "${kb.productName}". `;
  const rows =
    kb.mode === 'usb'
      ? [
          ['Connection', kb.demo ? 'USB cable (simulated)' : 'USB cable'],
          ['Reports as', kb.productName || '(no name)'],
          ['Screen data channel', kb.hasScreenPipe ? 'Found' : 'Not found — screen upload unavailable'],
        ]
      : [
          ['Connection', kb.demo ? '2.4G receiver (simulated)' : '2.4G receiver'],
          ['Reports as', kb.productName || '(no name)'],
          ['Keyboard', battery?.linked ? 'Answering' : 'Not answering (asleep or switched off?)'],
          ['Battery', battery?.level ? `${battery.level}%` : 'Unknown'],
        ];
  $('device-info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  const usb = kb.mode === 'usb';
  const features = [
    ['Lighting effects', true],
    ['Sleep timer and key response', true],
    ['Battery level', !usb],
    ['Game mode', !usb],
    ['Per-key colours', usb],
    ['Key remapping (base and Fn layers)', usb],
    ['Screen image and GIF', usb && kb.hasScreenPipe],
    ['Clock sync', usb],
  ];
  $('feature-list').replaceChildren(
    ...features.map(([name, on]) => el('li', { className: on ? '' : 'off', textContent: name })),
  );
  updateGates();
}

async function pollBattery() {
  if (!kb || kb.mode !== 'dongle' || busy) return;
  try {
    battery = await kb.battery();
    renderConnection();
  } catch {
    /* the next poll tries again */
  }
}

async function attach(make) {
  if (busy) return;
  busy = true;
  updateGates();
  try {
    const next = await make();
    if (!next) return;
    await detach();
    kb = next;
    if (kb.mode === 'usb') {
      try {
        await kb.handshake();
      } catch (e) {
        await detach();
        throw new Error(`The keyboard did not answer the handshake, so nothing else was sent. ${e.message}`);
      }
    } else {
      battery = await kb.battery();
      if (!battery.linked) toast('Receiver found, but the keyboard is not answering. Press a key to wake it.', 'error', 8000);
      batteryTimer = setInterval(pollBattery, 30000);
    }
    toast(kb.mode === 'usb' ? 'Connected over USB.' : 'Connected through the 2.4G receiver.');
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message || String(e), 'error', 9000);
  } finally {
    busy = false;
    renderConnection();
  }
}

async function detach() {
  clearInterval(batteryTimer);
  battery = null;
  const old = kb;
  kb = null;
  await old?.close().catch(() => {});
  renderConnection();
}

$('connect').onclick = () => attach(() => connect(log));
$('demo-usb').onclick = () => attach(() => connectDemo('usb', log));
$('demo-dongle').onclick = () => attach(() => connectDemo('dongle', log));
$('disconnect').onclick = detach;
$('confirm-model').onchange = updateGates;

if (webHidAvailable()) {
  $('support').textContent = 'This browser supports WebHID. Close the official AULA driver first: only one program can talk to the keyboard at a time.';
  navigator.hid.addEventListener('disconnect', () => {
    if (kb && !kb.demo) {
      detach();
      toast('Keyboard disconnected.', 'error');
    }
  });
  attach(() => reconnect(log));
} else {
  $('support').textContent = 'This browser has no WebHID. Use Chrome, Edge or Opera on a computer to connect a keyboard; the demos work anywhere.';
}

// ------------------------------------------------------------------ tabs

$('tabs').onclick = (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  activeTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  if (tab === 'log') renderLog();
  if (tab !== 'tester') clearDown();
};

// ------------------------------------------------------------------ keyboard view

/** Draws the board into `host`; returns `{ slot: keyElement }`. */
function buildKeyboard(host) {
  const inner = el('div', { className: 'kb-inner' });
  const map = {};
  for (const k of KEYS) {
    const key = el('div', { className: 'key' }, el('div', { className: 'cap' }, el('span', { textContent: k.label })));
    key.dataset.slot = k.slot;
    key.style.setProperty('--x', k.x);
    key.style.setProperty('--y', k.y);
    key.style.setProperty('--w', k.w);
    inner.append(key);
    map[k.slot] = key;
  }
  const knob = el('div', { className: 'key knob' }, el('div', { className: 'cap', textContent: 'knob' }));
  knob.style.setProperty('--x', LAYOUT.knob.x);
  knob.style.setProperty('--y', LAYOUT.knob.y);
  knob.style.setProperty('--w', 1);
  inner.append(knob);
  host.append(inner);
  return map;
}
const slotOf = (target) => Number(target.closest?.('.key')?.dataset.slot) || null;
const KEY_BY_SLOT = Object.fromEntries(KEYS.map((k) => [k.slot, k]));
const LIGHT_INDICES = KEYS.map((k) => k.slot);

// ------------------------------------------------------------------ lighting

const hexOf = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const rgbOf = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

function renderLighting() {
  const L = state.lighting;
  const fx = P.EFFECTS.find((e) => e.id === L.effect) ?? P.EFFECTS[1];
  $('effects').replaceChildren(
    ...P.EFFECTS.map((e) => {
      const b = el('button', { textContent: e.name, type: 'button' });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(e.id === fx.id));
      b.onclick = () => {
        L.effect = e.id;
        if (e.dirs.length && !e.dirs.includes(L.direction)) L.direction = e.dirs[0];
        save();
        renderLighting();
      };
      return b;
    }),
  );
  $('l-color').value = hexOf(L.color);
  $('l-colorful').checked = L.colorful;
  $('l-brightness').value = L.brightness;
  $('l-brightness-out').textContent = `${L.brightness} / ${P.NOVA75.brightnessMax}`;
  $('l-speed').value = L.speed;
  $('l-speed-out').textContent = `${L.speed} / ${P.NOVA75.speedMax}`;
  $('l-direction').replaceChildren(
    ...(fx.dirs.length ? fx.dirs : ['left']).map((d) => el('option', { value: d, textContent: d[0].toUpperCase() + d.slice(1) })),
  );
  $('l-direction').value = fx.dirs.includes(L.direction) ? L.direction : 'left';
  $('f-color').classList.toggle('dim', !fx.color || L.colorful);
  $('f-colorful').style.opacity = fx.color ? 1 : 0.4;
  $('f-speed').classList.toggle('dim', !fx.speed);
  $('f-direction').classList.toggle('dim', !fx.dirs.length);
}
$('l-color').oninput = (e) => ((state.lighting.color = rgbOf(e.target.value)), save());
$('l-colorful').onchange = (e) => ((state.lighting.colorful = e.target.checked), save(), renderLighting());
$('l-brightness').oninput = (e) => ((state.lighting.brightness = Number(e.target.value)), save(), renderLighting());
$('l-speed').oninput = (e) => ((state.lighting.speed = Number(e.target.value)), save(), renderLighting());
$('l-direction').onchange = (e) => ((state.lighting.direction = e.target.value), save());
$('l-apply').onclick = () => run('Applying lighting', () => kb.setLighting(state.lighting), 'Lighting applied.');

// ------------------------------------------------------------------ per-key colours

const colourKeys = buildKeyboard($('kb-colours'));
function paintCap(slot) {
  const cap = colourKeys[slot].firstChild;
  const c = state.perKey[slot];
  if (!c) {
    cap.style.background = '';
    cap.style.color = '';
    return;
  }
  cap.style.background = hexOf(c);
  cap.style.color = c.r * 0.299 + c.g * 0.587 + c.b * 0.114 > 150 ? '#111' : '#fff';
}
const renderColours = () => LIGHT_INDICES.forEach(paintCap);
function paint(slot) {
  if (!slot) return;
  state.perKey[slot] = rgbOf($('c-brush').value);
  paintCap(slot);
}
$('kb-colours').addEventListener('pointerdown', (e) => {
  e.target.releasePointerCapture?.(e.pointerId);
  paint(slotOf(e.target));
});
$('kb-colours').addEventListener('pointerover', (e) => e.buttons & 1 && paint(slotOf(e.target)));
$('kb-colours').addEventListener('pointerup', save);
$('c-swatches').append(
  ...['#ff3b30', '#ff8a3d', '#ffd60a', '#34c759', '#00c7be', '#0a84ff', '#bf5af2', '#ffffff', '#000000'].map((c) => {
    const b = el('button', { type: 'button', title: c });
    b.style.background = c;
    b.setAttribute('aria-label', `Brush ${c}`);
    b.onclick = () => ($('c-brush').value = c);
    return b;
  }),
);
$('c-fill').onclick = () => {
  const c = rgbOf($('c-brush').value);
  LIGHT_INDICES.forEach((n) => (state.perKey[n] = { ...c }));
  save();
  renderColours();
};
$('c-read').onclick = () =>
  run(
    'Reading colours',
    async () => {
      state.perKey = await kb.readPerKey(LIGHT_INDICES);
      save();
      renderColours();
    },
    'Colours read from the keyboard.',
    { write: false },
  );
$('c-write').onclick = () =>
  run(
    'Writing colours',
    async () => {
      const colors = Object.fromEntries(LIGHT_INDICES.map((n) => [n, state.perKey[n] ?? { r: 0, g: 0, b: 0 }]));
      await kb.writePerKey(colors, Number($('c-brightness').value));
    },
    'Per-key colours written.',
  );

// ------------------------------------------------------------------ keys

const mapKeys = buildKeyboard($('kb-keys'));
let layer = 'base';
let selected = null;

function renderKeys() {
  const slots = state.keymap[layer];
  for (const k of KEYS) {
    const key = mapKeys[k.slot];
    const action = slots[k.slot];
    key.classList.toggle('locked', k.usage === 0);
    key.classList.toggle('changed', !!action);
    key.classList.toggle('selected', selected === k.slot);
    key.firstChild.replaceChildren(
      el('span', { textContent: k.label }),
      ...(action ? [el('small', { textContent: describeAction(action) })] : []),
    );
  }
  document.querySelectorAll('#k-layer button').forEach((b) => b.classList.toggle('active', b.dataset.layer === layer));
  $('k-dirty').hidden = !state.dirty[layer];
  renderEditor();
}

function renderEditor() {
  const k = KEY_BY_SLOT[selected];
  $('k-editor').hidden = !k;
  if (!k) return;
  const a = state.keymap[layer][selected] ?? { kind: 'default' };
  $('k-title').textContent = `${k.label} key · ${layer === 'fn' ? 'Fn layer' : 'base layer'}`;
  $('k-kind').value = a.kind;
  $('k-usage-f').hidden = $('k-mods-f').hidden = a.kind !== 'keyboard';
  $('k-media-f').hidden = a.kind !== 'consumer';
  $('k-mouse-f').hidden = a.kind !== 'mouse';
  if (a.kind === 'keyboard') {
    $('k-usage').value = a.usage;
    document.querySelectorAll('#k-mods input').forEach((i) => (i.checked = !!(a.modifiers & Number(i.value))));
  }
  if (a.kind === 'consumer') $('k-media').value = a.usage;
  if (a.kind === 'mouse') $('k-mouse').value = a.action;
}

function editorChanged(kindChanged) {
  const k = KEY_BY_SLOT[selected];
  if (!k) return;
  const kind = $('k-kind').value;
  let action = null;
  if (kind === 'keyboard') {
    const mods = [...document.querySelectorAll('#k-mods input')].reduce((m, i) => m | (i.checked ? Number(i.value) : 0), 0);
    action = { kind, usage: kindChanged ? k.usage || 4 : Number($('k-usage').value), modifiers: kindChanged ? 0 : mods };
  } else if (kind === 'consumer') action = { kind, usage: kindChanged ? MEDIA_OPTIONS[0].usage : Number($('k-media').value) };
  else if (kind === 'mouse') action = { kind, action: kindChanged ? 'left' : $('k-mouse').value };
  else if (kind === 'disabled') action = { kind };
  if (action) state.keymap[layer][selected] = action;
  else delete state.keymap[layer][selected];
  state.dirty[layer] = true;
  save();
  renderKeys();
}

$('k-usage').append(...KEY_OPTIONS.map((o) => el('option', { value: o.usage, textContent: o.label })));
$('k-media').append(...MEDIA_OPTIONS.map((o) => el('option', { value: o.usage, textContent: o.label })));
$('k-mouse').append(...MOUSE_OPTIONS.map((o) => el('option', { value: o.action, textContent: o.label })));
$('k-mods').append(
  ...MODIFIERS.map((m) => el('label', { className: 'check' }, el('input', { type: 'checkbox', value: m.bit }), m.label)),
);
$('k-kind').onchange = () => editorChanged(true);
for (const id of ['k-usage', 'k-media', 'k-mouse', 'k-mods']) $(id).onchange = () => editorChanged(false);
$('kb-keys').onclick = (e) => {
  const slot = slotOf(e.target);
  if (!slot || KEY_BY_SLOT[slot].usage === 0) return;
  selected = slot;
  renderKeys();
};
$('k-layer').onclick = (e) => {
  if (!e.target.dataset.layer) return;
  layer = e.target.dataset.layer;
  renderKeys();
};
$('k-reset').onclick = () => {
  if (!Object.keys(state.keymap[layer]).length) return;
  state.keymap[layer] = {};
  state.dirty[layer] = true;
  save();
  renderKeys();
  toast('Layer cleared on this page. Write it to the keyboard to restore the default keys there.');
};
$('k-write').onclick = () => {
  const target = layer;
  run(
    `Writing the ${target === 'fn' ? 'Fn' : 'base'} layer`,
    async () => {
      await kb.writeKeymap(target, state.keymap[target]);
      state.dirty[target] = false;
      save();
      renderKeys();
    },
    'Layer written to the keyboard.',
  );
};

// ------------------------------------------------------------------ screen

async function prepareScreen() {
  if (!screenFile) return;
  try {
    const { frames, dropped } = await loadFrames(screenFile, { fit: $('s-fit').value, background: $('s-bg').value });
    stopPreview();
    screenFrames = frames;
    stopPreview = preview($('s-canvas'), frames);
    const plan = P.planScreenUpload(frames);
    $('s-info').textContent =
      `${frames.length === 1 ? 'Still image' : `${frames.length} frames`} · ${(plan.total / 1024).toFixed(0)} KB to send` +
      (dropped ? ` · ${dropped} frames past the 107-frame limit were left out` : '');
  } catch (e) {
    screenFrames = [];
    $('s-info').textContent = `Could not read that file: ${e.message}`;
  }
  updateGates();
}
$('s-file').onchange = (e) => {
  screenFile = e.target.files[0] ?? null;
  prepareScreen();
};
$('s-fit').onchange = prepareScreen;
$('s-bg').onchange = prepareScreen;
const drop = $('s-drop');
drop.ondragover = (e) => (e.preventDefault(), drop.classList.add('over'));
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  screenFile = e.dataTransfer.files[0] ?? null;
  prepareScreen();
};
$('s-upload').onclick = () => {
  const frames = screenFrames;
  $('s-progress').hidden = false;
  $('s-bar').style.width = '0';
  run(
    'Uploading to the screen',
    () => kb.uploadScreen(frames, (sent, total) => ($('s-bar').style.width = `${(sent / total) * 100}%`)),
    'Screen updated.',
  ).finally(() => ($('s-progress').hidden = true));
};

// ------------------------------------------------------------------ settings

$('t-sleep').append(...P.SLEEP_OPTIONS.map((o) => el('option', { value: o.value, textContent: o.label })));
$('t-response').append(...P.RESPONSE_OPTIONS.map((o) => el('option', { value: o.value, textContent: o.label })));
const SETTING_INPUTS = {
  't-sleep': ['sleepTime', Number],
  't-response': ['keyResponseTime', Number],
  't-win': ['disableWinKey'],
  't-alttab': ['disableAltTab'],
  't-altf4': ['disableAltF4'],
  't-game': ['gameMode'],
};
for (const [id, [key, cast]] of Object.entries(SETTING_INPUTS)) {
  const input = $(id);
  if (cast) input.value = state.settings[key];
  else input.checked = state.settings[key];
  input.onchange = () => {
    state.settings[key] = cast ? cast(input.value) : input.checked;
    save();
  };
}
$('t-apply').onclick = () => run('Applying settings', () => kb.writeSettings(state.settings), 'Settings applied.');
$('t-clock').onclick = () => run('Syncing the clock', () => kb.syncClock(), 'Clock set to this computer’s time.');

// ------------------------------------------------------------------ tester

const testKeys = buildKeyboard($('kb-tester'));
const SLOT_BY_USAGE = Object.fromEntries(KEYS.filter((k) => k.usage).map((k) => [k.usage, k.slot]));
const TESTABLE = Object.keys(SLOT_BY_USAGE).length;
const tested = new Set();
testKeys[KEYS.find((k) => k.usage === 0).slot].classList.add('locked');

function clearDown() {
  Object.values(testKeys).forEach((k) => k.classList.remove('down'));
}
function testerKey(e, down) {
  if (activeTab !== 'tester') return;
  e.preventDefault();
  // Some keys (F10 on Windows is a system key) can arrive without a usable `code`, or only as a
  // key-up; `key` carries the same name for them, and a key-up counts as registered too.
  const slot = SLOT_BY_USAGE[CODE_TO_USAGE[e.code] ?? CODE_TO_USAGE[e.key]];
  if (!down && slot && !tested.has(slot)) {
    tested.add(slot);
    testKeys[slot].classList.add('tested');
    $('x-count').textContent = `${tested.size} / ${TESTABLE} keys`;
  }
  if (down) $('x-last').textContent = slot ? `Last: ${KEY_BY_SLOT[slot].label}` : `Last: ${e.code} (not on this board's default layout)`;
  if (!slot) return;
  testKeys[slot].classList.toggle('down', down);
  if (down && !tested.has(slot)) {
    tested.add(slot);
    testKeys[slot].classList.add('tested');
    $('x-count').textContent = `${tested.size} / ${TESTABLE} keys`;
  }
}
window.addEventListener('keydown', (e) => testerKey(e, true), true);
window.addEventListener('keyup', (e) => testerKey(e, false), true);
window.addEventListener('blur', clearDown);
$('x-reset').onclick = () => {
  tested.clear();
  Object.values(testKeys).forEach((k) => k.classList.remove('tested', 'down'));
  $('x-count').textContent = `0 / ${TESTABLE} keys`;
  $('x-last').textContent = '';
};
$('x-count').textContent = `0 / ${TESTABLE} keys`;

// ------------------------------------------------------------------ log

let logQueued = false;
function renderLog() {
  logQueued = false;
  const pre = $('g-log');
  pre.textContent = log.entries.length ? log.text() : 'Nothing sent yet.';
  pre.scrollTop = pre.scrollHeight;
}
log.onchange = () => {
  if (activeTab !== 'log' || logQueued) return;
  logQueued = true;
  requestAnimationFrame(renderLog);
};
$('g-clear').onclick = () => log.clear();
$('g-copy').onclick = () =>
  navigator.clipboard.writeText(log.text()).then(
    () => toast('Log copied.'),
    () => toast('Could not copy the log.', 'error'),
  );

// ------------------------------------------------------------------ start

renderLighting();
renderColours();
renderKeys();
renderLog();
renderConnection();
