const COMMAND_TABLE = [
  { phrases: ['radio check'], response: 'Loud and clear.' },
  { phrases: ['status check'], response: 'Go ahead.' },
  { phrases: ['traffic stop'], response: 'Copy traffic stop.' },
  { phrases: ['clear'], response: 'Copy, clear.' },
  { phrases: ['need assistance', 'requesting assistance'], response: 'Copy. Assistance requested.' },
];

export function matchCommand(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return null;
  }

  const normalizedText = transcript.toLowerCase().trim();
  
  for (const command of COMMAND_TABLE) {
    for (const phrase of command.phrases) {
      if (normalizedText.includes(phrase)) {
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
