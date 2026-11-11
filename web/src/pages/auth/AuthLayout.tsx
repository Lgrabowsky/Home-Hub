import type { ReactNode } from 'react';
import { Logo } from '../../components/Logo.tsx';

export function AuthLayout({ title, text, children, footer }: { title: string; text?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="safe-top safe-bottom flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo className="mb-5 size-16" />
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {text && <p className="mt-2 text-muted">{text}</p>}
        </div>
        {children}
        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      </div>
    </main>
  );
}
