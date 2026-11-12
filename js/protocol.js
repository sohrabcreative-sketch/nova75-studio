/**
 * AULA NOVA75 wire protocol: pure packet builders and parsers, no I/O.
 *
 * The NOVA75 speaks the "AJAZZ Windows-driver" protocol over USB (0C45:800A, product string
 * "AULA-NOVA75") and a 32-byte receiver protocol over its 2.4 GHz dongle (05AC:024F).
 *
 * Protocol knowledge is ported from the OpenKey project (MIT, © 2026 Bakul Ahmed and OpenKey
 * contributors): docs/protocol/sonix-feature.md, packages/protocols/src/families/sonix-feature and
 * families/minor/sonix-dongle.ts. See NOTICE.md.
 */

export const PACKET = 64;
export const CHUNK = 4096;

/** NOVA75 parameters from the official driver's layout file, as recorded by OpenKey. */
export const NOVA75 = {
  usb: { vendorId: 0x0c45, productId: 0x800a, productName: 'AULA-NOVA75' },
  dongle: { vendorId: 0x05ac, productId: 0x024f, productName: '2.4G Dongle' },
  control: { usagePage: 0xff13, usage: 0x01 },
  data: { usagePage: 0xff68, usage: 0x61 },
  screen: { width: 240, height: 135, maxFrames: 107 },
  brightnessMax: 6,
  speedMax: 6,
};

export const Cmd = {
  SAVE: 0x02,
  KEYMAP_BASE: 0x11,
  LIGHT_MODE: 0x13,
  SETTINGS: 0x17,
  START: 0x18,
  PER_KEY_RGB: 0x23,
  KEYMAP_FN: 0x27,
  TIME: 0x28,
  IMAGE: 0x72,
  FINISH: 0xf0,
  READ_PER_KEY_RGB: 0xf5,
};
export const CMD_NAMES = Object.fromEntries(Object.entries(Cmd).map(([k, v]) => [v, k]));

/** Delay the official driver sleeps before every feature transfer. */
export const CMD_DELAY_MS = 35;
export const DATA_ACK_TIMEOUT_MS = 300;

export const TABLE_BYTES = 576; // 144 slots × 4 bytes = 9 packets
export const TABLE_PACKETS = TABLE_BYTES / PACKET;
export const TABLE_SLOTS = TABLE_BYTES / 4;
export const CUSTOM_EFFECT = 0x80; // lighting effect id that shows the per-key table

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// ------------------------------------------------------------------ framing

/** `04 <cmd> <sub> 00 00 00 00 00 <arg8> <arg9> 00…` */
export function commandPacket(cmd, { sub = 0, arg8 = 0, arg9 = 0 } = {}) {
  const p = new Uint8Array(PACKET);
  p[0] = 0x04;
  p[1] = cmd & 0xff;
  p[2] = sub & 0xff;
  p[8] = arg8 & 0xff;
  p[9] = arg9 & 0xff;
  return p;
}

/**
 * The keyboard acknowledges a command by echoing it with byte 3 = 01. A reply that does not echo
 * the command may be the stale echo of an earlier one, so it does not count.
 */
export function parseAck(resp, cmd) {
  const status = resp[3];
  const echoes = resp[0] === 0x04 && resp[1] === cmd;
  return { ok: status === 0x01 && echoes, busy: status === 0xff, echoes, status };
}

export function withTrailer(buf, at = buf.length - 2) {
  buf[at] = 0xaa;
  buf[at + 1] = 0x55;
  return buf;
}

// ------------------------------------------------------------------ lighting

