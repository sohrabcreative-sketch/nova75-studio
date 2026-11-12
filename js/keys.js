/** HID keyboard usages (page 0x07) offered for remapping: [usage, label, KeyboardEvent.code]. */
const K = [];
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(65 + i);
  K.push([4 + i, c, `Key${c}`]);
}
for (let i = 1; i <= 9; i++) K.push([29 + i, String(i), `Digit${i}`]);
K.push(
  [39, '0', 'Digit0'],
  [40, 'Enter', 'Enter'],
  [41, 'Esc', 'Escape'],
  [42, 'Backspace', 'Backspace'],
  [43, 'Tab', 'Tab'],
  [44, 'Space', 'Space'],
  [45, '-', 'Minus'],
  [46, '=', 'Equal'],
  [47, '[', 'BracketLeft'],
  [48, ']', 'BracketRight'],
  [49, '\\', 'Backslash'],
  [51, ';', 'Semicolon'],
  [52, "'", 'Quote'],
  [53, '`', 'Backquote'],
  [54, ',', 'Comma'],
  [55, '.', 'Period'],
  [56, '/', 'Slash'],
  [57, 'Caps Lock', 'CapsLock'],
);
for (let i = 1; i <= 12; i++) K.push([57 + i, `F${i}`, `F${i}`]);
K.push(
  [70, 'Print Screen', 'PrintScreen'],
  [71, 'Scroll Lock', 'ScrollLock'],
  [72, 'Pause', 'Pause'],
  [73, 'Insert', 'Insert'],
  [74, 'Home', 'Home'],
  [75, 'Page Up', 'PageUp'],
  [76, 'Delete', 'Delete'],
  [77, 'End', 'End'],
  [78, 'Page Down', 'PageDown'],
  [79, '→', 'ArrowRight'],
  [80, '←', 'ArrowLeft'],
  [81, '↓', 'ArrowDown'],
  [82, '↑', 'ArrowUp'],
  [83, 'Num Lock', 'NumLock'],
  [84, 'Num /', 'NumpadDivide'],
  [85, 'Num *', 'NumpadMultiply'],
  [86, 'Num -', 'NumpadSubtract'],
  [87, 'Num +', 'NumpadAdd'],
  [88, 'Num Enter', 'NumpadEnter'],
);
for (let i = 1; i <= 9; i++) K.push([88 + i, `Num ${i}`, `Numpad${i}`]);
K.push([98, 'Num 0', 'Numpad0'], [99, 'Num .', 'NumpadDecimal'], [101, 'Menu', 'ContextMenu']);
for (let i = 13; i <= 24; i++) K.push([91 + i, `F${i}`, `F${i}`]);
K.push(
  [224, 'Left Ctrl', 'ControlLeft'],
  [225, 'Left Shift', 'ShiftLeft'],
  [226, 'Left Alt', 'AltLeft'],
  [227, 'Left Win', 'MetaLeft'],
  [228, 'Right Ctrl', 'ControlRight'],
  [229, 'Right Shift', 'ShiftRight'],
  [230, 'Right Alt', 'AltRight'],
  [231, 'Right Win', 'MetaRight'],
);

export const KEY_OPTIONS = K.map(([usage, label, code]) => ({ usage, label, code }));
export const KEY_LABEL = Object.fromEntries(K.map(([u, l]) => [u, l]));
export const CODE_TO_USAGE = Object.fromEntries(K.map(([u, , c]) => [c, u]));

/** Modifier bitmask used in a key slot. */
export const MODIFIERS = [
  { bit: 0x01, label: 'Ctrl' },
  { bit: 0x02, label: 'Shift' },
  { bit: 0x04, label: 'Alt' },
  { bit: 0x08, label: 'Win' },
];

/** Consumer-page usages (media keys). */
export const MEDIA_OPTIONS = [
  { usage: 0xcd, label: 'Play / Pause' },
  { usage: 0xb5, label: 'Next track' },
  { usage: 0xb6, label: 'Previous track' },
  { usage: 0xb7, label: 'Stop' },
  { usage: 0xe2, label: 'Mute' },
  { usage: 0xe9, label: 'Volume up' },
  { usage: 0xea, label: 'Volume down' },
  { usage: 0x183, label: 'Media player' },
  { usage: 0x192, label: 'Calculator' },
  { usage: 0x18a, label: 'Mail' },
  { usage: 0x194, label: 'My Computer' },
  { usage: 0x223, label: 'Browser home' },
  { usage: 0x224, label: 'Browser back' },
  { usage: 0x225, label: 'Browser forward' },
  { usage: 0x227, label: 'Browser refresh' },
  { usage: 0x221, label: 'Search' },
];
export const MEDIA_LABEL = Object.fromEntries(MEDIA_OPTIONS.map((m) => [m.usage, m.label]));

export const MOUSE_OPTIONS = [
  { action: 'left', label: 'Left click' },
  { action: 'right', label: 'Right click' },
  { action: 'middle', label: 'Middle click' },
  { action: 'back', label: 'Mouse back' },
  { action: 'forward', label: 'Mouse forward' },
  { action: 'wheel-up', label: 'Wheel up' },
  { action: 'wheel-down', label: 'Wheel down' },
];
export const MOUSE_LABEL = Object.fromEntries(MOUSE_OPTIONS.map((m) => [m.action, m.label]));

/** Short text for a key action, for the keycap and the change list. */
export function describeAction(a) {
  switch (a?.kind) {
    case 'keyboard': {
      const mods = MODIFIERS.filter((m) => a.modifiers & m.bit).map((m) => m.label);
      return [...mods, KEY_LABEL[a.usage] ?? `0x${a.usage.toString(16)}`].join('+');
    }
    case 'consumer':
      return MEDIA_LABEL[a.usage] ?? `Media 0x${a.usage.toString(16)}`;
    case 'mouse':
      return MOUSE_LABEL[a.action] ?? a.action;
    case 'disabled':
      return 'Disabled';
    default:
      return 'Default';
  }
}
