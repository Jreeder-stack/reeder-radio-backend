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

const SPOKEN_NUMBERS = {
  'zero': 0, 'oh': 0, 'o': 0,
  'one': 1, 'won': 1,
  'two': 2, 'to': 2, 'too': 2,
  'three': 3,
  'four': 4, 'for': 4,
  'five': 5,
  'six': 6,
  'seven': 7,
  'eight': 8, 'ate': 8,
  'nine': 9,
  'ten': 10,
  'eleven': 11,
  'twelve': 12,
  'thirteen': 13,
  'fourteen': 14,
  'fifteen': 15,
  'sixteen': 16,
  'seventeen': 17,
  'eighteen': 18,
  'nineteen': 19,
  'twenty': 20,
  'thirty': 30,
  'forty': 40,
  'fifty': 50,
  'sixty': 60,
  'seventy': 70,
  'eighty': 80,
  'ninety': 90
};

const SPOKEN_MONTHS = {
  'january': 1, 'jan': 1,
  'february': 2, 'feb': 2,
  'march': 3, 'mar': 3,
  'april': 4, 'apr': 4,
  'may': 5,
  'june': 6, 'jun': 6,
  'july': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sept': 9, 'sep': 9,
  'october': 10, 'oct': 10,
  'november': 11, 'nov': 11,
  'december': 12, 'dec': 12
};

const ORDINAL_SUFFIXES = ['st', 'nd', 'rd', 'th'];

const SINGLE_LETTERS = /^[a-z]$/i;

