export function canonicalChannelKey(channelId) {
  if (channelId == null) return '';
  return String(channelId).trim();
}

export function channelKeysMatch(a, b) {
  return canonicalChannelKey(a) === canonicalChannelKey(b);
}
