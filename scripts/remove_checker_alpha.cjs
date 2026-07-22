#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: remove_checker_alpha.cjs <atlas.png> [...]');
  process.exit(2);
}

const looksLikeChecker = (r, g, b) => {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  return hi - lo <= 14 && (r + g + b) / 3 >= 196;
};

async function removeChecker(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const count = width * height;
  const outside = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const enqueue = (pixel) => {
    if (outside[pixel]) return;
    const offset = pixel * channels;
    if (!looksLikeChecker(data[offset], data[offset + 1], data[offset + 2])) return;
    outside[pixel] = 1;
    queue[tail++] = pixel;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (pixel >= width) enqueue(pixel - width);
    if (pixel + width < count) enqueue(pixel + width);
  }

  const rgba = Buffer.allocUnsafe(count * 4);
  for (let pixel = 0; pixel < count; pixel++) {
    const src = pixel * channels;
    const dst = pixel * 4;
    rgba[dst] = data[src];
    rgba[dst + 1] = data[src + 1];
    rgba[dst + 2] = data[src + 2];
    rgba[dst + 3] = outside[pixel] ? 0 : 255;
  }

  const temp = `${file}.alpha-${process.pid}.png`;
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toFile(temp);
  await fs.rename(temp, file);
  console.log(`${path.basename(file)}: cleared ${tail.toLocaleString()} background pixels`);
}

Promise.all(files.map(removeChecker)).catch((error) => {
  console.error(error);
  process.exit(1);
});
