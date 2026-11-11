import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android shell around the web app. The app bundles the user interface and
 * talks to the user's own hub over HTTPS; it contains no server addresses and
 * no credentials.
 */
const config: CapacitorConfig = {
  appId: 'io.github.lgrabowsky.homehub',
  appName: 'Home Hub',
  webDir: 'dist-native',
  backgroundColor: '#0a0d12',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0a0d12',
    // The WebView only ever loads the bundled app; everything else opens in the system browser.
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0a0d12',
      androidScaleType: 'CENTER_INSIDE',
      showSpinner: false,
    },
    PrivacyScreen: {
      enable: true,
    },
  },
};

export default config;
