import type { ImageFormat } from '@hcl/contracts';

export type MediaMetadata = {
  format: ImageFormat;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const GIF87_SIGNATURE = [71, 73, 70, 56, 55, 97];
const GIF89_SIGNATURE = [71, 73, 70, 56, 57, 97];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index++) if (bytes[index] !== signature[index]) return false;
  return true;
}

/** Only the four selected formats; a claimed MIME type or filename never changes this. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, GIF87_SIGNATURE) || startsWith(bytes, GIF89_SIGNATURE)) return 'gif';
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'webp';
  return null;
}
