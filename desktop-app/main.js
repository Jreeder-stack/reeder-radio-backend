const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, dialog, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    serverUrl: 'https://comms.reeder-systems.com',
    pttKey: 'F5',
    emergencyKey: 'F6',
    windowBounds: { width: 1280, height: 800 },
    alwaysOnTop: false,
    minimizeToTray: true,
    startMinimized: false
  }
});

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let pttActive = false;

function createMainWindow() {
  const bounds = store.get('windowBounds');
  const alwaysOnTop = store.get('alwaysOnTop');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    title: 'Command Communications by Reeder - Systems',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    alwaysOnTop: alwaysOnTop
  });

  const serverUrl = store.get('serverUrl');
  mainWindow.loadURL(serverUrl);

  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isMinimized()) {
      const [width, height] = mainWindow.getSize();
      store.set('windowBounds', { width, height });
    }
  });

  mainWindow.on('close', (e) => {
    if (store.get('minimizeToTray') && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    injectPttBridge();
  });

  mainWindow.webContents.on('did-navigate', () => {
    injectPttBridge();
  });

  mainWindow.webContents.on('did-navigate-in-page', () => {
    injectPttBridge();
  });

  mainWindow.on('blur', () => {
    if (pttActive) {
      pttActive = false;
      simulatePttUp();
    }
  });

  createMenu();
}

function injectPttBridge() {
  if (!mainWindow) return;
  const pttKey = store.get('pttKey') || '';
  mainWindow.webContents.executeJavaScript(`
    (() => {
      if (window.__electronPttCleanup) window.__electronPttCleanup();
      const pttAccel = ${JSON.stringify(pttKey)};
      if (!pttAccel) return;

      function matchesAccel(e) {
        const parts = pttAccel.split('+');
        const key = parts[parts.length - 1];
        const needCtrl = parts.includes('CmdOrCtrl') || parts.includes('Ctrl');
        const needAlt = parts.includes('Alt');
        const needShift = parts.includes('Shift');
        if (needCtrl !== e.ctrlKey) return false;
        if (needAlt !== e.altKey) return false;
        if (needShift !== e.shiftKey) return false;
        const keyLower = key.toLowerCase();
        const eKey = e.key.toLowerCase();
        const eCode = e.code.toLowerCase();
        if (eKey === keyLower || eCode === keyLower || eCode === 'key' + keyLower) return true;
        if (key.match(/^F\\d+$/) && eCode === key.toLowerCase()) return true;
        return false;
      }

      function onDown(e) {
        if (e.repeat) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (!matchesAccel(e)) return;
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new KeyboardEvent('keydown', {
          code: 'Space', key: ' ', keyCode: 32, which: 32, bubbles: true
        }));
      }
      function onUp(e) {
        if (!matchesAccel(e)) return;
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new KeyboardEvent('keyup', {
          code: 'Space', key: ' ', keyCode: 32, which: 32, bubbles: true
        }));
      }
      document.addEventListener('keydown', onDown, { capture: true });
      document.addEventListener('keyup', onUp, { capture: true });
      window.__electronPttCleanup = () => {
        document.removeEventListener('keydown', onDown, { capture: true });
        document.removeEventListener('keyup', onUp, { capture: true });
      };
      console.log('[Electron] PTT bridge ready, mapped key:', pttAccel);
    })();
  `).catch(() => {});
}

function simulatePttDown() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      const event = new KeyboardEvent('keydown', {
        code: 'Space',
        key: ' ',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(event);
    })();
  `).catch(() => {});
}

function simulatePttUp() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      const event = new KeyboardEvent('keyup', {
        code: 'Space',
        key: ' ',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(event);
    })();
  `).catch(() => {});
}

function handleGlobalPtt() {
  if (!mainWindow) return;
  if (mainWindow.isFocused()) {
    return;
  }
  if (!pttActive) {
    pttActive = true;
    simulatePttDown();
    mainWindow.show();
    mainWindow.focus();
  } else {
    pttActive = false;
    simulatePttUp();
  }
}