/** Effect ids of this firmware family; names from the official driver's language table. */
export const EFFECTS = [
  { id: 0, name: 'Off', color: false, speed: false, dirs: [] },
  { id: 1, name: 'Static', color: true, speed: false, dirs: [] },
  { id: 2, name: 'Single On', color: true, speed: true, dirs: [] },
  { id: 3, name: 'Single Off', color: true, speed: true, dirs: [] },
  { id: 4, name: 'Glittering', color: true, speed: true, dirs: [] },
  { id: 5, name: 'Falling', color: true, speed: true, dirs: [] },
  { id: 6, name: 'Colourful', color: false, speed: true, dirs: [] },
  { id: 7, name: 'Breath', color: true, speed: true, dirs: [] },
  { id: 8, name: 'Spectrum', color: false, speed: true, dirs: [] },
  { id: 9, name: 'Outward', color: true, speed: true, dirs: [] },
  { id: 10, name: 'Scrolling', color: true, speed: true, dirs: ['left', 'right', 'up', 'down'] },
  { id: 11, name: 'Rolling', color: true, speed: true, dirs: ['left', 'right'] },
  { id: 12, name: 'Rotating', color: true, speed: true, dirs: ['left', 'right'] },
  { id: 13, name: 'Explode', color: true, speed: true, dirs: [] },
  { id: 14, name: 'Launch', color: true, speed: true, dirs: [] },
  { id: 15, name: 'Ripples', color: true, speed: true, dirs: [] },
  { id: 16, name: 'Flowing', color: true, speed: true, dirs: ['left', 'right'] },
  { id: 17, name: 'Pulsating', color: true, speed: true, dirs: [] },
  { id: 18, name: 'Tilt', color: true, speed: true, dirs: ['left', 'right'] },
  { id: 19, name: 'Shuttle', color: true, speed: true, dirs: ['left', 'right'] },
];
export const DIRECTIONS = { left: 0, right: 1, up: 2, down: 3 };

export const DEFAULT_LIGHTING = {
  effect: 11,
  color: { r: 255, g: 255, b: 255 },
  colorful: true,
  brightness: NOVA75.brightnessMax,
  speed: 3,
  direction: 'left',
};

/** `[0]=effect [1..3]=RGB [8]=colourful [9]=brightness [10]=speed [11]=direction [14..15]=AA 55` */
export function lightingPacket(cfg) {
  const p = new Uint8Array(PACKET);
  p[0] = cfg.effect & 0xff;
  p[1] = clamp(cfg.color.r, 0, 255);
  p[2] = clamp(cfg.color.g, 0, 255);
  p[3] = clamp(cfg.color.b, 0, 255);
  p[8] = cfg.colorful ? 1 : 0;
  p[9] = clamp(cfg.brightness, 0, NOVA75.brightnessMax);
  p[10] = clamp(cfg.speed, 0, NOVA75.speedMax);
  p[11] = DIRECTIONS[cfg.direction] ?? 0;
  return withTrailer(p, 14);
}

/**
 * Switches the keyboard to the per-key table. Byte 9 is the brightness of that mode: left at zero the
 * keys go dark. Layout as sent by parsiya/f108-pro (MIT), verified there on the AULA F108 Pro.
 */
export function customModePacket(brightness = NOVA75.brightnessMax) {
  const p = new Uint8Array(PACKET);
  p[0] = CUSTOM_EFFECT;
  p[9] = clamp(brightness, 1, NOVA75.brightnessMax);
  return withTrailer(p, 14);
}

/** Per-key table: entry n = `[n, R, G, B]`, trailer at 574. `colors` is `{ lightIndex: {r,g,b} }`. */
export function perKeyTable(colors) {
  const buf = new Uint8Array(TABLE_BYTES);
  for (const [k, c] of Object.entries(colors)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n <= 0 || n >= TABLE_SLOTS - 1) continue;
    buf.set([n, c.r & 0xff, c.g & 0xff, c.b & 0xff], n * 4);
  }
  return withTrailer(buf);
}

export function decodePerKeyTable(buf, indices) {
  const out = {};
  for (const n of indices) {
    if (n * 4 + 3 >= buf.length) continue;
    out[n] = { r: buf[n * 4 + 1], g: buf[n * 4 + 2], b: buf[n * 4 + 3] };
  }
  return out;
}

