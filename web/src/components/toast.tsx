import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { create } from 'zustand';
import { errorMessage } from '../lib/api.ts';
import { cx } from './ui.tsx';

/** Short messages at the bottom of the screen: confirmations and, above all, errors in plain German. */

type Kind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: Kind;
  text: string;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let nextId = 1;

function show(kind: Kind, text: string, ms: number): void {
  const id = nextId++;
  // The same message twice in a row is noise.
  if (useToasts.getState().items.some((item) => item.text === text)) return;
  useToasts.setState((state) => ({ items: [...state.items.slice(-2), { id, kind, text }] }));
  window.setTimeout(() => useToasts.setState((state) => ({ items: state.items.filter((item) => item.id !== id) })), ms);
}

export const toast = {
  success: (text: string) => show('success', text, 2600),
  info: (text: string) => show('info', text, 3500),
  error: (text: string) => show('error', text, 5000),
  /** Shows the message of an `ApiError` (or a generic one). */
  fromError: (err: unknown) => show('error', errorMessage(err), 5000),
};

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info };

export function Toaster() {
  const items = useToasts((state) => state.items);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6" aria-live="polite">
      {items.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div
            key={item.id}
            role={item.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex max-w-md animate-pop items-center gap-2.5 rounded-2xl bg-raised px-4 py-3 text-sm shadow-float"
          >
            <Icon className={cx('size-5 shrink-0', item.kind === 'error' ? 'text-danger' : item.kind === 'success' ? 'text-ok' : 'text-accent')} aria-hidden />
            <span>{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}