export function parseSpokenNumber(text) {
  if (!text) return null;
  
  const cleaned = text.toLowerCase()
    .replace(/[,\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const numericMatch = cleaned.match(/^\d+$/);
  if (numericMatch) {
    return parseInt(numericMatch[0], 10);
  }
  
  const words = cleaned.split(/\s+/);
  let result = 0;
  let currentNumber = 0;
  let hasNumber = false;
  
  for (const word of words) {
    const cleanWord = word.replace(/[^a-z0-9]/gi, '');
    
    if (/^\d+$/.test(cleanWord)) {
      currentNumber += parseInt(cleanWord, 10);
      hasNumber = true;
      continue;
    }
    
    let ordinalBase = cleanWord;
    for (const suffix of ORDINAL_SUFFIXES) {
      if (cleanWord.endsWith(suffix)) {
        ordinalBase = cleanWord.slice(0, -suffix.length);
        break;
      }
    }
    
    if (SPOKEN_NUMBERS[ordinalBase] !== undefined) {
      const num = SPOKEN_NUMBERS[ordinalBase];
      if (num >= 100) {
        if (currentNumber === 0) currentNumber = 1;
        currentNumber *= num;
      } else if (num >= 20) {
        currentNumber += num;
      } else {
        currentNumber += num;
      }
      hasNumber = true;
    } else if (SPOKEN_NUMBERS[cleanWord] !== undefined) {
      const num = SPOKEN_NUMBERS[cleanWord];
      if (num >= 100) {
        if (currentNumber === 0) currentNumber = 1;
        currentNumber *= num;
      } else if (num >= 20) {
        currentNumber += num;
      } else {
        currentNumber += num;
      }
      hasNumber = true;
    } else if (cleanWord === 'hundred') {
      if (currentNumber === 0) currentNumber = 1;
      currentNumber *= 100;
      hasNumber = true;
    } else if (cleanWord === 'thousand') {
      if (currentNumber === 0) currentNumber = 1;
      result += currentNumber * 1000;
      currentNumber = 0;
      hasNumber = true;
    }
  }
  
  result += currentNumber;
  
  return hasNumber ? result : null;
}

export function parseSpokenYear(text) {
  if (!text) return null;
  
  const cleaned = text.toLowerCase().trim();
  
  const numericMatch = cleaned.match(/^\d{4}$/);
  if (numericMatch) {
    return parseInt(numericMatch[0], 10);
  }
  
  const twoDigitMatch = cleaned.match(/^\d{2}$/);
  if (twoDigitMatch) {
    const num = parseInt(twoDigitMatch[0], 10);
    return num > 30 ? 1900 + num : 2000 + num;
  }
  
  const words = cleaned.split(/\s+/);
  
  if (words.length >= 2) {
    const first = parseSpokenNumber(words[0]);
    const second = parseSpokenNumber(words.slice(1).join(' '));
    
    if (first !== null && second !== null) {
      if (first >= 19 && first <= 20 && second >= 0 && second <= 99) {
        return first * 100 + second;
      }
      if (first >= 1 && first <= 31 && second >= 1900 && second <= 2100) {
        return second;
      }
    }
    
    const fullNumber = parseSpokenNumber(cleaned);
    if (fullNumber !== null && fullNumber >= 1900 && fullNumber <= 2100) {
      return fullNumber;
    }
  }
  
  const singleNumber = parseSpokenNumber(cleaned);
  if (singleNumber !== null) {
    if (singleNumber >= 1900 && singleNumber <= 2100) {
      return singleNumber;
    }
    if (singleNumber >= 0 && singleNumber <= 99) {
      return singleNumber > 30 ? 1900 + singleNumber : 2000 + singleNumber;
    }
  }
  
  return null;
}

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
  
  let normalized = text.toLowerCase()
    .replace(/\bof\b/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\bborn\b/g, ' ')
    .replace(/\bdob\b/g, ' ')
    .replace(/\bdate of birth\b/g, ' ')
    .replace(/\bis\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const numericPatterns = [
    /(\d{1,2})\s*[-\/]\s*(\d{1,2})\s*[-\/]\s*(\d{2,4})/,
    /(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})/,
    /(\d{1,2})\s*(\d{1,2})\s*(\d{4})/
  ];
  
  for (const pattern of numericPatterns) {
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
  
  const monthNames = Object.keys(SPOKEN_MONTHS).join('|');
  const spokenMonthPattern = new RegExp(`(${monthNames})\\s+(.+)`, 'i');
  const monthMatch = normalized.match(spokenMonthPattern);
  
  if (monthMatch) {
    const month = SPOKEN_MONTHS[monthMatch[1].toLowerCase()];
    const rest = monthMatch[2];
    
    const dayYearNumeric = rest.match(/(\d{1,2})\s*,?\s*(\d{2,4})/);
    if (dayYearNumeric) {
      let day = parseInt(dayYearNumeric[1]);
      let year = parseInt(dayYearNumeric[2]);
      if (year < 100) year = year > 30 ? 1900 + year : 2000 + year;
      
      if (day >= 1 && day <= 31) {
        return {
          month: month.toString().padStart(2, '0'),
          day: day.toString().padStart(2, '0'),
          year: year.toString(),
          formatted: `${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${year}`
        };
      }
    }
    
    const words = rest.split(/\s+/);
    let day = null;
    let year = null;
    let dayIdx = -1;
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[,\.]/g, '');
      
      let ordinalBase = word;
      for (const suffix of ORDINAL_SUFFIXES) {
        if (word.endsWith(suffix)) {
          ordinalBase = word.slice(0, -suffix.length);
          break;
        }
      }
      
      const numMatch = word.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (numMatch && day === null) {
        day = parseInt(numMatch[1]);
        dayIdx = i;
        continue;
      }
      
      const spokenDay = parseSpokenNumber(ordinalBase);
      if (spokenDay !== null && spokenDay >= 1 && spokenDay <= 31 && day === null) {
        day = spokenDay;
        dayIdx = i;
        continue;
      }
    }
    
    if (day !== null && dayIdx < words.length - 1) {
      const yearWords = words.slice(dayIdx + 1).join(' ');
      year = parseSpokenYear(yearWords);
    }
    
    if (day !== null && day >= 1 && day <= 31) {
      if (year === null || year < 1900 || year > 2100) {
        year = 1990;
      }
      
      return {
        month: month.toString().padStart(2, '0'),
        day: day.toString().padStart(2, '0'),
        year: year.toString(),
        formatted: `${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${year}`
      };
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
  
  const normalized = transcript.toLowerCase();
  
  const dobPatterns = [
    /(?:dob|date of birth|born|birthday)\s*[:\s]?\s*(.+?)(?:$|first\s*name|last\s*name)/i,
    /(?:dob|date of birth|born|birthday)\s*[:\s]?\s*(.+)/i
  ];
  
  for (const pattern of dobPatterns) {
    const match = transcript.match(pattern);
    if (match) {
      result.dob = parseDOB(match[1]);
      if (result.dob) break;
    }
  }
  
  if (!result.dob) {
    const numericDobMatch = transcript.match(/(\d{1,2}[\s\-\/]\d{1,2}[\s\-\/]\d{2,4})/);
    if (numericDobMatch) {
      result.dob = parseDOB(numericDobMatch[1]);
    }
  }
  
  const lastNamePatterns = [
    /last\s*(?:name)?[:\s]+([^,\.]+?)(?:,|\.|first|dob|date|born|$)/i,
    /last\s*(?:name)?\s+is\s+([^,\.]+?)(?:,|\.|first|dob|date|born|$)/i,
    /surname[:\s]+([^,\.]+?)(?:,|\.|first|dob|date|born|$)/i
  ];
  
  for (const pattern of lastNamePatterns) {
    const match = transcript.match(pattern);
    if (match) {
      result.lastName = extractNameFromTranscript(match[1].trim());
      break;
    }
  }
  
  const firstNamePatterns = [
    /first\s*(?:name)?[:\s]+([^,\.]+?)(?:,|\.|last|dob|date|born|$)/i,
    /first\s*(?:name)?\s+is\s+([^,\.]+?)(?:,|\.|last|dob|date|born|$)/i,
    /given\s*name[:\s]+([^,\.]+?)(?:,|\.|last|dob|date|born|$)/i
  ];
  
  for (const pattern of firstNamePatterns) {
    const match = transcript.match(pattern);
    if (match) {
      result.firstName = extractNameFromTranscript(match[1].trim());
      break;
    }
  }
  
  if (!result.lastName && !result.firstName) {
    let withoutDob = transcript
      .replace(/\d{1,2}[\s\-\/]\d{1,2}[\s\-\/]\d{2,4}/g, '')
      .replace(/(?:dob|date of birth|born|birthday)\s*[:\s]?\s*.*/i, '')
      .trim();
    
    const monthNames = Object.keys(SPOKEN_MONTHS).join('|');
    const monthPattern = new RegExp(`(${monthNames})\\s+\\S+\\s+\\S+`, 'gi');
    withoutDob = withoutDob.replace(monthPattern, '').trim();
    
    const cleanedParts = withoutDob
      .replace(/[,\.]/g, ' ')
      .split(/\s+/)
      .filter(p => p.length > 1 && !['and', 'the', 'is', 'a', 'an'].includes(p.toLowerCase()));
    
    if (cleanedParts.length >= 2) {
      result.lastName = capitalizeFirst(cleanedParts[0]);
      result.firstName = capitalizeFirst(cleanedParts[1]);
    } else if (cleanedParts.length === 1) {
      result.lastName = capitalizeFirst(cleanedParts[0]);
    }
  }
  
  return result;
}
