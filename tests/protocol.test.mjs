// Checks the packet builders against the byte sequences published in OpenKey's fixtures
// (fixtures/rgb, keymap, tft, device-info: traced from the official driver) and runs every
// transaction end to end against the simulated keyboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/protocol.js';
import { PacketLog, connectDemo } from '../js/device.js';
import { KEYS } from '../js/layout.js';

const hex = (b) => P.toHex(b);
const pad = (s, n = 64) => {
  const parts = s.split(' ');
  while (parts.length < n) parts.push('00');
  return parts.join(' ');
};

test('command packets', () => {
  assert.equal(hex(P.commandPacket(P.Cmd.START)), pad('04 18'));
  assert.equal(hex(P.commandPacket(P.Cmd.LIGHT_MODE, { arg8: 1 })), pad('04 13 00 00 00 00 00 00 01'));
  assert.equal(hex(P.commandPacket(P.Cmd.KEYMAP_BASE, { arg8: 9 })), pad('04 11 00 00 00 00 00 00 09'));
  assert.equal(hex(P.commandPacket(P.Cmd.SAVE)), pad('04 02'));
  assert.equal(hex(P.commandPacket(P.Cmd.FINISH)), pad('04 f0'));
});

test('acknowledgement must echo the command', () => {
  const ack = Uint8Array.from([0x04, 0x18, 0x00, 0x01]);
  assert.equal(P.parseAck(ack, P.Cmd.START).ok, true);
  assert.equal(P.parseAck(ack, P.Cmd.SAVE).ok, false); // stale echo of another command
  assert.equal(P.parseAck(new Uint8Array(64), P.Cmd.START).ok, false);
});

test('lighting data packet (fixture: static red, brightness 5, speed 3)', () => {
  const p = P.lightingPacket({
    effect: 1,
    color: { r: 255, g: 0, b: 0 },
    colorful: false,
    brightness: 5,
    speed: 3,
    direction: 'left',
  });
  assert.equal(hex(p), pad('01 ff 00 00 00 00 00 00 00 05 03 00 00 00 aa 55'));
});

test('lighting levels are clamped to the NOVA75 range 0–6', () => {
  const p = P.lightingPacket({ ...P.DEFAULT_LIGHTING, brightness: 99, speed: -4 });
  assert.equal(p[9], 6);
  assert.equal(p[10], 0);
});

test('per-key mode packet carries a non-zero brightness and the trailer', () => {
  assert.equal(hex(P.customModePacket(5)), pad('80 00 00 00 00 00 00 00 00 05 00 00 00 00 aa 55'));
  assert.equal(P.customModePacket()[9], 6);
  assert.equal(P.customModePacket(0)[9], 1);
});

test('key slot encoding (fixture cases)', () => {
  const cases = [
    [{ kind: 'default' }, '00 00 00 00'],
    [{ kind: 'disabled' }, '05 03 00 00'],
    [{ kind: 'keyboard', usage: 4, modifiers: 0 }, '02 00 04 00'],
    [{ kind: 'keyboard', usage: 6, modifiers: 1 }, '02 01 06 00'],
    [{ kind: 'keyboard', usage: 7, modifiers: 8 }, '02 08 07 00'],
    [{ kind: 'keyboard', usage: 43, modifiers: 4 }, '02 04 2b 00'],
    [{ kind: 'keyboard', usage: 224, modifiers: 0 }, '02 01 00 00'],
    [{ kind: 'consumer', usage: 205 }, '03 cd 00 00'],
    [{ kind: 'consumer', usage: 402 }, '03 92 01 00'],
    [{ kind: 'mouse', action: 'left' }, '01 01 01 00'],
    [{ kind: 'mouse', action: 'middle' }, '01 01 04 00'],
    [{ kind: 'mouse', action: 'right' }, '01 01 02 00'],
    [{ kind: 'mouse', action: 'wheel-up' }, '01 03 01 00'],
    [{ kind: 'mouse', action: 'wheel-down' }, '01 03 ff 00'],
    [{ kind: 'mouse', action: 'back' }, '01 01 08 00'],
    [{ kind: 'mouse', action: 'forward' }, '01 01 10 00'],
  ];
  for (const [action, slot] of cases) {
    assert.equal(hex(P.encodeSlot(action)), slot, JSON.stringify(action));
    assert.deepEqual(P.decodeSlot(P.encodeSlot(action)), action);
  }
});

