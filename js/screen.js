/** Turns an image or GIF file into frames for the keyboard's 240×135 screen. */
import { NOVA75, fromRgb565le, toRgb565le } from './protocol.js';

const { width: W, height: H, maxFrames: MAX } = NOVA75.screen;

function render(source, sw, sh, fit, background) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  if (fit === 'stretch') {
    ctx.drawImage(source, 0, 0, W, H);
  } else {
    const scale = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return toRgb565le(ctx.getImageData(0, 0, W, H).data, W, H);
}

/**
 * Returns `{ frames: [{ pixels, delayMs }], dropped }`. Animated GIFs are decoded frame by frame
 * (needs the browser's ImageDecoder); anything past the screen's frame limit is dropped and counted.
 */
export async function loadFrames(file, { fit = 'cover', background = '#000000' } = {}) {
  const animated = file.type === 'image/gif' || file.type === 'image/webp' || file.type === 'image/apng';
  if (animated && 'ImageDecoder' in globalThis && (await ImageDecoder.isTypeSupported(file.type))) {
    const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
    await decoder.tracks.ready;
    await decoder.completed;
    const total = decoder.tracks.selectedTrack.frameCount;
    const frames = [];
    for (let i = 0; i < Math.min(total, MAX); i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      frames.push({
        pixels: render(image, image.displayWidth, image.displayHeight, fit, background),
        delayMs: Math.max(20, Math.round((image.duration ?? 100000) / 1000)),
      });
      image.close();
    }
    decoder.close();
    return { frames, dropped: Math.max(0, total - MAX) };
  }
  const bitmap = await createImageBitmap(file);
  const frames = [{ pixels: render(bitmap, bitmap.width, bitmap.height, fit, background), delayMs: 0 }];
  bitmap.close();
  return { frames, dropped: 0 };
}

/** Plays frames on a canvas exactly as the panel's 16-bit colour will show them. Returns a stop function. */
export function preview(canvas, frames) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  let timer = 0;
  let i = 0;
  const draw = () => {
    const f = frames[i];
    ctx.putImageData(new ImageData(fromRgb565le(f.pixels, W, H), W, H), 0, 0);
    if (frames.length > 1) {
      i = (i + 1) % frames.length;
      // The keyboard stores delays in 2 ms steps, at most 510 ms.
      timer = setTimeout(draw, Math.min(510, Math.max(2, f.delayMs)));
    }
  };
  draw();
  return () => clearTimeout(timer);
}
