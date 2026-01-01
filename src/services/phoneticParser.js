const PHONETIC_ALPHABETS = {
  'alpha': 'A', 'alfa': 'A', 'adam': 'A',
  'bravo': 'B', 'boy': 'B', 'baker': 'B',
  'charlie': 'C', 'charles': 'C',
  'delta': 'D', 'david': 'D', 'dog': 'D',
  'echo': 'E', 'edward': 'E', 'easy': 'E',
  'foxtrot': 'F', 'frank': 'F', 'fox': 'F',
  'golf': 'G', 'george': 'G',
  'hotel': 'H', 'henry': 'H',
  'india': 'I', 'ida': 'I',
  'juliet': 'J', 'john': 'J',
  'kilo': 'K', 'king': 'K',
  'lima': 'L', 'lincoln': 'L', 'larry': 'L',
  'mike': 'M', 'mary': 'M',
  'november': 'N', 'nora': 'N', 'nancy': 'N',
  'oscar': 'O', 'ocean': 'O',
  'papa': 'P', 'paul': 'P', 'peter': 'P',
  'quebec': 'Q', 'queen': 'Q',
  'romeo': 'R', 'robert': 'R', 'roger': 'R',
  'sierra': 'S', 'sam': 'S', 'sugar': 'S',
  'tango': 'T', 'tom': 'T', 'thomas': 'T',
  'uniform': 'U', 'union': 'U',
  'victor': 'V',
  'whiskey': 'W', 'william': 'W',
  'x-ray': 'X', 'xray': 'X',
  'yankee': 'Y', 'young': 'Y',
  'zulu': 'Z', 'zebra': 'Z'
};

const SINGLE_LETTERS = /^[a-z]$/i;

export function parsePhoneticSpelling(text) {
  if (!text) return '';
  
  const words = text.toLowerCase().split(/[\s,.-]+/).filter(Boolean);
  let result = '';
  
  for (const word of words) {
    if (PHONETIC_ALPHABETS[word]) {
      result += PHONETIC_ALPHABETS[word];
    } else if (SINGLE_LETTERS.test(word)) {
      result += word.toUpperCase();
    }
  }
  
  return result;
}

export function extractNameFromTranscript(transcript) {
  const normalized = transcript.toLowerCase().trim();
  
  const spellingMatch = normalized.match(/(?:that's|thats|spelled|spelling)\s+(.+)/i);
  if (spellingMatch) {
    const spelled = parsePhoneticSpelling(spellingMatch[1]);
    if (spelled.length >= 2) {
      return capitalizeFirst(spelled);
    }
  }
  
  const dashMatch = normalized.match(/(\w+)\s*[-–]\s*(.+)/);
  if (dashMatch) {
    const baseName = dashMatch[1];
    const spelling = parsePhoneticSpelling(dashMatch[2]);
    if (spelling.length >= 2) {
      return capitalizeFirst(spelling);
    }
    return capitalizeFirst(baseName);
  }
  
  const words = normalized.split(/\s+/);
  
  if (words.length >= 2) {
    const possibleSpelling = parsePhoneticSpelling(words.slice(1).join(' '));
    if (possibleSpelling.length >= 2 && possibleSpelling.length <= 15) {
      return capitalizeFirst(possibleSpelling);
    }
  }
  
  if (words.length > 0) {
    return capitalizeFirst(words[0]);
  }
  
  return '';
}

export function parseDOB(text) {
  if (!text) return null;
  
  const normalized = text.toLowerCase()
    .replace(/\bof\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\bborn\b/g, '')
    .replace(/\bdob\b/g, '')
    .replace(/\bdate of birth\b/g, '')
    .trim();
  
  const patterns = [
    /(\d{1,2})\s*[-\/]\s*(\d{1,2})\s*[-\/]\s*(\d{2,4})/,
    /(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})/,
    /(\d{1,2})\s*(\d{1,2})\s*(\d{4})/
  ];
  
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      let [_, month, day, year] = match;
      month = parseInt(month);
      day = parseInt(day);
      year = parseInt(year);
      
      if (year < 100) {
        year = year > 30 ? 1900 + year : 2000 + year;
      }
      
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return {
          month: month.toString().padStart(2, '0'),
          day: day.toString().padStart(2, '0'),
          year: year.toString(),
          formatted: `${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${year}`
        };
      }
    }
  }
  
  return null;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function parsePersonDetails(transcript) {
  const result = {
    lastName: null,
    firstName: null,
    dob: null,
    raw: transcript
  };
  
  const dobMatch = transcript.match(/(?:dob|date of birth|born)\s*[:]?\s*(.+?)(?:$|,|\.|first|last)/i) ||
                   transcript.match(/(\d{1,2}[\s\-\/]\d{1,2}[\s\-\/]\d{2,4})/);
  
  if (dobMatch) {
    result.dob = parseDOB(dobMatch[1] || dobMatch[0]);
  }
  
  const lastNameMatch = transcript.match(/last\s*(?:name)?[:\s]+([^,]+?)(?:,|\.|first|dob|date|$)/i);
  if (lastNameMatch) {
    result.lastName = extractNameFromTranscript(lastNameMatch[1].trim());
  }
  
  const firstNameMatch = transcript.match(/first\s*(?:name)?[:\s]+([^,]+?)(?:,|\.|last|dob|date|$)/i);
  if (firstNameMatch) {
    result.firstName = extractNameFromTranscript(firstNameMatch[1].trim());
  }
  
  if (!result.lastName && !result.firstName) {
    const withoutDob = transcript.replace(/\d{1,2}[\s\-\/]\d{1,2}[\s\-\/]\d{2,4}/g, '').trim();
    const parts = withoutDob.split(/[,\s]+/).filter(p => p.length > 1);
    
    if (parts.length >= 2) {
      result.lastName = extractNameFromTranscript(parts[0]);
      result.firstName = extractNameFromTranscript(parts[1]);
    } else if (parts.length === 1) {
      result.lastName = extractNameFromTranscript(parts[0]);
    }
  }
  
  return result;
}
