const COMMAND_TABLE = [
  { phrases: ['radio check', 'radio chek', 'radio czech', 'radiocheck', 'radio sheck'], response: 'Loud and clear.' },
  { phrases: ['status check', 'status chek', 'statuscheck'], response: 'Go ahead.' },
  { phrases: ['traffic stop', 'trafficstop'], response: 'Copy traffic stop.' },
  { phrases: ['clear', 'i am clear', "i'm clear", 'all clear'], response: 'Copy, clear.' },
  { phrases: ['need assistance', 'requesting assistance', 'request assistance', 'need backup', 'requesting backup'], response: 'Copy. Assistance requested.' },
];

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCommand(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return null;
  }

  const normalizedText = normalizeText(transcript);
  
  for (const command of COMMAND_TABLE) {
    for (const phrase of command.phrases) {
      const normalizedPhrase = normalizeText(phrase);
      if (normalizedText.includes(normalizedPhrase)) {
        return command.response;
      }
    }
  }

  return null;
}

export function getCommandTable() {
  return COMMAND_TABLE.map(c => ({
    phrase: c.phrases[0],
    response: c.response
  }));
}
