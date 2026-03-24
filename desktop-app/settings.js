let currentSettings = {};
let allChannels = [];
let channelHotkeys = {};
let captureMode = null;

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
  'Tab': 'Tab', 'Escape': 'Escape'
};

const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'];
const NON_CAPTURABLE = ['MetaLeft', 'MetaRight', 'Power', 'Escape'];

function codeToElectronAccelerator(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('CmdOrCtrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const code = e.code;
  if (MODIFIER_CODES.includes(code)) return null;

  let key = ELECTRON_KEY_MAP[code];
  if (!key) {
    if (code.startsWith('Key')) key = code.slice(3);
    else if (code.startsWith('Digit')) key = code.slice(5);
    else key = e.key;
  }

  parts.push(key);
  return parts.join('+');
}

function hasModifier(accel) {
  return accel.includes('CmdOrCtrl') || accel.includes('Alt') || accel.includes('Shift');
}

async function loadSettings() {
  currentSettings = await window.electronAPI.getSettings();
  channelHotkeys = { ...(currentSettings.channelHotkeys || {}) };

  document.getElementById('serverUrl').value = currentSettings.serverUrl || '';
  document.getElementById('emergencyKeyDisplay').textContent = currentSettings.emergencyKey || 'None';
  document.getElementById('alwaysOnTop').checked = currentSettings.alwaysOnTop || false;
  document.getElementById('minimizeToTray').checked = currentSettings.minimizeToTray || false;
  document.getElementById('startMinimized').checked = currentSettings.startMinimized || false;

  renderAssignedList();
  await loadChannels();
}

async function loadChannels() {
  const select = document.getElementById('channelSelect');
  const btn = document.getElementById('assignBtn');
  select.innerHTML = '<option value="">Loading channels...</option>';
  btn.disabled = true;

  try {
    const channels = await window.electronAPI.fetchChannels();
    allChannels = Array.isArray(channels) ? channels : [];
  } catch {
    allChannels = [];
  }

  updateChannelDropdown();
}

function getChannelRoomKey(ch) {
  return ch.room_key || ((ch.zone || 'Default') + '__' + ch.name);
}

function getAssignedChannelIds() {
  return new Set(Object.values(channelHotkeys).map(m => m.channelId));
}

function updateChannelDropdown() {
  const select = document.getElementById('channelSelect');
  const btn = document.getElementById('assignBtn');
  const assignedIds = getAssignedChannelIds();

  const available = allChannels.filter(ch => !assignedIds.has(ch.id));

  select.innerHTML = '';
  if (available.length === 0) {
    select.innerHTML = '<option value="">No unassigned channels</option>';
    btn.disabled = true;
  } else {
    select.innerHTML = '<option value="">Select a channel...</option>';
    for (const ch of available) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      const zone = ch.zone || 'Default';
      opt.textContent = `${ch.name} (${zone})`;
      select.appendChild(opt);
    }
    btn.disabled = false;
  }

  select.onchange = () => {
    btn.disabled = !select.value;
  };
  btn.disabled = !select.value;
}

function renderAssignedList() {
  const container = document.getElementById('assignedList');
  const empty = document.getElementById('emptyState');
  const entries = Object.entries(channelHotkeys);

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state" id="emptyState">No channel hotkeys assigned</div>';
    return;
  }

  container.innerHTML = '';
  for (const [accel, mapping] of entries) {
    const item = document.createElement('div');
    item.className = 'assigned-item';

    const channelSpan = document.createElement('span');
    channelSpan.className = 'assigned-channel';
    channelSpan.textContent = mapping.channelName + ' ';
    const zoneSpan = document.createElement('span');
    zoneSpan.className = 'zone';
    zoneSpan.textContent = mapping.zone || 'Default';
    channelSpan.appendChild(zoneSpan);

    const hotkeySpan = document.createElement('span');
    hotkeySpan.className = 'assigned-hotkey';
    hotkeySpan.textContent = accel;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeHotkey(accel));

    item.appendChild(channelSpan);
    item.appendChild(hotkeySpan);
    item.appendChild(removeBtn);
    container.appendChild(item);
  }
}

function removeHotkey(accel) {
  delete channelHotkeys[accel];
  renderAssignedList();
  updateChannelDropdown();
}

function startChannelCapture() {
  const select = document.getElementById('channelSelect');
  const selectedValue = select.value;
  if (!selectedValue) return;

  const ch = allChannels.find(c => String(c.id) === String(selectedValue));
  if (!ch) return;

  captureMode = {
    type: 'channel',
    channelId: ch.id,
    channelName: ch.name,
    zone: ch.zone || 'Default',
    roomKey: getChannelRoomKey(ch)
  };

  const overlay = document.getElementById('captureOverlay');
  document.getElementById('captureChannelName').textContent = `${ch.name} (${captureMode.zone})`;
  document.getElementById('captureError').textContent = '';
  overlay.classList.remove('hidden');
}

function startEmergencyCapture() {
  captureMode = { type: 'emergency' };
  const overlay = document.getElementById('captureOverlay');
  document.getElementById('captureChannelName').textContent = 'Emergency Button';
  document.getElementById('captureError').textContent = '';
  overlay.classList.remove('hidden');
}

function cancelCapture() {
  captureMode = null;
  document.getElementById('captureOverlay').classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  if (!captureMode) return;
  e.preventDefault();
  e.stopPropagation();

  if (NON_CAPTURABLE.includes(e.code)) {
    if (e.code === 'Escape') cancelCapture();
    return;
  }
  if (MODIFIER_CODES.includes(e.code)) return;

  const accel = codeToElectronAccelerator(e);
  if (!accel) return;

  if (!hasModifier(accel)) {
    document.getElementById('captureError').textContent =
      'Must include a modifier (Ctrl, Alt, or Shift)';
    return;
  }

  if (captureMode.type === 'channel') {
    const existing = channelHotkeys[accel];
    if (existing) {
      document.getElementById('captureError').textContent =
        `Already assigned to ${existing.channelName}`;
      return;
    }
    if (accel === (currentSettings.emergencyKey || '')) {
      document.getElementById('captureError').textContent =
        'Already used as the Emergency hotkey';
      return;
    }

    channelHotkeys[accel] = {
      channelId: captureMode.channelId,
      channelName: captureMode.channelName,
      zone: captureMode.zone,
      roomKey: captureMode.roomKey
    };

    renderAssignedList();
    updateChannelDropdown();
  } else if (captureMode.type === 'emergency') {
    if (channelHotkeys[accel]) {
      document.getElementById('captureError').textContent =
        `Already assigned to channel ${channelHotkeys[accel].channelName}`;
      return;
    }

    currentSettings.emergencyKey = accel;
    document.getElementById('emergencyKeyDisplay').textContent = accel;
  }

  captureMode = null;
  document.getElementById('captureOverlay').classList.add('hidden');
});

function clearEmergencyKey() {
  currentSettings.emergencyKey = '';
  document.getElementById('emergencyKeyDisplay').textContent = 'None';
}

async function saveSettings() {
  const settings = {
    serverUrl: document.getElementById('serverUrl').value.trim(),
    channelHotkeys: channelHotkeys,
    emergencyKey: currentSettings.emergencyKey || '',
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
