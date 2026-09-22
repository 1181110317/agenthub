// 按需读取 zip 内单个条目。
//
// 预览 Office 文件里的图片时，如果为了拿一张图就把整个文件读进内存再解压，
// 一个 50MB 的 docx 每张图都要付一次全量代价（185 张图＝185 次全量）。
// 这里按中央目录定位目标条目的偏移，只从磁盘读它自己的压缩字节再解压，
// 单次读取量与该图大小成正比。
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;          // 中央目录结束记录
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;            // 中央目录条目
const LOCAL_SIG = 0x04034b50;         // 本地文件头
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;   // 单条目解压上限（防 zip 炸弹）
const MAX_CD_BYTES = 64 * 1024 * 1024;      // 中央目录读取上限

function findSignatureBackwards(buf, sig) {
  for (let i = buf.length - 4; i >= 0; i--) if (buf.readUInt32LE(i) === sig) return i;
  return -1;
}
async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

// 成功返回 Buffer；条目不存在返回 null；文件不是 zip / 条目不可用则抛错。
async function zipEntryBuffer(filePath, entryName, limit = MAX_ENTRY_BYTES) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('不是有效的 zip 文件');
    // 注释最长 65535，倒退 66KB 一定覆盖 EOCD
    const tailLen = Math.min(size, 66 * 1024);
    const tail = await readAt(fh, tailLen, size - tailLen);
    const eocdIdx = findSignatureBackwards(tail, EOCD_SIG);
    if (eocdIdx < 0) throw new Error('不是有效的 zip 文件（缺少中央目录）');
    let cdOffset = tail.readUInt32LE(eocdIdx + 16);
    let cdSize = tail.readUInt32LE(eocdIdx + 12);
    let entryCount = tail.readUInt16LE(eocdIdx + 10);
    // ZIP64：32 位字段溢出时改读 ZIP64 记录
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
      const locIdx = findSignatureBackwards(tail, EOCD64_LOCATOR_SIG);
      if (locIdx >= 0) {
        const eocd64Offset = Number(tail.readBigUInt64LE(locIdx + 8));
        const head = await readAt(fh, 56, eocd64Offset);
        if (head.length >= 56 && head.readUInt32LE(0) === EOCD64_SIG) {
          entryCount = Number(head.readBigUInt64LE(32));
          cdSize = Number(head.readBigUInt64LE(40));
          cdOffset = Number(head.readBigUInt64LE(48));
        }
      }
    }
    if (!cdSize || cdSize > MAX_CD_BYTES || cdOffset + cdSize > size) throw new Error('中央目录异常');
    const cd = await readAt(fh, cdSize, cdOffset);
    const target = Buffer.from(String(entryName), 'utf8');
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen);
      // ZIP64 扩展字段（0x0001）按顺序补齐溢出的字段
      if (rawSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen;
        const extraEnd = e + extraLen;
        while (e + 4 <= extraEnd) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (rawSize === 0xffffffff && q + 8 <= cd.length) { rawSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff && q + 8 <= cd.length) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff && q + 8 <= cd.length) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }
      if (name.equals(target)) {
        if (flags & 0x1) throw new Error('条目已加密');
        if (rawSize > limit) throw new Error('条目过大');
        if (localOffset + 30 > size) throw new Error('条目偏移越界');
        const local = await readAt(fh, 30, localOffset);
        if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIG) throw new Error('本地文件头损坏');
        const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataStart + compSize > size) throw new Error('条目数据越界');
        const comp = await readAt(fh, compSize, dataStart);
        if (method === 0) return comp;
        if (method !== 8) throw new Error('不支持的压缩方式：' + method);
        // maxOutputLength 兜住伪造的解压后大小
        return zlib.inflateRawSync(comp, { maxOutputLength: limit });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = { zipEntryBuffer, MAX_ENTRY_BYTES };
