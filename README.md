# Nova75 Studio

An unofficial browser configurator for the AULA NOVA75 keyboard. It talks to the keyboard directly
over WebHID: no installer, no account, nothing sent to a server.

## Run it

```bash
npm start
```

Then open http://localhost:5175 in Chrome, Edge or Opera on a computer (WebHID needs one of those,
and a secure origin: `localhost` or HTTPS). There is no build step and there are no dependencies; the
folder is a static site, so it can also be hosted as-is on Vercel, Netlify, GitHub Pages and the like.

Close the official AULA driver before connecting: only one program can hold the keyboard.

```bash
npm test
```

## What works

| Feature                          | USB cable | 2.4G receiver |
| -------------------------------- | --------- | ------------- |
| Lighting effect, colour, levels  | yes       | yes           |
| Sleep timer, key response        | yes       | yes           |
| Win / Alt+Tab / Alt+F4 locks     | yes       | as game mode  |
| Battery level                    | no        | yes           |
| Per-key colours (read and write) | yes       | no            |
| Key remapping, base and Fn layer | yes       | no            |
| Screen image / GIF (240×135)     | yes       | no            |
| Clock sync                       | yes       | no            |
| Key tester                       | any       | any           |

Not built yet: macros, Bluetooth (the keyboard does not accept configuration over Bluetooth).

## Verification status

- The packet builders are tested against the byte sequences OpenKey published from the official
  driver, and every transaction is run against a simulated keyboard (`npm test`, and the two demo
  buttons on the home page).
- **Confirmed on a real NOVA75 over USB** (owner test, November 2026): connection and handshake,
  lighting effects, per-key colours, key remapping, screen upload, settings and clock sync.
- **Not yet confirmed:** anything over the 2.4G receiver (battery, lighting, settings), and F10 in the
  key tester.
- The app only sends configuration commands. It contains no firmware-update, reset or erase command,
  and refuses animations longer than the screen's 107-frame limit.

A sensible order for the first test on hardware: connect (this sends only the harmless START
handshake), apply a lighting effect, read the per-key colours, then try the rest. The Log tab shows
every packet if something does not behave.

## Layout

| File             | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `js/protocol.js` | Packet builders and parsers, no I/O                               |
| `js/device.js`   | WebHID pipes, USB and receiver drivers, the simulated keyboard    |
| `js/layout.js`   | The 80 keys: position, matrix slot / LED index, default HID usage |
| `js/keys.js`     | Key, media and mouse choices for remapping                        |
| `js/screen.js`   | Image and GIF to 240×135 RGB565 frames                            |
| `js/app.js`      | The page                                                          |

Protocol credit: the OpenKey project (MIT). See `NOTICE.md`.
