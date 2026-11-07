import sharp from 'sharp';
import { crc32 } from 'node:zlib';

export async function staticImages() {
  const images: Array<{ name: string; bytes: Buffer; width: number; height: number; originalWidth: number; originalHeight: number }> = [];
  for (const format of ['jpeg', 'png', 'webp', 'gif'] as const) {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#8839ef' } }).toFormat(format).toBuffer();
    images.push({ name: format, bytes, width: 12, height: 8, originalWidth: 12, originalHeight: 8 });
  }
  const rotated = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#4c4f69' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  images.push({ name: 'rotated-jpeg', bytes: rotated, width: 8, height: 12, originalWidth: 12, originalHeight: 8 });
  return images;
}

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

function imageData(png: Buffer): Buffer {
  const segments: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') segments.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return Buffer.concat(segments);
}

/** A valid two-frame APNG with genuine PNG-compressed pixels, not a renamed SVG. */
export async function animatedImages() {
  const first = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#8839ef' } }).png().toBuffer();
  const second = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#d20f39' } }).png().toBuffer();
  const gif = await sharp([first, second], { join: { animated: true } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
  const webp = await sharp([first, second], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const controls = [0, 1].map(sequence => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence);
    control.writeUInt32BE(4, 4);
    control.writeUInt32BE(4, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(10, 22);
    return chunk('fcTL', control);
  });
  const compressedSecond = imageData(second);
  const secondData = Buffer.alloc(4 + compressedSecond.length);
  secondData.writeUInt32BE(2);
  compressedSecond.copy(secondData, 4);
  const apng = Buffer.concat([
    first.subarray(0, 33), chunk('acTL', animation), controls[0]!, chunk('IDAT', imageData(first)),
    controls[1]!, chunk('fdAT', secondData), chunk('IEND', Buffer.alloc(0)),
  ]);
  return [{ name: 'gif', bytes: gif }, { name: 'webp', bytes: webp }, { name: 'apng', bytes: apng }];
}
