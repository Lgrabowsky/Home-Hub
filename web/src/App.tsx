import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { Toaster } from './components/toast.tsx';
import { Spinner } from './components/ui.tsx';
import { ApiError } from './lib/api.ts';
import { EnrollPage } from './pages/auth/EnrollPage.tsx';
import { LoginPage } from './pages/auth/LoginPage.tsx';
import { SetupPage } from './pages/auth/SetupPage.tsx';
import { ConnectPage, LoadingPage, LockedPage, OutdatedPage, UnreachablePage } from './pages/auth/StatusPages.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { RoomPage } from './pages/RoomPage.tsx';
import { RoomsPage } from './pages/RoomsPage.tsx';
import { useSession } from './store/session.ts';

// The bigger sections load on demand, so the first screen appears quickly.
const SecurityPage = lazy(() => import('./pages/security/SecurityPage.tsx').then((m) => ({ default: m.SecurityPage })));
const CameraPage = lazy(() => import('./pages/security/CameraPage.tsx').then((m) => ({ default: m.CameraPage })));
const DoorPage = lazy(() => import('./pages/security/DoorPage.tsx').then((m) => ({ default: m.DoorPage })));
const MusicPage = lazy(() => import('./pages/music/MusicPage.tsx').then((m) => ({ default: m.MusicPage })));
const MorePage = lazy(() => import('./pages/more/MorePage.tsx').then((m) => ({ default: m.MorePage })));
const AutomationsPage = lazy(() => import('./pages/more/AutomationsPage.tsx').then((m) => ({ default: m.AutomationsPage })));
const HousePage = lazy(() => import('./pages/more/HousePage.tsx').then((m) => ({ default: m.HousePage })));
const SettingsRoutes = lazy(() => import('./pages/settings/SettingsRoutes.tsx').then((m) => ({ default: m.SettingsRoutes })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Do not hammer the hub when it said "no"; do retry when it could not be reached.
      retry: (failures, error) => failures < 2 && (!(error instanceof ApiError) || error.isNetwork || error.status >= 500),
    },
  },
});

function PageFallback() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

function SignedIn() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="raeume" element={<RoomsPage />} />
          <Route path="raeume/:roomId" element={<RoomPage />} />
          <Route path="sicherheit" element={<Suspense fallback={<PageFallback />}><SecurityPage /></Suspense>} />
          <Route path="sicherheit/kamera/:id" element={<Suspense fallback={<PageFallback />}><CameraPage /></Suspense>} />
          <Route path="sicherheit/tuer/:id" element={<Suspense fallback={<PageFallback />}><DoorPage /></Suspense>} />
          <Route path="musik/*" element={<Suspense fallback={<PageFallback />}><MusicPage /></Suspense>} />
          <Route path="mehr" element={<Suspense fallback={<PageFallback />}><MorePage /></Suspense>} />
          <Route path="mehr/automationen" element={<Suspense fallback={<PageFallback />}><AutomationsPage /></Suspense>} />
          <Route path="mehr/haus" element={<Suspense fallback={<PageFallback />}><HousePage /></Suspense>} />
          <Route path="einstellungen/*" element={<Suspense fallback={<PageFallback />}><SettingsRoutes /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export function App() {
  const phase = useSession((state) => state.phase);
  const init = useSession((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  // Leaving the signed-in area must not leave cached data of the previous user behind.
  useEffect(() => {
    if (phase === 'login' || phase === 'connect') queryClient.clear();
  }, [phase]);

  return (
    <QueryClientProvider client={queryClient}>
      {phase === 'loading' && <LoadingPage />}
      {phase === 'connect' && <ConnectPage />}
      {phase === 'unreachable' && <UnreachablePage />}
      {phase === 'outdated' && <OutdatedPage />}
      {phase === 'setup' && <SetupPage />}
      {phase === 'login' && <LoginPage />}
      {phase === 'enroll' && <EnrollPage />}
      {phase === 'locked' && <LockedPage />}
      {phase === 'ready' && <SignedIn />}
      <Toaster />
    </QueryClientProvider>
  );
}