test('keymap table: 576 bytes, slot × 4, trailer at 574', () => {
  const t = P.keymapTable({ 55: { kind: 'keyboard', usage: 224, modifiers: 0 } }); // Caps → Ctrl
  assert.equal(t.length, 576);
  assert.equal(hex(t.subarray(220, 224)), '02 01 00 00');
  assert.equal(hex(t.subarray(574)), 'aa 55');
  assert.equal(t.filter((b) => b).length, 4);
  assert.throws(() => P.keymapTable({ 143: { kind: 'disabled' } }));
});

test('per-key table round trip', () => {
  const colors = { 1: { r: 255, g: 0, b: 0 }, 121: { r: 1, g: 2, b: 3 } };
  const t = P.perKeyTable(colors);
  assert.equal(hex(t.subarray(4, 8)), '01 ff 00 00');
  assert.equal(hex(t.subarray(484, 488)), '79 01 02 03');
  assert.equal(hex(t.subarray(574)), 'aa 55');
  assert.deepEqual(P.decodePerKeyTable(t, [1, 121]), colors);
});

test('clock packet (fixture: 2026-05-16 14:30:45, Saturday)', () => {
  const p = P.timePacket(new Date(2026, 4, 16, 14, 30, 45));
  assert.equal(hex(p.subarray(0, 11)), '00 01 5a 1a 05 10 0e 1e 2d 00 06');
  assert.equal(hex(p.subarray(62)), 'aa 55');
});

test('settings packet', () => {
  const p = P.settingsPacket({ sleepTime: 2, keyResponseTime: 3, disableWinKey: true });
  assert.equal(hex(p.subarray(0, 9)), '00 01 00 00 01 00 02 00 03');
  assert.equal(hex(p.subarray(62)), 'aa 55');
});

test('RGB565 little endian (fixture: red 00 f8, green e0 07, blue 1f 00)', () => {
  const px = P.toRgb565le(Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), 3, 1);
  assert.equal(hex(px), '00 f8 e0 07 1f 00');
});

test('screen upload plan for the 240×135 panel', () => {
  const { width, height, maxFrames } = P.NOVA75.screen;
  const frame = (v, delayMs) => ({ pixels: new Uint8Array(width * height * 2).fill(v), delayMs });

  const one = P.planScreenUpload([frame(0x11, 0)]);
  assert.equal(one.chunks, Math.ceil((256 + 64800) / 4096)); // 16
  assert.equal(hex(one.header.subarray(0, 4)), '01 01 ff ff');
  assert.equal(hex(P.imageCommand(one.chunks).subarray(0, 10)), '04 72 01 00 00 00 00 00 10 00');

  const frames = [frame(0x11, 500), frame(0x22, 500)];
  const two = P.planScreenUpload(frames);
  assert.equal(hex(two.header.subarray(0, 4)), '02 fa fa ff');
  const chunks = [...P.screenChunks(frames, two)];
  assert.equal(chunks.length, two.chunks);
  const all = new Uint8Array(chunks.length * 4096);
  chunks.forEach((c, i) => all.set(c, i * 4096));
  assert.equal(all[0], 2);
  assert.equal(all[255], 0xff);
  assert.equal(all[256], 0x11);
  assert.equal(all[256 + 64800 - 1], 0x11);
  assert.equal(all[256 + 64800], 0x22);
  assert.equal(all[256 + 2 * 64800 - 1], 0x22);
  assert.ok(all.subarray(256 + 2 * 64800).every((b) => b === 0xff));

  // 300 chunks need the high byte of the count.
  assert.equal(hex(P.imageCommand(300).subarray(8, 10)), '2c 01');
  assert.throws(() => P.planScreenUpload(Array(maxFrames + 1).fill(frame(0, 0))), /Too many frames/);
  assert.throws(() => P.planScreenUpload([{ pixels: new Uint8Array(10), delayMs: 0 }]));
});