/** A table read back from hardware carries n (or 0 for never-written entries) in byte 0 of entry n. */
export function perKeyTableLooksValid(buf, indices) {
  return indices.length > 0 && indices.every((n) => buf[n * 4] === n || buf[n * 4] === 0);
}

// ------------------------------------------------------------------ keymap

export const MOUSE = {
  left: [1, 0x01],
  right: [1, 0x02],
  middle: [1, 0x04],
  back: [1, 0x08],
  forward: [1, 0x10],
  'wheel-up': [3, 0x01],
  'wheel-down': [3, 0xff],
};

/**
 * 4-byte key slot. Actions:
 *   { kind: 'default' }                       firmware default
 *   { kind: 'keyboard', usage, modifiers }    HID usage with modifier bitmask
 *   { kind: 'consumer', usage }               media key
 *   { kind: 'mouse', action }                 see MOUSE
 *   { kind: 'disabled' }
 */
export function encodeSlot(a) {
  switch (a.kind) {
    case 'default':
      return [0, 0, 0, 0];
    case 'keyboard': {
      const mods = (a.modifiers ?? 0) & 0xff;
      // A bare modifier key is sent as its modifier bit with usage 0.
      if (a.usage >= 0xe0 && a.usage <= 0xe7 && mods === 0) return [2, 1 << (a.usage - 0xe0), 0, 0];
      return [2, mods, a.usage & 0xff, 0];
    }
    case 'consumer':
      return [3, a.usage & 0xff, (a.usage >> 8) & 0xff, 0];
    case 'mouse': {
      const m = MOUSE[a.action];
      if (!m) throw new Error(`Unknown mouse action "${a.action}"`);
      return [1, m[0], m[1], 0];
    }
    case 'disabled':
      return [5, 3, 0, 0];
    default:
      throw new Error(`Key action "${a.kind}" has no encoding`);
  }
}

export function decodeSlot(bytes) {
  const [p = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
  if (!p && !b1 && !b2 && !b3) return { kind: 'default' };
  if (p === 2) {
    if (b2 === 0 && b1 !== 0 && (b1 & (b1 - 1)) === 0)
      return { kind: 'keyboard', usage: 0xe0 + Math.log2(b1), modifiers: 0 };
    return { kind: 'keyboard', usage: b2, modifiers: b1 };
  }
  if (p === 3) return { kind: 'consumer', usage: b1 | (b2 << 8) };
  if (p === 1) {
    const hit = Object.entries(MOUSE).find(([, [k, v]]) => k === b1 && v === b2);
    if (hit) return { kind: 'mouse', action: hit[0] };
  }
  if (p === 5 && b1 === 3) return { kind: 'disabled' };
  return { kind: 'raw', bytes: [p, b1, b2, b3] };
}

/** 576-byte keymap table: zero = firmware default, trailer at 574. `slots` is `{ slot: action }`. */
export function keymapTable(slots) {
  const buf = new Uint8Array(TABLE_BYTES);
  for (const [k, action] of Object.entries(slots)) {
    const slot = Number(k);
    if (!Number.isInteger(slot) || slot < 0 || slot >= TABLE_SLOTS - 1)
      throw new Error(`Keymap slot ${k} is out of range`);
    buf.set(encodeSlot(action), slot * 4);
  }
  return withTrailer(buf);
}

// ------------------------------------------------------------------ settings and clock

export const SLEEP_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 1, label: '1 minute' },
  { value: 2, label: '5 minutes' },
  { value: 3, label: '30 minutes' },
];
export const RESPONSE_OPTIONS = [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `Level ${v}` }));

export const DEFAULT_SETTINGS = {
  sleepTime: 0,
  keyResponseTime: 1,
  fnSwitch: 0,
  disableWinKey: false,
  disableAltTab: false,
  disableAltF4: false,
  gameMode: false,
};

