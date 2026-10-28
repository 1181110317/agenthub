// JSON remains authoritative; only the serialized payload is encrypted.
// The key lives beside the data with owner-only permissions. This protects a
// copied JSON file, not another process running as the same OS user.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, DATA_DIR } = require('./store');

function encryptedStore(name, defaults) {
  const keyFile = path.join(DATA_DIR, '.' + name + '.key');
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const validData = data => record(data) && Object.entries(defaults).every(([field, fallback]) => Array.isArray(fallback) ? Array.isArray(data[field]) : record(fallback) ? record(data[field]) : typeof data[field] === typeof fallback);
  let key;
  let hadCiphertext = false;
  function getKey(create) {
    if (key) return key;
    try {
      const bytes = fs.readFileSync(keyFile);
      if (bytes.length !== 32) throw new Error(name + ' 加密密钥损坏，请恢复原密钥');
      return (key = bytes);
    } catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      if (hadCiphertext) throw new Error(name + ' 加密密钥缺失，请恢复原密钥');
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    return getKey(false);
  }
  const store = new Store(name, defaults, {
    mode: 0o600,
    preserveOnLoadError: true,
    validate(data) { return data?.encrypted === 1 || validData(data); },
    serialize(data) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', getKey(true), iv);
      cipher.setAAD(Buffer.from(name));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
      return JSON.stringify({ encrypted: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), payload: bytes.toString('base64') });
    },
  });
  const disk = store.data;
  if (disk && disk.encrypted === 1) {
    hadCiphertext = true;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(false), Buffer.from(disk.iv, 'base64'));
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(Buffer.from(disk.tag, 'base64'));
      const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(disk.payload, 'base64')), decipher.final()]).toString('utf8'));
      if (!validData(decoded)) throw new Error('凭据数据格式无效');
      store.data = decoded;
    } catch {
      store.data = structuredClone(defaults);
      store.loadError = name + ' 无法解密，请恢复原 JSON 和密钥文件';
      store._blocked = true; // Never overwrite ciphertext with an empty default.
    }
  } else if (!store.loadError && !store.indexMissing) {
    // Migrate legacy plaintext through the same serialization used by shutdown
    // and backup flushes. A failed migration preserves the original file.
    if (!store.saveNow()) store.loadError = name + ' 凭据迁移失败';
  }
  store._secretShape = validData;
  return store;
}

function saveSecretState(store, next) {
  if (store.loadError) throw new Error(store.loadError);
  if (!store._secretShape(next)) throw new Error('凭据数据格式无效');
  const prior = store.data;
  store.data = next;
  if (!store.saveNow()) {
    store.data = prior;
    throw new Error('凭据保存失败，请检查数据目录');
  }
}

module.exports = { encryptedStore, saveSecretState };
