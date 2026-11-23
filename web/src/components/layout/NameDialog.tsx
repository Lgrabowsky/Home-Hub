import { useState } from 'react';
import { Button, Field, Sheet, TextInput } from '../ui.tsx';

/** Asks for a name (new area, new room, new name of an area). */
export function NameDialog({
  open,
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel = 'Speichern',
  validate,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** An error text, or null when the name is fine. */
  validate?(name: string): string | null;
  onClose(): void;
  onConfirm(name: string): unknown;
}) {
  if (!open) return null;
  return <Dialog key={title + initial} {...{ title, label, initial, placeholder, confirmLabel, validate, onClose, onConfirm }} />;
}

function Dialog({ title, label, initial, placeholder, confirmLabel, validate, onClose, onConfirm }: Omit<Parameters<typeof NameDialog>[0], 'open'>) {
  const [name, setName] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const error = trimmed ? (validate?.(trimmed) ?? null) : null;
  const confirm = async () => {
    if (!trimmed || error) return;
    setBusy(true);
    try {
      await onConfirm(trimmed);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <Button variant="primary" block loading={busy} disabled={!trimmed || Boolean(error)} onClick={() => void confirm()}>
          {confirmLabel}
        </Button>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <Field label={label} error={error}>
          <TextInput autoFocus value={name} maxLength={60} placeholder={placeholder} onChange={(event) => setName(event.target.value)} />
        </Field>
      </form>
    </Sheet>
  );
}
