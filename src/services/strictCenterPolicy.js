export function normalizeCenterUnitId(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
}

export function unitAppearsInCenter(units, unitId) {
  const normalized = normalizeCenterUnitId(unitId);
  if (!normalized || !Array.isArray(units)) return false;
  return units.some((candidate) => normalizeCenterUnitId(
    candidate?.unit_id
      || candidate?.unit_number
      || candidate?.unitNumber
      || candidate?.callsign
      || candidate?.call_sign,
  ) === normalized);
}

export function restrictManagedAliases(aliases, canonicalRoomKey, numericChannelId) {
  const canonical = String(canonicalRoomKey || '').trim();
  const numeric = numericChannelId == null ? '' : String(numericChannelId);
  for (const alias of [...aliases]) {
    const value = String(alias);
    if (value !== canonical && value !== numeric) aliases.delete(alias);
  }
  if (canonical) aliases.add(canonical);
  if (numeric) aliases.add(numeric);
  return aliases;
}
