export default function formatChannelDisplay(zone, name) {
  if (zone) {
    return `ZN-${zone}, CH-${name}`;
  }
  return `CH-${name}`;
}

export function formatRoomKey(roomKey) {
  if (!roomKey) return 'Unknown';
  const idx = roomKey.indexOf('__');
  if (idx > 0) {
    const zone = roomKey.slice(0, idx);
    const name = roomKey.slice(idx + 2);
    return formatChannelDisplay(zone === 'Default' ? null : zone, name);
  }
  return roomKey;
}
