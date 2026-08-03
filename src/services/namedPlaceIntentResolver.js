import locationService from './locationService.js';

const STREET_ADDRESS_RX = /(?:^\d+\s+\w|\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|pl|place|pike|hwy|highway)\b)/i;
const SELF_LOCATION_RX = /\b(?:my location|my current location|my gps|where i am|my position|this location|my detail|my assigned location)\b/i;

function clean(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function looksLikeStreetAddress(value) {
  const address = clean(value);
  return address.length >= 5 && STREET_ADDRESS_RX.test(address);
}

export function isNamedPlaceIntentCandidate(result) {
  if (result?.intent !== 'CREATE_CALL') return false;
  const address = clean(result?.slots?.address);
  if (!address || SELF_LOCATION_RX.test(address)) return false;
  return !looksLikeStreetAddress(address);
}

export function buildCanonicalStreetAddress(location) {
  if (!location || typeof location !== 'object') return null;

  const premise = clean(location.businessName || location.business_name || location.name);
  const houseNumber = clean(location.houseNumber || location.house_number);
  let road = clean(location.road || location.address || location.streetAddress);

  if (houseNumber && road) {
    const alreadyPrefixed = new RegExp(`^${escapeRegex(houseNumber)}\\b`, 'i').test(road);
    road = alreadyPrefixed ? road : `${houseNumber} ${road}`;
  } else if (houseNumber && !road) {
    road = houseNumber;
  }

  if (premise && road && !road.toLowerCase().includes(premise.toLowerCase())) {
    road = `${premise} — ${road}`;
  }

  const municipality = clean(
    location.municipality || location.township || location.city || location.town || location.village
  );
  const state = premise ? '' : clean(location.stateCode || location.state || location.region);
  const structured = [road, municipality, state].filter(Boolean).join(', ');

  if (looksLikeStreetAddress(structured)) return structured;

  const displayName = clean(location.displayName || location.formattedAddress || location.formatted_address);
  return looksLikeStreetAddress(displayName) ? displayName : null;
}

export async function resolveNamedPlaceIntent(result, resolver = locationService) {
  if (!isNamedPlaceIntentCandidate(result)) return result;

  const spokenAddress = clean(result.slots.address);
  try {
    const location = await resolver.forwardGeocode(spokenAddress);
    const canonicalAddress = buildCanonicalStreetAddress(location);
    if (!canonicalAddress) return result;

    return {
      ...result,
      slots: {
        ...result.slots,
        address: canonicalAddress,
      },
    };
  } catch {
    return result;
  }
}
