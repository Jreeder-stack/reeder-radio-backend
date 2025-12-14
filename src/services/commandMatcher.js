const COMMAND_TABLE = [
  { phrases: ['radio check', 'radio chek', 'radio czech', 'radiocheck', 'radio sheck', 'radio cook', 'radiothek', 'radio tech', 'radio tek', 'radio deck', 'radio chuck', 'radio chick', 'radio shake', 'radio shack', 'radioshack', 'radio jack', 'radio jeck', 'ready check', 'ready o check', 'radio cheque', 'redio check', 'radio chack'], response: 'Loud and clear.' },
  { phrases: ['status check', 'status chek', 'statuscheck', 'status chuck', 'status sheck', 'state is check'], response: 'Go ahead.' },
  { phrases: ['traffic stop', 'trafficstop', 'traffic stock', 'traffic stuck'], response: 'Copy traffic stop.' },
  { phrases: ['clear', 'i am clear', "i'm clear", 'all clear', 'im clear', 'i clear'], response: 'Copy, clear.' },
  { phrases: ['need assistance', 'requesting assistance', 'request assistance', 'need backup', 'requesting backup', 'need a distance', 'need a sister', 'need assist'], response: 'Copy. Assistance requested.' },
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
