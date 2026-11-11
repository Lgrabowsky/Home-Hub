import { ShieldAlert } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState, PageHeader, Spinner } from '../../components/ui.tsx';
import { useIsAdmin } from '../../store/session.ts';
import { AccountPage } from './AccountPage.tsx';
import { SettingsHome } from './SettingsHome.tsx';

// Administration is rarely used and only by few: keep it out of everybody's initial download.
const ServicesPage = lazy(() => import('./admin/ServicesPage.tsx').then((m) => ({ default: m.ServicesPage })));
const ServiceSettingsPage = lazy(() => import('./admin/ServiceSettingsPage.tsx').then((m) => ({ default: m.ServiceSettingsPage })));
const UsersPage = lazy(() => import('./admin/UsersPage.tsx').then((m) => ({ default: m.UsersPage })));
const AuditPage = lazy(() => import('./admin/AuditPage.tsx').then((m) => ({ default: m.AuditPage })));
const DiagnosticsPage = lazy(() => import('./admin/DiagnosticsPage.tsx').then((m) => ({ default: m.DiagnosticsPage })));

/** The hub enforces this as well; the guard only avoids showing screens that could not load anything. */
function AdminOnly({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Einstellungen" back="/einstellungen" />
        <EmptyState icon={ShieldAlert} title="Nur für Administratoren" text="Für diesen Bereich fehlt dir die Berechtigung." />
      </>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50dvh] items-center justify-center">
          <Spinner className="size-7" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Everything under /einstellungen. */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route index element={<SettingsHome />} />
      <Route path="konto" element={<AccountPage />} />
      <Route path="dienste" element={<AdminOnly><ServicesPage /></AdminOnly>} />
      <Route path="dienste/:key" element={<AdminOnly><ServiceSettingsPage /></AdminOnly>} />
      <Route path="benutzer" element={<AdminOnly><UsersPage /></AdminOnly>} />
      <Route path="protokoll" element={<AdminOnly><AuditPage /></AdminOnly>} />
      <Route path="diagnose" element={<AdminOnly><DiagnosticsPage /></AdminOnly>} />
      <Route path="*" element={<Navigate to="/einstellungen" replace />} />
    </Routes>
  );
}
