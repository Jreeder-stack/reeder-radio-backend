const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, dialog, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const store = new Store({
  defaults: {
    serverUrl: 'https://comms.reeder-systems.com',
    channelHotkeys: {},
    emergencyKey: 'CmdOrCtrl+Shift+E',
    windowBounds: { width: 1280, height: 800 },
    alwaysOnTop: false,
    minimizeToTray: true,
    startMinimized: false
  }
});

let mainWindow = null;
let settingsWindow = null;
let tray = null;
const activePttChannels = new Set();

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[Electron] Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Electron] App is up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Electron] Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Electron] Update downloaded: v${info.version}`);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded`,
        detail: 'A new version has been downloaded. Would you like to restart and install it now?',
        buttons: ['Install Now', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((result) => {
        if (result.response === 0) {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Electron] Auto-updater error:', err.message);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Electron] Update check failed:', err.message);
  });
}

function checkForUpdatesManually() {
  autoUpdater.checkForUpdates().then((result) => {
    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version',
          detail: `Current version: ${app.getVersion()}`
        });
      }
    }
  }).catch((err) => {
    console.error('[Electron] Manual update check failed:', err.message);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates',
        detail: err.message
      });
    }
  });
}

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
    releaseAllPtt();
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

  createMenu();
}

function injectPttBridge() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      window.__electronPttBridgeReady = true;

      let activeSession = null;

      window.__electronChannelPtt = {
        start(channelId, roomKey) {
          const store = window.__dispatchStore;
          if (!store) { console.error('[Electron] No dispatch store'); return; }

          if (activeSession) {
            this.stop();
          }

          const state = store.getState();
          const session = {
            savedTxIds: [...state.txChannelIds],
            roomKey: roomKey,
            channelId: channelId
          };
          activeSession = session;

          store.setState({ txChannelIds: [channelId] });
          console.log('[Electron] PTT start on channel', channelId, roomKey);
          setTimeout(() => {
            if (activeSession !== session) return;
            window.dispatchEvent(new KeyboardEvent('keydown', {
              code: 'Space', key: ' ', keyCode: 32, which: 32, bubbles: true
            }));
          }, 50);
        },

        stop() {
          if (!activeSession) return;
          const session = activeSession;
          activeSession = null;

          console.log('[Electron] PTT stop, restoring', session.savedTxIds);
          window.dispatchEvent(new KeyboardEvent('keyup', {
            code: 'Space', key: ' ', keyCode: 32, which: 32, bubbles: true
          }));

          const store = window.__dispatchStore;
          if (store) {
            setTimeout(() => {
              store.setState({ txChannelIds: session.savedTxIds });
            }, 200);
          }
        }
      };

      console.log('[Electron] Channel PTT bridge ready');
    })();
  `).catch(() => {});
}

function handleChannelPtt(channelId, roomKey) {
  if (!mainWindow) return;

  if (activePttChannels.has(roomKey)) {
    activePttChannels.delete(roomKey);
    mainWindow.webContents.executeJavaScript(`
      window.__electronChannelPtt && window.__electronChannelPtt.stop();
    `).catch(() => {});
    return;
  }

  if (activePttChannels.size > 0) {
    releaseAllPtt();
  }

  activePttChannels.add(roomKey);
  mainWindow.webContents.executeJavaScript(`
    window.__electronChannelPtt && window.__electronChannelPtt.start(${JSON.stringify(channelId)}, ${JSON.stringify(roomKey)});
  `).catch(() => {});
}

function releaseAllPtt() {
  if (!mainWindow || activePttChannels.size === 0) return;
  activePttChannels.clear();
  mainWindow.webContents.executeJavaScript(`
    window.__electronChannelPtt && window.__electronChannelPtt.stop();
  `).catch(() => {});
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

  const channelHotkeys = store.get('channelHotkeys') || {};
  const emergencyKey = store.get('emergencyKey');

  for (const [accel, mapping] of Object.entries(channelHotkeys)) {
    try {
      const ok = globalShortcut.register(accel, () => {
        handleChannelPtt(mapping.channelId, mapping.roomKey);
      });
      if (ok) {
        console.log(`[Electron] Channel hotkey registered: ${accel} -> ${mapping.channelName}`);
      } else {
        console.error(`[Electron] Failed to register channel hotkey: ${accel}`);
      }
    } catch (err) {
      console.error(`[Electron] Error registering hotkey ${accel}:`, err.message);
    }
  }

  if (emergencyKey) {
    try {
      const ok = globalShortcut.register(emergencyKey, () => {
        simulateEmergency();
      });
      if (ok) {
        console.log(`[Electron] Emergency hotkey registered: ${emergencyKey}`);
      } else {
        console.error(`[Electron] Failed to register emergency hotkey: ${emergencyKey}`);
      }
    } catch (err) {
      console.error(`[Electron] Error registering emergency hotkey:`, err.message);
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
          label: 'Check for Updates',
          click: () => checkForUpdatesManually()
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            const hotkeys = store.get('channelHotkeys') || {};
            const hotkeyList = Object.entries(hotkeys)
              .map(([k, v]) => `  ${k} -> ${v.channelName}`)
              .join('\n') || '  None configured';
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Command Communications',
              message: 'Command Communications by Reeder - Systems',
              detail: `Version ${app.getVersion()}\nDesktop Dispatch Console\n\nChannel Hotkeys:\n${hotkeyList}\n\nEmergency: ${store.get('emergencyKey') || 'None'}`
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
    width: 560,
    height: 700,
    parent: mainWindow,
    modal: true,
    resizable: true,
    minWidth: 450,
    minHeight: 500,
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

ipcMain.handle('open-settings', () => {
  openSettings();
  return { success: true };
});

ipcMain.handle('get-settings', () => {
  return {
    serverUrl: store.get('serverUrl'),
    channelHotkeys: store.get('channelHotkeys') || {},
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

  const hasModifier = (accel) =>
    accel.includes('CmdOrCtrl') || accel.includes('Ctrl') ||
    accel.includes('Alt') || accel.includes('Shift');

  if (settings.channelHotkeys) {
    for (const accel of Object.keys(settings.channelHotkeys)) {
      if (!hasModifier(accel)) {
        return { success: false, error: `Hotkey "${accel}" must include a modifier (Ctrl, Alt, or Shift)` };
      }
    }
  }
  if (settings.emergencyKey && !hasModifier(settings.emergencyKey)) {
    return { success: false, error: 'Emergency hotkey must include a modifier (Ctrl, Alt, or Shift)' };
  }

  if (settings.serverUrl) store.set('serverUrl', settings.serverUrl);
  if (settings.channelHotkeys !== undefined) store.set('channelHotkeys', settings.channelHotkeys);
  if (settings.emergencyKey !== undefined) store.set('emergencyKey', settings.emergencyKey);
  if (settings.alwaysOnTop !== undefined) {
    store.set('alwaysOnTop', settings.alwaysOnTop);
    if (mainWindow) mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  }
  if (settings.minimizeToTray !== undefined) store.set('minimizeToTray', settings.minimizeToTray);
  if (settings.startMinimized !== undefined) store.set('startMinimized', settings.startMinimized);

  registerGlobalHotkeys();
  createMenu();

  if (needsReload && mainWindow) {
    mainWindow.loadURL(settings.serverUrl);
  }

  return { success: true };
});

ipcMain.handle('fetch-channels', async () => {
  if (!mainWindow) return [];
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      fetch('/api/channels/', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (Array.isArray(data) && data.length > 0) return data;
          return fetch('/api/admin/channels', { credentials: 'include' })
            .then(r2 => r2.ok ? r2.json() : [])
            .catch(() => []);
        })
        .catch(() => [])
    `);
    return result || [];
  } catch {
    return [];
  }
});

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerGlobalHotkeys();
  setupAutoUpdater();

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
  releaseAllPtt();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  releaseAllPtt();
  app.isQuitting = true;
});
