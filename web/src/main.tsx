import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { isNative } from './lib/platform.ts';
import { initTheme } from './lib/theme.ts';
import './styles.css';

initTheme();

if (isNative) {
  // Camera pictures must not show up in the task switcher or in screenshots.
  void import('@capacitor-community/privacy-screen').then(({ PrivacyScreen }) => PrivacyScreen.enable()).catch(() => {});
  void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide()).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
