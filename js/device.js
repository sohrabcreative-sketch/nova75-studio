/**
 * Talks to the keyboard: WebHID pipes, the USB and 2.4 GHz drivers, and a simulated keyboard for
 * demo mode. Transaction order follows the official driver as documented by OpenKey (see NOTICE.md).
 */
import * as P from './protocol.js';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ------------------------------------------------------------------ packet log

export class PacketLog {
  constructor(limit = 600) {
    this.limit = limit;
    this.entries = [];
    this.onchange = null;
  }
  add(dir, kind, bytes, note = '') {
    this.entries.push({ t: Date.now(), dir, kind, hex: P.toHex(bytes, 64), note });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.onchange?.();
  }
  clear() {
    this.entries = [];
    this.onchange?.();
  }
  text() {
    return this.entries
      .map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.dir} ${e.kind.padEnd(8)} ${e.hex}${e.note ? `  # ${e.note}` : ''}`)
      .join('\n');
  }
}

const describe = (p) => (p[0] === 0x04 && P.CMD_NAMES[p[1]] ? P.CMD_NAMES[p[1]] : '');

// ------------------------------------------------------------------ WebHID pipe

/** Largest report of a list, in bytes (WebHID gives sizes in bits per item). */
export function reportBytes(reports = []) {
  let max = 0;
  for (const r of reports) {
    let bits = 0;
    for (const it of r.items ?? []) bits += (it.reportSize ?? 0) * (it.reportCount ?? 0);
    max = Math.max(max, Math.ceil(bits / 8));
  }
  return max;
}

function findCollection(device, test) {
  return device.collections?.find(test);
}

class HidPipe {
  constructor(device, log, name) {
    this.device = device;
    this.log = log;
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.onInput = (e) => {
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
      this.log.add('←', 'input', bytes, this.name);
      const w = this.waiters.shift();
      if (w) w(bytes);
      else this.queue.push(bytes);
    };
  }
  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onInput);
  }
  async close() {
    this.device.removeEventListener('inputreport', this.onInput);
    if (this.device.opened) await this.device.close().catch(() => {});
  }
  async sendFeature(packet) {
    this.log.add('→', 'feature', packet, describe(packet));
    await this.device.sendFeatureReport(0, packet);
  }
  async getFeature() {
    const view = await this.device.receiveFeatureReport(0);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    // Some platforms prepend the (zero) report ID.
    if (bytes.length === P.PACKET + 1 && bytes[0] === 0) bytes = bytes.slice(1);
    this.log.add('←', 'feature', bytes);
    return bytes;
  }
  async sendOutput(bytes) {
    this.log.add('→', 'output', bytes, this.name);
    await this.device.sendReport(0, bytes);
  }
  drain() {
    this.queue.length = 0;
  }
  waitInput(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      const w = (bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      this.waiters.push(w);
    });
  }
}

// ------------------------------------------------------------------ simulated keyboard

class DemoControl {
  constructor(log) {
    this.log = log;
    this.last = new Uint8Array(P.PACKET);
    this.reads = [];
    this.expect = null;
    this.perKey = new Uint8Array(P.TABLE_BYTES);
    for (let n = 1; n < P.TABLE_SLOTS - 1; n++) this.perKey.set([n, 0, 150, 255], n * 4);
  }
  async open() {}
  async close() {}
  async sendFeature(packet) {
    this.log.add('→', 'feature', packet, describe(packet));
    if (packet[0] === 0x04 && P.CMD_NAMES[packet[1]]) {
      this.last = packet.slice();
      this.last[3] = 0x01;
      this.expect = null;
      if (packet[1] === P.Cmd.PER_KEY_RGB) this.expect = { left: packet[8], buf: [] };
      if (packet[1] === P.Cmd.READ_PER_KEY_RGB) {
        this.reads = [this.last.slice()];
        for (let i = 0; i < packet[8]; i++)
          this.reads.push(this.perKey.slice(i * P.PACKET, (i + 1) * P.PACKET));
      }
    } else if (this.expect) {
      this.expect.buf.push(...packet);
      if (--this.expect.left === 0) {
        this.perKey = Uint8Array.from(this.expect.buf);
        this.perKey[574] = this.perKey[575] = 0; // hardware read-back has no trailer
        for (let n = 0; n < P.TABLE_SLOTS; n++) this.perKey[n * 4] = n;
        this.expect = null;
      }
    }
  }
  async getFeature() {
    const bytes = this.reads.length ? this.reads.shift() : this.last.slice();
    this.log.add('←', 'feature', bytes);
    return bytes;
  }
}

class DemoData {
  constructor(log) {
    this.log = log;
  }
  async open() {}
  async close() {}
  async sendOutput(bytes) {
    this.log.add('→', 'output', bytes, 'screen data');
  }
  drain() {}
  async waitInput() {
    return new Uint8Array(P.PACKET);
  }
}

class DemoDongle {
  constructor(log) {
    this.log = log;
    this.pending = [];
  }
  async open() {}
  async close() {}
  async sendOutput(bytes) {
    this.log.add('→', 'output', bytes, 'receiver');
    if (bytes[0] === 0x20 && bytes[1] === 0x01) {
      const pong = new Uint8Array(P.DONGLE_BYTES);
      pong.set([0x20, 0x01, 0x00, 82]);
      this.pending.push(pong);
    }
  }
  drain() {
    this.pending.length = 0;
  }
  async waitInput() {
    const r = this.pending.shift() ?? null;
    if (r) this.log.add('←', 'input', r, 'receiver');
    return r;
  }
}

// ------------------------------------------------------------------ drivers

/** One transaction at a time per keyboard. */
class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

export class UsbKeyboard {
  mode = 'usb';
  constructor({ control, data, productName, demo = false }) {
    this.control = control;
    this.data = data;
    this.productName = productName;
    this.demo = demo;
    this.delay = demo ? 2 : P.CMD_DELAY_MS;
    this.mutex = new Mutex();
    /** True when the USB product string is the one the official NOVA75 driver looks for. */
    this.recognised = productName.trim() === P.NOVA75.usb.productName;
  }
  get hasScreenPipe() {
    return !!this.data;
  }

  async open() {
    await this.control.open();
    await this.data?.open();
  }
  async close() {
    await this.control.close();
    await this.data?.close();
  }

  async send(packet, handshake) {
    await sleep(this.delay);
    await this.control.sendFeature(packet);
    if (!handshake) return null;
    await sleep(this.delay);
    return this.control.getFeature();
  }

  /** `04 <cmd> …`, then read the acknowledgement; throws when the keyboard does not confirm. */
  async command(cmd, args = {}, { handshake = true } = {}) {
    let resp = await this.send(P.commandPacket(cmd, args), handshake);
    if (!handshake) return;
    let ack = P.parseAck(resp, cmd);
    if (ack.busy) {
      await sleep(this.delay);
      resp = await this.control.getFeature();
      ack = P.parseAck(resp, cmd);
    }
    if (!ack.ok)
      throw new Error(
        `The keyboard did not acknowledge ${P.CMD_NAMES[cmd] ?? cmd.toString(16)} (reply: ${P.toHex(resp, 8)})`,
      );
  }

  async sendTable(buffer) {
    await sleep(this.delay);
    for (let off = 0; off < buffer.length; off += P.PACKET) {
      const pkt = buffer.slice(off, off + P.PACKET);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.control.sendFeature(pkt);
          break;
        } catch (e) {
          if (attempt >= 9) throw e;
          await sleep(this.delay);
        }
      }
      await sleep(this.delay);
    }
  }

  /** START is the first packet of every official transaction and writes nothing. */
  handshake() {
    return this.mutex.run(() => this.command(P.Cmd.START));
  }

  setLighting(cfg) {
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      await this.command(P.Cmd.LIGHT_MODE, { arg8: 1 });
      await this.send(P.lightingPacket(cfg), false);
      await this.command(P.Cmd.SAVE);
      await this.command(P.Cmd.FINISH, {}, { handshake: false });
    });
  }

  /** The per-key colour table is the only configuration this firmware lets you read back. */
  readPerKey(indices) {
    return this.mutex.run(async () => {
      await sleep(3);
      await this.control.sendFeature(P.commandPacket(P.Cmd.READ_PER_KEY_RGB, { arg8: P.TABLE_PACKETS }));
      await sleep(5);
      const ack = P.parseAck(await this.control.getFeature(), P.Cmd.READ_PER_KEY_RGB);
      if (!ack.ok) throw new Error('The keyboard did not acknowledge the colour read');
      const table = new Uint8Array(P.TABLE_BYTES);
      for (let i = 0; i < P.TABLE_PACKETS; i++) {
        await sleep(3);
        const part = await this.control.getFeature();
        if (part.length !== P.PACKET) throw new Error(`Short read (${part.length} bytes)`);
        table.set(part, i * P.PACKET);
      }
      await this.command(P.Cmd.SAVE); // the official driver follows the read with SAVE
      if (!P.perKeyTableLooksValid(table, indices))
        throw new Error('The colour table read from the keyboard does not look like one');
      return P.decodePerKeyTable(table, indices);
    });
  }

  writePerKey(colors, brightness) {
    const table = P.perKeyTable(colors);
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      await this.command(P.Cmd.LIGHT_MODE, { arg8: 1 });
      await this.send(P.customModePacket(brightness), false);
      await this.command(P.Cmd.SAVE);
      await this.command(P.Cmd.FINISH, {}, { handshake: false });
      await this.command(P.Cmd.START);
      await this.command(P.Cmd.PER_KEY_RGB, { arg8: P.TABLE_PACKETS });
      await this.sendTable(table);
      await this.command(P.Cmd.SAVE);
      await this.command(P.Cmd.FINISH);
    });
  }

  /** `layer` is 'base' or 'fn'; `slots` is `{ slot: action }`, missing slots keep the default. */
  writeKeymap(layer, slots) {
    const table = P.keymapTable(slots);
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      await this.command(layer === 'fn' ? P.Cmd.KEYMAP_FN : P.Cmd.KEYMAP_BASE, { arg8: P.TABLE_PACKETS });
      await this.sendTable(table);
      await this.command(P.Cmd.SAVE);
      await this.command(P.Cmd.FINISH);
    });
  }

  writeSettings(settings) {
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      await this.command(P.Cmd.SETTINGS, { sub: 1, arg8: 1 });
      await this.send(P.settingsPacket(settings), false);
      await this.command(P.Cmd.SAVE);
    });
  }

  syncClock(date = new Date()) {
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      await this.command(P.Cmd.TIME, { arg8: 1 });
      await this.send(P.timePacket(date), true);
      await this.command(P.Cmd.SAVE);
    });
  }

  /** `frames` is `[{ pixels, delayMs }]`; `onProgress(sent, total)` fires per 4096-byte chunk. */
  uploadScreen(frames, onProgress) {
    if (!this.data) throw new Error('The screen data interface (FF68) is not available');
    const plan = P.planScreenUpload(frames);
    return this.mutex.run(async () => {
      await this.command(P.Cmd.START);
      const resp = await this.send(P.imageCommand(plan.chunks), true);
      if (!P.parseAck(resp, P.Cmd.IMAGE).ok) throw new Error('The keyboard rejected the image header');
      let sent = 0;
      this.data.drain();
      for (const chunk of P.screenChunks(frames, plan)) {
        await this.data.sendOutput(chunk);
        // The official driver waits for this report and ignores its content.
        await this.data.waitInput(this.demo ? 0 : P.DATA_ACK_TIMEOUT_MS);
        onProgress?.(++sent, plan.chunks);
      }
      await this.command(P.Cmd.SAVE);
    });
  }
}

export class DongleKeyboard {
  mode = 'dongle';
  recognised = true;
  hasScreenPipe = false;
  constructor({ pipe, productName, demo = false }) {
    this.pipe = pipe;
    this.productName = productName;
    this.demo = demo;
    this.mutex = new Mutex();
  }
  async open() {
    await this.pipe.open();
  }
  async close() {
    await this.pipe.close();
  }

  /** Ping `20 01`; the answer carries the battery percentage. Null when the keyboard is asleep. */
  battery() {
    return this.mutex.run(async () => {
      this.pipe.drain();
      await this.pipe.sendOutput(P.donglePacket(P.DONGLE_PING));
      for (let i = 0; i < 10; i++) {
        const r = await this.pipe.waitInput(100);
        if (!r) continue;
        if (r[0] === P.DONGLE_PING[0] && r[1] === P.DONGLE_PING[1])
          return { linked: true, level: P.batteryFromPong(r) };
      }
      return { linked: false, level: null };
    });
  }

  async handshake() {
    const b = await this.battery();
    if (!b.linked) throw new Error('The receiver did not answer the ping (keyboard asleep or switched off?)');
  }

  setLighting(cfg) {
    return this.mutex.run(async () => {
      await this.pipe.sendOutput(P.dongleLightingPreamble());
      await sleep(this.demo ? 0 : P.DONGLE_PREAMBLE_MS);
      await this.pipe.sendOutput(P.dongleLightingPacket(cfg));
    });
  }

  writeSettings(settings) {
    return this.mutex.run(() => this.pipe.sendOutput(P.dongleSettingsPacket(settings)));
  }
}

// ------------------------------------------------------------------ connecting

export const webHidAvailable = () => typeof navigator !== 'undefined' && 'hid' in navigator;

const FILTERS = [
  { vendorId: P.NOVA75.usb.vendorId, productId: P.NOVA75.usb.productId },
  { vendorId: P.NOVA75.dongle.vendorId, productId: P.NOVA75.dongle.productId },
];
const isOurs = (d) => FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);

/** Builds a driver from the HID interfaces of one physical device, or returns null. */
async function driverFor(devices, log) {
  const usb = devices.filter((d) => d.vendorId === P.NOVA75.usb.vendorId);
  const controlDev = usb.find((d) =>
    findCollection(
      d,
      (c) =>
        c.usagePage === P.NOVA75.control.usagePage &&
        c.usage === P.NOVA75.control.usage &&
        reportBytes(c.featureReports) === P.PACKET,
    ),
  );
  if (controlDev) {
    const dataDev = usb.find((d) =>
      findCollection(
        d,
        (c) =>
          c.usagePage === P.NOVA75.data.usagePage &&
          c.usage === P.NOVA75.data.usage &&
          reportBytes(c.outputReports) === P.CHUNK,
      ),
    );
    const kb = new UsbKeyboard({
      control: new HidPipe(controlDev, log, 'control'),
      data: dataDev ? new HidPipe(dataDev, log, 'screen data') : null,
      productName: controlDev.productName ?? '',
    });
    await kb.open();
    return kb;
  }

  // 2.4 GHz receiver: a vendor collection with a 32-byte output report. If several interfaces
  // qualify, the one that answers the ping is the command interface.
  const candidates = devices.filter(
    (d) =>
      d.vendorId === P.NOVA75.dongle.vendorId &&
      findCollection(
        d,
        (c) => c.usagePage >= 0xff00 && c.usagePage !== 0xffff && reportBytes(c.outputReports) === P.DONGLE_BYTES,
      ),
  );
  let fallback = null;
  for (const d of candidates) {
    const kb = new DongleKeyboard({ pipe: new HidPipe(d, log, 'receiver'), productName: d.productName ?? '' });
    try {
      await kb.open();
      if ((await kb.battery()).linked) {
        if (fallback) await fallback.close();
        return kb;
      }
    } catch {
      /* try the next interface */
    }
    if (fallback) await kb.close();
    else fallback = kb;
  }
  return fallback;
}

/** Reconnects to a keyboard the browser already has permission for, without a prompt. */
export async function reconnect(log) {
  if (!webHidAvailable()) return null;
  const granted = (await navigator.hid.getDevices()).filter(isOurs);
  return granted.length ? driverFor(granted, log) : null;
}

/** Shows the browser's device chooser (must be called from a click). */
export async function connect(log) {
  const picked = await navigator.hid.requestDevice({ filters: FILTERS });
  if (!picked.length) return null;
  // The chooser returns the interfaces of the entry picked; add already-granted sibling interfaces.
  const all = (await navigator.hid.getDevices()).filter(
    (d) => d.vendorId === picked[0].vendorId && d.productId === picked[0].productId,
  );
  const kb = await driverFor(all.length ? all : picked, log);
  if (!kb)
    throw new Error(
      'That device has no interface this app understands. Is it a NOVA75 on its USB cable or 2.4G receiver?',
    );
  return kb;
}

export async function connectDemo(mode, log) {
  const kb =
    mode === 'dongle'
      ? new DongleKeyboard({ pipe: new DemoDongle(log), productName: '2.4G Dongle (demo)', demo: true })
      : new UsbKeyboard({
          control: new DemoControl(log),
          data: new DemoData(log),
          productName: P.NOVA75.usb.productName,
          demo: true,
        });
  await kb.open();
  return kb;
}
