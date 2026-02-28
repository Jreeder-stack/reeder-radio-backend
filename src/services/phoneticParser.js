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

const SPOKEN_ORDINALS = {
  'first': 1, '1st': 1,
  'second': 2, '2nd': 2,
  'third': 3, '3rd': 3,
  'fourth': 4, '4th': 4,
  'fifth': 5, '5th': 5,
  'sixth': 6, '6th': 6,
  'seventh': 7, '7th': 7,
  'eighth': 8, '8th': 8,
  'ninth': 9, '9th': 9,
  'tenth': 10, '10th': 10,
  'eleventh': 11, '11th': 11,
  'twelfth': 12, '12th': 12,
  'thirteenth': 13, '13th': 13,
  'fourteenth': 14, '14th': 14,
  'fifteenth': 15, '15th': 15,
  'sixteenth': 16, '16th': 16,
  'seventeenth': 17, '17th': 17,
  'eighteenth': 18, '18th': 18,
  'nineteenth': 19, '19th': 19,
  'twentieth': 20, '20th': 20,
  'twenty-first': 21, 'twentyfirst': 21, '21st': 21,
  'twenty-second': 22, 'twentysecond': 22, '22nd': 22,
  'twenty-third': 23, 'twentythird': 23, '23rd': 23,
  'twenty-fourth': 24, 'twentyfourth': 24, '24th': 24,
  'twenty-fifth': 25, 'twentyfifth': 25, '25th': 25,
  'twenty-sixth': 26, 'twentysixth': 26, '26th': 26,
  'twenty-seventh': 27, 'twentyseventh': 27, '27th': 27,
  'twenty-eighth': 28, 'twentyeighth': 28, '28th': 28,
  'twenty-ninth': 29, 'twentyninth': 29, '29th': 29,
  'thirtieth': 30, '30th': 30,
  'thirty-first': 31, 'thirtyfirst': 31, '31st': 31
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
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const numericMatch = cleaned.match(/^\d+$/);
  if (numericMatch) {
    return parseInt(numericMatch[0], 10);
  }
  
  if (SPOKEN_ORDINALS[cleaned] !== undefined) {
    return SPOKEN_ORDINALS[cleaned];
  }
  
  const hyphenated = cleaned.replace(/\s+/g, '-');
  if (SPOKEN_ORDINALS[hyphenated] !== undefined) {
    return SPOKEN_ORDINALS[hyphenated];
  }
  
  const words = cleaned.split(/[\s\-]+/);
  
  if (words.length === 2) {
    const first = SPOKEN_NUMBERS[words[0]];
    const second = SPOKEN_ORDINALS[words[1]];
    if (first !== undefined && first >= 20 && second !== undefined && second < 10) {
      return first + second;
    }
    
    const firstNum = SPOKEN_NUMBERS[words[0]];
    const secondNum = SPOKEN_NUMBERS[words[1]];
    if (firstNum !== undefined && secondNum !== undefined) {
      if (firstNum >= 20 && secondNum < 10) {
        return firstNum + secondNum;
      }
    }
  }
  
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
    
    if (SPOKEN_ORDINALS[cleanWord] !== undefined) {
      currentNumber += SPOKEN_ORDINALS[cleanWord];
      hasNumber = true;
      continue;
    }
    
    if (SPOKEN_NUMBERS[cleanWord] !== undefined) {
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
  
  const dashLetterPattern = /^[a-z](?:[-–\s.][a-z])+$/i;
  const dashLetterMatch = normalized.match(/^(\w{2,})\s+([a-z][-–][a-z](?:[-–][a-z])+)$/i);
  if (dashLetterMatch) {
    const letters = dashLetterMatch[2].split(/[-–]/).join('');
    if (letters.length >= 2) {
      return capitalizeFirst(letters);
    }
    return capitalizeFirst(dashLetterMatch[1]);
  }
  
  if (dashLetterPattern.test(normalized.replace(/\s+/g, '-'))) {
    const letters = normalized.replace(/[-–\s.]+/g, '');
    if (letters.length >= 2) {
      return capitalizeFirst(letters);
    }
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

function makeDOBResult(month, day, year) {
  if (year < 100) {
    year = year > 30 ? 1900 + year : 2000 + year;
  }
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
    return {
      month: month.toString().padStart(2, '0'),
      day: day.toString().padStart(2, '0'),
      year: year.toString(),
      formatted: `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    };
  }
  return null;
}

function spokenWordsToDigits(text) {
  const words = text.split(/\s+/);
  const result = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i].replace(/[,\.]/g, '');
    if (/^\d+$/.test(word)) {
      result.push(word);
      i++;
      continue;
    }
    if (SPOKEN_ORDINALS[word] !== undefined) {
      result.push(SPOKEN_ORDINALS[word].toString());
      i++;
      continue;
    }
    const hyphenated = i + 1 < words.length ? word + '-' + words[i + 1].replace(/[,\.]/g, '') : null;
    if (hyphenated && SPOKEN_ORDINALS[hyphenated] !== undefined) {
      result.push(SPOKEN_ORDINALS[hyphenated].toString());
      i += 2;
      continue;
    }
    if (i + 1 < words.length) {
      const twoWord = word + ' ' + words[i + 1].replace(/[,\.]/g, '');
      const twoNum = parseSpokenNumber(twoWord);
      if (twoNum !== null && twoNum >= 1 && twoNum <= 99) {
        result.push(twoNum.toString());
        i += 2;
        continue;
      }
    }
    if (SPOKEN_NUMBERS[word] !== undefined) {
      result.push(SPOKEN_NUMBERS[word].toString());
      i++;
      continue;
    }
    result.push(word);
    i++;
  }
  return result.join(' ');
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
    .replace(/\bon\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const numericPatterns = [
    /(\d{1,2})\s*[-\/]\s*(\d{1,2})\s*[-\/]\s*(\d{2,4})/,
    /(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})/,
    /\b(\d{2})(\d{2})(\d{4})\b/
  ];
  
  for (const pattern of numericPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      let [_, m, d, y] = match;
      const r = makeDOBResult(parseInt(m), parseInt(d), parseInt(y));
      if (r) return r;
    }
  }
  
  const DOB_MONTH_NAMES = {
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
  
  const monthNames = Object.keys(DOB_MONTH_NAMES).join('|');
  const spokenMonthPattern = new RegExp(`(${monthNames})\\s+(.+)`, 'i');
  const monthMatch = normalized.match(spokenMonthPattern);
  
  if (monthMatch) {
    const month = DOB_MONTH_NAMES[monthMatch[1].toLowerCase()];
    const rest = monthMatch[2];
    
    const dayYearNumeric = rest.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{2,4})$/);
    if (dayYearNumeric) {
      const r = makeDOBResult(month, parseInt(dayYearNumeric[1]), parseInt(dayYearNumeric[2]));
      if (r) return r;
    }
    
    const dayYearSep = rest.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{2,4})\b/);
    if (dayYearSep) {
      const r = makeDOBResult(month, parseInt(dayYearSep[1]), parseInt(dayYearSep[2]));
      if (r) return r;
    }
    
    const words = rest.split(/\s+/).map(w => w.replace(/[,\.]/g, ''));
    let day = null;
    let year = null;
    let dayEndIdx = -1;
    
    for (let i = 0; i < words.length; i++) {
      if (day !== null) break;
      
      const word = words[i];
      
      const numMatch = word.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (numMatch) {
        day = parseInt(numMatch[1]);
        dayEndIdx = i;
        continue;
      }
      
      if (SPOKEN_ORDINALS[word] !== undefined) {
        day = SPOKEN_ORDINALS[word];
        dayEndIdx = i;
        continue;
      }
      
      if (i + 1 < words.length) {
        const hyphenated = word + '-' + words[i + 1];
        if (SPOKEN_ORDINALS[hyphenated] !== undefined) {
          day = SPOKEN_ORDINALS[hyphenated];
          dayEndIdx = i + 1;
          continue;
        }
        const twoWordPhrase = word + ' ' + words[i + 1];
        const twoWordDay = parseSpokenNumber(twoWordPhrase);
        if (twoWordDay !== null && twoWordDay >= 1 && twoWordDay <= 31) {
          day = twoWordDay;
          dayEndIdx = i + 1;
          continue;
        }
      }
      
      const spokenDay = parseSpokenNumber(word);
      if (spokenDay !== null && spokenDay >= 1 && spokenDay <= 31) {
        day = spokenDay;
        dayEndIdx = i;
        continue;
      }
    }
    
    if (day !== null && dayEndIdx < words.length - 1) {
      const yearWords = words.slice(dayEndIdx + 1).join(' ');
      year = parseSpokenYear(yearWords);
    }
    
    if (day !== null && day >= 1 && day <= 31) {
      if (year === null || year < 1900 || year > 2100) {
        year = 1990;
      }
      const r = makeDOBResult(month, day, year);
      if (r) return r;
    }
  }
  
  const allWords = normalized.split(/\s+/).filter(w => w.length > 0);
  
  let monthNum = null;
  let dayNum = null;
  let yearNum = null;
  let parseIdx = 0;
  
  if (allWords.length >= 1) {
    const w = allWords[0].replace(/[,\.]/g, '');
    const asNum = /^\d+$/.test(w) ? parseInt(w) : (SPOKEN_NUMBERS[w] !== undefined ? SPOKEN_NUMBERS[w] : null);
    if (asNum !== null && asNum >= 1 && asNum <= 12) {
      monthNum = asNum;
      parseIdx = 1;
    } else if (asNum === 0 && allWords.length >= 2) {
      const w2 = allWords[1].replace(/[,\.]/g, '');
      const asNum2 = /^\d+$/.test(w2) ? parseInt(w2) : (SPOKEN_NUMBERS[w2] !== undefined ? SPOKEN_NUMBERS[w2] : null);
      if (asNum2 !== null && asNum2 >= 1 && asNum2 <= 12) {
        monthNum = asNum2;
        parseIdx = 2;
      }
    }
  }
  
  if (monthNum !== null && parseIdx < allWords.length) {
    for (let i = parseIdx; i < allWords.length; i++) {
      if (dayNum !== null) break;
      const w = allWords[i].replace(/[,\.]/g, '');
      
      if (SPOKEN_ORDINALS[w] !== undefined && SPOKEN_ORDINALS[w] <= 31) {
        dayNum = SPOKEN_ORDINALS[w];
        parseIdx = i + 1;
        continue;
      }
      if (i + 1 < allWords.length) {
        const w2 = allWords[i + 1].replace(/[,\.]/g, '');
        const hyp = w + '-' + w2;
        if (SPOKEN_ORDINALS[hyp] !== undefined && SPOKEN_ORDINALS[hyp] <= 31) {
          dayNum = SPOKEN_ORDINALS[hyp];
          parseIdx = i + 2;
          continue;
        }
        const isTensPrefix = ['twenty', 'thirty'].includes(w);
        if (isTensPrefix) {
          const tw = w + ' ' + w2;
          const twn = parseSpokenNumber(tw);
          if (twn !== null && twn >= 1 && twn <= 31) {
            dayNum = twn;
            parseIdx = i + 2;
            continue;
          }
        }
      }
      const sn = /^\d+$/.test(w) ? parseInt(w) : (SPOKEN_NUMBERS[w] !== undefined ? SPOKEN_NUMBERS[w] : parseSpokenNumber(w));
      if (sn !== null && sn >= 1 && sn <= 31) {
        dayNum = sn;
        parseIdx = i + 1;
        continue;
      }
      break;
    }
  }
  
  if (monthNum !== null && dayNum !== null && parseIdx < allWords.length) {
    const yearText = allWords.slice(parseIdx).join(' ');
    yearNum = parseSpokenYear(yearText);
  }
  
  if (monthNum !== null && dayNum !== null) {
    if (yearNum === null || yearNum < 1900 || yearNum > 2100) {
      yearNum = 1990;
    }
    const r = makeDOBResult(monthNum, dayNum, yearNum);
    if (r) return r;
  }
  
  const digitized = spokenWordsToDigits(normalized);
  const digitWords = digitized.split(/\s+/).filter(w => /^\d+$/.test(w));
  
  if (digitWords.length >= 3) {
    const m = parseInt(digitWords[0]);
    const d = parseInt(digitWords[1]);
    const remainingDigits = digitWords.slice(2);
    let y;
    
    if (remainingDigits.length === 1) {
      y = parseInt(remainingDigits[0]);
    } else {
      const yearText = remainingDigits.join(' ');
      y = parseSpokenYear(yearText);
      if (y === null) y = parseInt(remainingDigits[remainingDigits.length - 1]);
    }
    
    if (y !== null && y !== undefined) {
      const r = makeDOBResult(m, d, y);
      if (r) return r;
    }
  }
  
  if (digitWords.length === 2) {
    const m = parseInt(digitWords[0]);
    const d = parseInt(digitWords[1]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return makeDOBResult(m, d, 1990);
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