/** `[1]=01 [2]=no Alt+Tab [3]=no Alt+F4 [4]=no Win [5]=fn switch [6]=sleep [8]=key response [62..63]=AA 55` */
export function settingsPacket(s) {
  const v = { ...DEFAULT_SETTINGS, ...s };
  const p = new Uint8Array(PACKET);
  p[1] = 0x01;
  p[2] = v.disableAltTab ? 1 : 0;
  p[3] = v.disableAltF4 ? 1 : 0;
  p[4] = v.disableWinKey ? 1 : 0;
  p[5] = v.fnSwitch ? 1 : 0;
  p[6] = clamp(v.sleepTime, 0, 3);
  p[8] = clamp(v.keyResponseTime, 1, 5);
  return withTrailer(p);
}

/** `[1]=slot [2]=5A [3]=year-2000 [4]=month [5]=day [6]=h [7]=m [8]=s [10]=weekday [62..63]=AA 55` */
export function timePacket(d, slot = 1) {
  const p = new Uint8Array(PACKET);
  p[1] = slot & 0xff;
  p[2] = 0x5a;
  p[3] = d.getFullYear() % 2000 & 0xff;
  p[4] = d.getMonth() + 1;
  p[5] = d.getDate();
  p[6] = d.getHours();
  p[7] = d.getMinutes();
  p[8] = d.getSeconds();
  p[10] = d.getDay();
  return withTrailer(p);
}

// ------------------------------------------------------------------ screen

export const TFT_HEADER_BYTES = 256;

export function pack565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

/** RGBA bytes → RGB565 little endian (low byte first), row-major. */
export function toRgb565le(rgba, width, height) {
  const out = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const v = pack565(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = v >> 8;
  }
  return out;
}

/** What the panel will show for a frame, as RGBA. */
export function fromRgb565le(pixels, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = pixels[i * 2] | (pixels[i * 2 + 1] << 8);
    const r = (v >> 11) & 0x1f;
    const g = (v >> 5) & 0x3f;
    const b = v & 0x1f;
    data.set([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255], i * 4);
  }
  return data;
}

/** Frame delay in the header's 2 ms units (one byte, at least 1). */
export function encodeDelay(ms) {
  const units = Math.trunc(ms / 2);
  return units > 1 ? Math.min(255, units) : 1;
}

/**
 * Upload plan: a 256-byte header (0xFF filled; [0] = frame count; [1+i] = delay) followed by the
 * frames, padded with 0xFF to whole 4096-byte chunks. `frames` is `[{ pixels, delayMs }]`.
 * More frames than the model's cap are refused: on a sibling board an over-long animation
 * overwrote the keyboard's built-in menu graphics.
 */
export function planScreenUpload(frames, { width, height, maxFrames } = NOVA75.screen) {
  if (!frames.length) throw new Error('No frames to upload');
  if (frames.length > maxFrames)
    throw new Error(`Too many frames: ${frames.length} (this screen takes at most ${maxFrames})`);
  const frameBytes = width * height * 2;
  for (const f of frames)
    if (f.pixels.length !== frameBytes)
      throw new Error(`Frame must be ${frameBytes} bytes (got ${f.pixels.length})`);
  const header = new Uint8Array(TFT_HEADER_BYTES).fill(0xff);
  header[0] = frames.length;
  frames.forEach((f, i) => (header[1 + i] = encodeDelay(f.delayMs)));
  const total = TFT_HEADER_BYTES + frames.length * frameBytes;
  return { header, frameBytes, total, chunks: Math.ceil(total / CHUNK) };
}

/** Yields the 4096-byte chunks of an upload one at a time. */
export function* screenChunks(frames, plan) {
  for (let c = 0; c < plan.chunks; c++) {
    const chunk = new Uint8Array(CHUNK).fill(0xff);
    const base = c * CHUNK;
    let i = 0;
    while (i < CHUNK) {
      const pos = base + i;
      if (pos >= plan.total) break;
      if (pos < TFT_HEADER_BYTES) {
        const n = Math.min(CHUNK - i, TFT_HEADER_BYTES - pos);
        chunk.set(plan.header.subarray(pos, pos + n), i);
        i += n;
      } else {
        const off = pos - TFT_HEADER_BYTES;
        const within = off % plan.frameBytes;
        const n = Math.min(CHUNK - i, plan.frameBytes - within);
        chunk.set(frames[Math.floor(off / plan.frameBytes)].pixels.subarray(within, within + n), i);
        i += n;
      }
    }
    yield chunk;
  }
}

