// Deliberately small image-size compatibility layer for AgentHub's PPTX tool.
// The application does not accept arbitrary images for PPTX generation. Keep
// only bounded, common header parsing and reject formats whose parsers have had
// unbounded-loop advisories (ICNS/JXL/HEIF/etc.).
const fs = require('fs');

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function inputBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') {
    const stat = fs.statSync(input);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('image too large');
    return fs.readFileSync(input);
  }
  throw new TypeError('image-size expects a Buffer or file path');
}

function sizeOf(input) {
  const b = inputBuffer(input);
  if (b.length > MAX_INPUT_BYTES) throw new Error('image too large');
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: 'png' };
  }
  if (b.length >= 10 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), type: 'gif' };
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X' && b.length >= 30) {
      return { width: 1 + b[24] + (b[25] << 8) + (b[26] << 16), height: 1 + b[27] + (b[28] << 8) + (b[29] << 16), type: 'webp' };
    }
    if (kind === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26), height: b.readUInt16LE(28), type: 'webp' };
    if (kind === 'VP8L' && b.length >= 25) return { width: 1 + b[21] + ((b[22] & 0x3f) << 8), height: 1 + ((b[22] >> 6) & 0x3) + (b[23] << 2) + ((b[24] & 0x3f) << 10), type: 'webp' };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1]; p += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (p + 2 > b.length) break;
      const len = b.readUInt16BE(p);
      if (len < 2 || p + len > b.length) break;
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof && len >= 7) return { height: b.readUInt16BE(p + 3), width: b.readUInt16BE(p + 5), type: 'jpg' };
      p += len;
    }
  }
  throw new Error('unsupported or unsafe image format');
}

function imageSize(input, callback) {
  if (typeof callback === 'function') {
    try { callback(null, sizeOf(input)); } catch (e) { callback(e); }
    return;
  }
  return sizeOf(input);
}

imageSize.imageSize = imageSize;
imageSize.imageSizeFromFile = file => sizeOf(file);
imageSize.types = ['png', 'gif', 'webp', 'jpg'];
imageSize.default = imageSize;
module.exports = imageSize;
module.exports.imageSize = imageSize;
module.exports.imageSizeFromFile = imageSize.imageSizeFromFile;
module.exports.types = imageSize.types;
module.exports.default = imageSize;
