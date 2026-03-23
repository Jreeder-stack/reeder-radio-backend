let capturingField = null;
let currentSettings = {};

const ELECTRON_KEY_MAP = {
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
  'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  'F13': 'F13', 'F14': 'F14', 'F15': 'F15', 'F16': 'F16', 'F17': 'F17',
  'F18': 'F18', 'F19': 'F19', 'F20': 'F20', 'F21': 'F21', 'F22': 'F22',
  'F23': 'F23', 'F24': 'F24',
  'Backquote': '`', 'Minus': '-', 'Equal': '=',
  'BracketLeft': '[', 'BracketRight': ']', 'Backslash': '\\',
  'Semicolon': ';', 'Quote': "'", 'Comma': ',', 'Period': '.', 'Slash': '/',
  'Insert': 'Insert', 'Delete': 'Delete', 'Home': 'Home', 'End': 'End',
  'PageUp': 'PageUp', 'PageDown': 'PageDown',
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'NumpadAdd': 'numadd', 'NumpadSubtract': 'numsub',
  'NumpadMultiply': 'nummult', 'NumpadDivide': 'numdiv',
  'NumpadDecimal': 'numdec', 'NumpadEnter': 'Enter',
  'Numpad0': 'num0', 'Numpad1': 'num1', 'Numpad2': 'num2',
  'Numpad3': 'num3', 'Numpad4': 'num4', 'Numpad5': 'num5',
  'Numpad6': 'num6', 'Numpad7': 'num7', 'Numpad8': 'num8', 'Numpad9': 'num9',
  'Space': 'Space', 'Enter': 'Return', 'Backspace': 'Backspace',
  'Tab': 'Tab', 'Escape': 'Escape', 'CapsLock': 'CapsLock',
  'ScrollLock': 'ScrollLock', 'Pause': 'Pause', 'PrintScreen': 'PrintScreen',
  'ContextMenu': 'ContextMenu'
};

const NON_CAPTURABLE = ['MetaLeft', 'MetaRight', 'Power'];

async function loadSettings() {
  currentSettings = await window.electronAPI.getSettings();
  document.getElementById('serverUrl').value = currentSettings.serverUrl || '';
  document.getElementById('pttKeyDisplay').textContent = currentSettings.pttKey || 'None';
  document.getElementById('emergencyKeyDisplay').textContent = currentSettings.emergencyKey || 'None';
  document.getElementById('alwaysOnTop').checked = currentSettings.alwaysOnTop || false;
  document.getElementById('minimizeToTray').checked = currentSettings.minimizeToTray || false;
  document.getElementById('startMinimized').checked = currentSettings.startMinimized || false;
}

function startCapture(field) {
  capturingField = field;
  const display = document.getElementById(field === 'ptt' ? 'pttKeyDisplay' : 'emergencyKeyDisplay');
  const btn = document.getElementById(field === 'ptt' ? 'pttCaptureBtn' : 'emergencyCaptureBtn');
  display.textContent = 'Press any key...';
  display.classList.add('capturing');
  btn.textContent = 'Listening';
  btn.classList.add('active');
}

function clearKey(field) {
  if (field === 'ptt') {
    currentSettings.pttKey = '';
    document.getElementById('pttKeyDisplay').textContent = 'None';
  } else {
    currentSettings.emergencyKey = '';
    document.getElementById('emergencyKeyDisplay').textContent = 'None';
  }
}

function codeToElectronAccelerator(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('CmdOrCtrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const code = e.code;
  if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'].includes(code)) {
    return parts.length > 0 ? parts.join('+') : null;
  }

  let key = ELECTRON_KEY_MAP[code];
  if (!key) {
    if (code.startsWith('Key')) key = code.slice(3);
    else if (code.startsWith('Digit')) key = code.slice(5);
    else key = e.key;
  }

  parts.push(key);
  return parts.join('+');
}

document.addEventListener('keydown', (e) => {
  if (!capturingField) return;
  e.preventDefault();
  e.stopPropagation();

  if (NON_CAPTURABLE.includes(e.code)) return;
  if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) return;

  const accel = codeToElectronAccelerator(e);
  if (!accel) return;

  const field = capturingField;
  capturingField = null;

  const display = document.getElementById(field === 'ptt' ? 'pttKeyDisplay' : 'emergencyKeyDisplay');
  const btn = document.getElementById(field === 'ptt' ? 'pttCaptureBtn' : 'emergencyCaptureBtn');

  display.textContent = accel;
  display.classList.remove('capturing');
  btn.textContent = 'Change';
  btn.classList.remove('active');

  if (field === 'ptt') currentSettings.pttKey = accel;
  else currentSettings.emergencyKey = accel;
});

async function saveSettings() {
  const settings = {
    serverUrl: document.getElementById('serverUrl').value.trim(),
    pttKey: currentSettings.pttKey,
    emergencyKey: currentSettings.emergencyKey,
    alwaysOnTop: document.getElementById('alwaysOnTop').checked,
    minimizeToTray: document.getElementById('minimizeToTray').checked,
    startMinimized: document.getElementById('startMinimized').checked
  };

  const result = await window.electronAPI.saveSettings(settings);
  if (result && !result.success && result.error) {
    alert(result.error);
    return;
  }
  window.close();
}

document.addEventListener('DOMContentLoaded', loadSettings);
