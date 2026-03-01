import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.reedersystems.commandcomms',
  appName: 'COMMAND COMMS',
  webDir: 'dist/public',
  server: {
    url: 'https://comms.reeder-systems.com',
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#111111',
      androidSplashResourceName: 'splash',
      showSpinner: false,
      launchFadeOutDuration: 300,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#00FFFF',
      sound: 'beep.wav',
    },
    Geolocation: {
      permissions: ['location', 'locationAlways'],
    },
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: true,
  },
};

export default config;