/** `04 72 <slot> … <chunks lo> <chunks hi>` */
export function imageCommand(chunks, slot = 1) {
  return commandPacket(Cmd.IMAGE, { sub: slot, arg8: chunks & 0xff, arg9: (chunks >> 8) & 0xff });
}

// ------------------------------------------------------------------ 2.4 GHz receiver

export const DONGLE_BYTES = 32;
export const DONGLE_PING = [0x20, 0x01];
export const DONGLE_PREAMBLE_MS = 50;

/** 32-byte report; byte 31 is the additive checksum of bytes 0–30. */
export function donglePacket(bytes) {
  const p = new Uint8Array(DONGLE_BYTES);
  p.set(bytes.slice(0, DONGLE_BYTES - 1));
  let s = 0;
  for (let i = 0; i < DONGLE_BYTES - 1; i++) s += p[i];
  p[DONGLE_BYTES - 1] = s & 0xff;
  return p;
}

/** Battery percentage is byte 3 of the ping answer (0 = unknown). */
export function batteryFromPong(r) {
  if (r[0] !== DONGLE_PING[0] || r[1] !== DONGLE_PING[1]) return null;
  return r[3] ? Math.min(100, r[3]) : null;
}

/** Sent 50 ms before each lighting packet on AULA receivers. */
export function dongleLightingPreamble() {
  return donglePacket([0x0f]);
}

/** `05 10 00 effect R G B … [11]=colourful [12]=brightness [13]=speed [14]=direction … [17..18]=AA 55` */
export function dongleLightingPacket(cfg) {
  const b = new Array(DONGLE_BYTES - 1).fill(0);
  b[0] = 0x05;
  b[1] = 0x10;
  b[3] = cfg.effect & 0xff;
  if (cfg.effect !== 0) {
    b[4] = clamp(cfg.color.r, 0, 255);
    b[5] = clamp(cfg.color.g, 0, 255);
    b[6] = clamp(cfg.color.b, 0, 255);
    b[11] = cfg.colorful ? 1 : 0;
    b[12] = clamp(cfg.brightness, 0, NOVA75.brightnessMax);
    b[13] = clamp(cfg.speed, 0, NOVA75.speedMax);
    b[14] = DIRECTIONS[cfg.direction] ?? 0;
  }
  b[17] = 0xaa;
  b[18] = 0x55;
  return donglePacket(b);
}

/**
 * `07 10 00 00 01 01 01 01 [8]=fn switch [9]=sleep [11]=key response [12]=game mode
 *  [13]=no Alt+Tab [14]=no Alt+F4 [15]=no Win … [17..18]=AA 55`
 * Game mode sets the three locks together, as the reference implementation sends it.
 */
export function dongleSettingsPacket(s) {
  const v = { ...DEFAULT_SETTINGS, ...s };
  const b = new Array(DONGLE_BYTES - 1).fill(0);
  b.splice(0, 8, 0x07, 0x10, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01);
  const game = v.gameMode ? 1 : 0;
  b[8] = 1;
  b[9] = clamp(v.sleepTime, 0, 3);
  b[11] = clamp(v.keyResponseTime, 1, 5);
  b[12] = b[13] = b[14] = b[15] = game;
  b[17] = 0xaa;
  b[18] = 0x55;
  return donglePacket(b);
}

export function toHex(bytes, max = Infinity) {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + bytes[i].toString(16).padStart(2, '0');
  return bytes.length > n ? `${s} … (${bytes.length} bytes)` : s;
}