test('receiver packets carry an additive checksum in byte 31', () => {
  const ping = P.donglePacket(P.DONGLE_PING);
  assert.equal(ping.length, 32);
  assert.equal(ping[31], 0x21);

  const light = P.dongleLightingPacket({
    effect: 1,
    color: { r: 255, g: 0, b: 0 },
    colorful: false,
    brightness: 6,
    speed: 3,
    direction: 'right',
  });
  assert.equal(hex(light.subarray(0, 19)), '05 10 00 01 ff 00 00 00 00 00 00 00 06 03 01 00 00 aa 55');
  assert.equal(light[31], [...light.subarray(0, 31)].reduce((a, b) => a + b, 0) & 0xff);

  const off = P.dongleLightingPacket({ ...P.DEFAULT_LIGHTING, effect: 0 });
  assert.equal(hex(off.subarray(0, 19)), '05 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 aa 55');

  const set = P.dongleSettingsPacket({ sleepTime: 3, keyResponseTime: 2, gameMode: true });
  assert.equal(hex(set.subarray(0, 19)), '07 10 00 00 01 01 01 01 01 03 00 02 01 01 01 01 00 aa 55');

  assert.equal(P.batteryFromPong(Uint8Array.from([0x20, 0x01, 0, 87])), 87);
  assert.equal(P.batteryFromPong(Uint8Array.from([0x20, 0x01, 0, 0])), null);
  assert.equal(P.batteryFromPong(Uint8Array.from([0x05, 0x10, 0, 50])), null);
});

test('layout: 80 keys, unique slots inside the table, one Fn key', () => {
  assert.equal(KEYS.length, 80);
  assert.equal(new Set(KEYS.map((k) => k.slot)).size, 80);
  assert.ok(KEYS.every((k) => k.slot > 0 && k.slot < P.TABLE_SLOTS - 1));
  assert.equal(KEYS.filter((k) => k.usage === 0).length, 1);
});

test('USB transactions against the simulated keyboard', async () => {
  const log = new PacketLog(5000);
  const kb = await connectDemo('usb', log);
  const sent = () => log.entries.filter((e) => e.dir === '→').map((e) => e.hex.slice(0, 5));
  const indices = KEYS.map((k) => k.slot);

  await kb.handshake();
  log.clear();
  await kb.setLighting(P.DEFAULT_LIGHTING);
  assert.deepEqual(sent(), ['04 18', '04 13', '0b ff', '04 02', '04 f0']);

  const colors = Object.fromEntries(indices.map((n) => [n, { r: n, g: 2, b: 3 }]));
  log.clear();
  await kb.writePerKey(colors);
  assert.deepEqual(sent().filter((h) => h.startsWith('04')).slice(0, 6), ['04 18', '04 13', '04 02', '04 f0', '04 18', '04 23']);
  assert.equal(log.entries.filter((e) => e.dir === '→').length, 5 + 2 + 9 + 2);
  assert.deepEqual(await kb.readPerKey(indices), colors);

  log.clear();
  await kb.writeKeymap('fn', { 2: { kind: 'consumer', usage: 0xcd } });
  assert.deepEqual([sent()[0], sent()[1], sent().at(-2), sent().at(-1)], ['04 18', '04 27', '04 02', '04 f0']);
  assert.equal(sent().length, 2 + 9 + 2);

  log.clear();
  await kb.writeSettings({ sleepTime: 1 });
  assert.deepEqual(sent(), ['04 18', '04 17', '00 01', '04 02']);

  log.clear();
  await kb.syncClock();
  assert.deepEqual(sent(), ['04 18', '04 28', '00 01', '04 02']);

  const { width, height } = P.NOVA75.screen;
  const frames = [{ pixels: new Uint8Array(width * height * 2), delayMs: 100 }];
  const progress = [];
  log.clear();
  await kb.uploadScreen(frames, (s, t) => progress.push([s, t]));
  assert.deepEqual(progress.at(-1), [16, 16]);
  const out = log.entries.filter((e) => e.dir === '→');
  assert.equal(out.filter((e) => e.kind === 'output').length, 16);
  assert.deepEqual([out[0].hex.slice(0, 5), out[1].hex.slice(0, 8), out.at(-1).hex.slice(0, 5)], ['04 18', '04 72 01', '04 02']);
});

test('receiver against the simulated keyboard', async () => {
  const log = new PacketLog();
  const kb = await connectDemo('dongle', log);
  assert.deepEqual(await kb.battery(), { linked: true, level: 82 });
  log.clear();
  await kb.setLighting(P.DEFAULT_LIGHTING);
  assert.deepEqual(log.entries.map((e) => e.hex.slice(0, 5)), ['0f 00', '05 10']);
});
