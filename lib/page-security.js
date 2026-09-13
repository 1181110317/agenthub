const net = require('net');

function privatePageIPv4(address) {
  const p = String(address).split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function expandIPv6(address) {
  let value = String(address || '').toLowerCase().split('%')[0];
  if (!value) return null;
  if (value.includes('.')) {
    const at = value.lastIndexOf(':');
    if (at < 0) return null;
    const octets = value.slice(at + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = value.slice(0, at + 1) + high + ':' + low;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2 ? left.concat(Array(missing).fill('0'), right) : left;
  if (groups.length !== 8 || groups.some(x => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map(x => parseInt(x, 16));
}

function privatePageIPv6(address) {
  const raw = String(address || '').toLowerCase();
  if (raw.includes('%')) return true;
  const groups = expandIPv6(raw);
  if (!groups) return true;
  const first = groups[0];
  const allZero = groups.every(x => x === 0);
  const mapped = groups.slice(0, 5).every(x => x === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every(x => x === 0);
  if (mapped) {
    const value = groups[6] * 0x10000 + groups[7];
    return privatePageIPv4([
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ].join('.'));
  }
  // IPv4-compatible addresses are obsolete/reserved and must not be used as
  // an alternate spelling for an internal IPv4 destination.
  if (compatible) return true;
  // 6to4 (2002::/16) embeds the IPv4 destination in groups 1-2.  A private
  // IPv4 such as 192.168.1.1 can therefore be hidden behind a globally-looking
  // IPv6 literal unless it is decoded before the request.
  if (first === 0x2002) {
    const value = groups[1] * 0x10000 + groups[2];
    return privatePageIPv4([
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ].join('.'));
  }
  // RFC 6052 well-known NAT64 prefix.  The /96 form embeds IPv4 in the last
  // 32 bits; the /48 variant is also treated conservatively as a translation
  // network because its next-hop can resolve to an internal IPv4 address.
  if (first === 0x0064 && groups[1] === 0xff9b) {
    if (groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      const value = groups[6] * 0x10000 + groups[7];
      return privatePageIPv4([
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255,
      ].join('.'));
    }
    if (groups[2] === 1) return true;
  }
  return allZero || (first & 0xfe00) === 0xfc00       // fc00::/7
    || (first & 0xffc0) === 0xfe80                    // fe80::/10
    || (first & 0xff00) === 0xff00                    // ff00::/8
    || (first === 0x2001 && groups[1] === 0x0);        // Teredo transition space
}

function privatePageAddress(address) {
  const kind = net.isIP(address);
  return kind === 4 ? privatePageIPv4(address) : kind === 6 ? privatePageIPv6(address) : true;
}

module.exports = { privatePageIPv4, privatePageIPv6, privatePageAddress };