function simulateEmergency() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('[data-emergency-button]') ||
                  document.querySelector('button.emergency-btn') ||
                  [...document.querySelectorAll('button')].find(b =>
                    b.textContent.includes('EMERGENCY') || b.textContent.includes('E-BTN'));
      if (btn) btn.click();
    })();
  `).catch(() => {});
}

function registerGlobalHotkeys() {
  globalShortcut.unregisterAll();

  const pttKey = store.get('pttKey');
  const emergencyKey = store.get('emergencyKey');

  if (pttKey) {
    const downRegistered = globalShortcut.register(pttKey, () => {
      handleGlobalPtt();
    });
    if (!downRegistered) {
      console.error(`[Electron] Failed to register PTT hotkey: ${pttKey}`);
    } else {
      console.log(`[Electron] PTT hotkey registered: ${pttKey} (toggle mode)`);
    }
  }

  if (emergencyKey) {
    const emergRegistered = globalShortcut.register(emergencyKey, () => {
      simulateEmergency();
    });
    if (!emergRegistered) {
      console.error(`[Electron] Failed to register Emergency hotkey: ${emergencyKey}`);
    } else {
      console.log(`[Electron] Emergency hotkey registered: ${emergencyKey}`);
    }
  }
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings()
        },
        { type: 'separator' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: store.get('alwaysOnTop'),
          click: (menuItem) => {
            store.set('alwaysOnTop', menuItem.checked);
            if (mainWindow) mainWindow.setAlwaysOnTop(menuItem.checked);
          }
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { if (mainWindow) mainWindow.reload(); }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Command Communications',
              message: 'Command Communications by Reeder - Systems',
              detail: `Version ${app.getVersion()}\nDesktop Dispatch Console\n\nGlobal PTT Hotkey: ${store.get('pttKey')}\nEmergency Hotkey: ${store.get('emergencyKey')}`
            });
          }
        },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    parent: mainWindow,
    modal: true,
    resizable: false,
    title: 'Settings',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile('settings.html');

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Settings',
        click: () => openSettings()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Command Communications');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    console.error('[Electron] Tray creation failed:', e.message);
  }
}

ipcMain.handle('get-settings', () => {
  return {
    serverUrl: store.get('serverUrl'),
    pttKey: store.get('pttKey'),
    emergencyKey: store.get('emergencyKey'),
    alwaysOnTop: store.get('alwaysOnTop'),
    minimizeToTray: store.get('minimizeToTray'),
    startMinimized: store.get('startMinimized')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  if (settings.serverUrl) {
    try {
      const parsed = new URL(settings.serverUrl);
      if (parsed.protocol !== 'https:') {
        return { success: false, error: 'Server URL must use HTTPS' };
      }
    } catch {
      return { success: false, error: 'Invalid server URL' };
    }
  }

  const needsReload = settings.serverUrl !== store.get('serverUrl');

  if (settings.serverUrl) store.set('serverUrl', settings.serverUrl);
  if (settings.pttKey !== undefined) store.set('pttKey', settings.pttKey);
  if (settings.emergencyKey !== undefined) store.set('emergencyKey', settings.emergencyKey);
  if (settings.alwaysOnTop !== undefined) {
    store.set('alwaysOnTop', settings.alwaysOnTop);
    if (mainWindow) mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  }
  if (settings.minimizeToTray !== undefined) store.set('minimizeToTray', settings.minimizeToTray);
  if (settings.startMinimized !== undefined) store.set('startMinimized', settings.startMinimized);

  registerGlobalHotkeys();
  createMenu();
  injectPttBridge();

  if (needsReload && mainWindow) {
    mainWindow.loadURL(settings.serverUrl);
  }

  return { success: true };
});

ipcMain.on('ptt-up', () => {
  simulatePttUp();
});

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerGlobalHotkeys();

  if (store.get('startMinimized')) {
    mainWindow.hide();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    mainWindow.show();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
