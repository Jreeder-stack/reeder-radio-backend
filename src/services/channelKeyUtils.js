export function canonicalChannelKey(channelId) {
  if (channelId == null) return '';
  let key = String(channelId).trim();
  if (!key) return '';
  if (key.includes('__')) {
    const parts = key.split('__');
    const zone = parts[0].trim();
    const name = parts.slice(1).join('__').trim();
    if (zone && name) {
      key = `${zone}__${name}`;
    }
  }
  return key;
}

export function channelKeysMatch(a, b) {
  return canonicalChannelKey(a) === canonicalChannelKey(b);
}
