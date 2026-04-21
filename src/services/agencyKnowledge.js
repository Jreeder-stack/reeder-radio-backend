export const KNOWN_PLACES = [
  {
    name: 'Indiana County Jail',
    aliases: ['county jail', 'the jail', 'icj', 'indiana jail'],
    address: '125 N 6th St, Indiana, PA 15701',
    category: 'jail',
  },
  {
    name: 'SCI Pine Grove',
    aliases: ['sci', 'state prison', 'pine grove', 'state correctional'],
    address: '189 Fyock Rd, Indiana, PA 15701',
    category: 'jail',
  },
  {
    name: 'Indiana Regional Medical Center',
    aliases: ['irmc', 'hospital', 'indiana hospital', 'medical center', 'regional medical'],
    address: '835 Hospital Rd, Indiana, PA 15701',
    category: 'hospital',
  },
  {
    name: 'MDJ Indiana',
    aliases: ['mdj', 'magistrate', 'district court', 'district justice', 'magisterial district judge'],
    address: '825 Philadelphia St, Indiana, PA 15701',
    category: 'magistrate',
  },
  {
    name: 'Indiana County Courthouse',
    aliases: ['courthouse', 'court house', 'county court', 'court'],
    address: '825 Philadelphia St, Indiana, PA 15701',
    category: 'court',
  },
  {
    name: 'Walmart Indiana',
    aliases: ['walmart', 'wal-mart', 'wal mart'],
    address: '3100 Oakland Ave, Indiana, PA 15701',
    category: 'retail',
  },
  {
    name: 'Indiana University of Pennsylvania',
    aliases: ['iup', 'university', 'the university'],
    address: '1011 South Dr, Indiana, PA 15705',
    category: 'school',
  },
  {
    name: 'PSP Indiana',
    aliases: ['psp', 'state police', 'state barracks', 'pennsylvania state police'],
    address: '1395 Wayne Ave, Indiana, PA 15701',
    category: 'police',
  },
  {
    name: 'HQ',
    aliases: ['headquarters', 'station', 'the station', 'the office'],
    address: null,
    category: 'station',
  },
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveDestination(spokenDestination, places = KNOWN_PLACES) {
  const text = normalize(spokenDestination);
  if (!text) return { kind: 'unknown', text: spokenDestination };

  const matches = [];
  for (const place of places) {
    const candidates = [normalize(place.name), ...place.aliases.map(normalize)];
    let hit = false;
    for (const c of candidates) {
      if (!c) continue;
      if (text === c) { hit = true; break; }
      const re = new RegExp(`(?:^|\\s)${c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:\\s|$)`);
      if (re.test(text)) { hit = true; break; }
    }
    if (hit) matches.push(place);
  }

  if (matches.length === 1) return { kind: 'unique', place: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'unknown', text: spokenDestination };
}
