import { Check, Eye, EyeOff, Lightbulb, Plus, X, XCircle } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SECRET_SET, slugify, type TestResult } from '@home-hub/shared';
import { Button, cx, IconButton, Notice, Row, TextInput, Toggle, type Tone } from '../ui.tsx';

const INPUT_BOX = 'flex h-11 w-full items-center rounded-control bg-sunken px-3.5';

/**
 * Passwords are write-only: the hub never sends one back. A stored secret is
 * shown as "gespeichert" and only replaced when the user chooses to.
 */
export function SecretInput({
  value,
  onChange,
  stored,
  placeholder,
  id,
  ...aria
}: {
  value: string;
  onChange(next: string): void;
  /** A secret is stored on the hub (so "keep it" is possible). */
  stored: boolean;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (value === SECRET_SET) {
    return (
      <div className={cx(INPUT_BOX, 'justify-between gap-3 pr-1.5')}>
        <span className="flex items-center gap-2 text-muted">
          <Check className="size-4 text-ok" aria-hidden />
          Gespeichert
        </span>
        <Button
          id={id}
          size="sm"
          variant="ghost"
          aria-describedby={aria['aria-describedby']}
          onClick={() => {
            onChange('');
            window.setTimeout(() => input.current?.focus(), 0);
          }}
        >
          Ändern
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <TextInput
          ref={input}
          id={id}
          {...aria}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          // Not the user's own password: keep password managers from offering to "update" their hub login.
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="pr-12"
        />
        <IconButton icon={visible ? EyeOff : Eye} label={visible ? 'Verbergen' : 'Anzeigen'} size="sm" className="absolute right-1 top-1" onClick={() => setVisible(!visible)} />
      </div>
      {stored && (
        <button type="button" className="mt-1 text-sm text-accent hover:underline" onClick={() => onChange(SECRET_SET)}>
          Gespeichertes Passwort behalten
        </button>
      )}
    </div>
  );
}

/** Whole numbers; an empty field while typing is allowed and falls back on blur. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  fallback,
  ...rest
}: { value: number; onChange(next: number): void; min: number; max: number; fallback?: number } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max'>) {
  const [text, setText] = useState<string | null>(null);
  return (
    <TextInput
      {...rest}
      inputMode="numeric"
      value={text ?? String(value)}
      onChange={(event) => {
        const raw = event.target.value.replace(/[^\d]/g, '');
        setText(raw);
        if (raw !== '') onChange(Math.min(max, Math.max(min, Number(raw))));
      }}
      onBlur={() => {
        if (text === '') onChange(fallback ?? min);
        setText(null);
      }}
    />
  );
}

/** A switch with an explanation, as a row. */
export function SwitchRow({ title, subtitle, checked, onChange, tone }: { title: string; subtitle?: ReactNode; checked: boolean; onChange(next: boolean): void; tone?: Tone }) {
  return <Row title={<span className="whitespace-normal">{title}</span>} subtitle={subtitle ? <span className="whitespace-normal">{subtitle}</span> : undefined} trailing={<Toggle checked={checked} onChange={onChange} label={title} tone={tone} />} />;
}

/** "How do I prepare the device?" — numbered, short, always visible (nobody finds a collapsed hint when stuck). */
export function HowTo({ title, steps, children }: { title: string; steps?: ReactNode[]; children?: ReactNode }) {
  return (
    <Notice tone="accent" icon={Lightbulb} className="mb-4">
      <p className="font-medium text-fg">{title}</p>
      {steps && (
        <ol className="mt-1.5 list-decimal space-y-1 pl-4.5 marker:text-muted">
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      {children}
    </Notice>
  );
}

/** Result of "Verbindung testen". */
export function TestOutcome({ result, onDismiss, className }: { result: TestResult; onDismiss?: () => void; className?: string }) {
  return (
    <div role="status" className={cx('flex items-start gap-2.5 rounded-control px-3.5 py-3 text-sm', result.ok ? 'bg-ok/15' : 'bg-danger/15', className)}>
      {result.ok ? <Check className="mt-0.5 size-4.5 shrink-0 text-ok" aria-hidden /> : <XCircle className="mt-0.5 size-4.5 shrink-0 text-danger" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{result.message}</p>
        {result.details.length > 0 && (
          <ul className="scroll-area mt-1 max-h-40 space-y-0.5 overflow-y-auto text-muted">
            {result.details.map((line, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && <IconButton icon={X} label="Schließen" size="sm" className="-mr-1.5 -mt-1.5" onClick={onDismiss} />}
    </div>
  );
}

/** Free-text list (IP addresses): type, press Enter or comma. */
export function ChipsInput({ value, onChange, placeholder, validate, id, ...aria }: { value: string[]; onChange(next: string[]): void; placeholder?: string; validate?: (entry: string) => boolean; id?: string; 'aria-describedby'?: string }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    const entries = text
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) return;
    if (validate && !entries.every(validate)) {
      setInvalid(true);
      return;
    }
    onChange([...new Set([...value, ...entries])]);
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((entry) => (
            <li key={entry} className="flex items-center gap-1 rounded-full bg-sunken py-1 pl-3 pr-1 text-sm tabular-nums">
              {entry}
              <button type="button" aria-label={`${entry} entfernen`} className="flex size-6 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg" onClick={() => onChange(value.filter((other) => other !== entry))}>
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <TextInput
          id={id}
          {...aria}
          aria-invalid={invalid || undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKey}
          onBlur={commit}
          placeholder={placeholder}
          inputMode="decimal"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button icon={Plus} onClick={commit} disabled={text.trim() === ''}>
          Hinzufügen
        </Button>
      </div>
      {invalid && <p className="mt-1 text-sm text-danger">Das sieht nicht nach einer Adresse aus (Beispiel: 192.168.1.40).</p>}
    </div>
  );
}

/** What the hub accepts as a device address (mirrors the hub's validation so mistakes show up while typing). */
export function isHost(text: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:\d{1,5})?$/.test(text.trim());
}

/** A new, unique device id derived from its name. Ids never change afterwards (history and favourites hang on them). */
export function uniqueId(name: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const base = (/[a-z0-9]/i.test(name.normalize('NFKD')) ? slugify(name) : fallback).slice(0, 28).replace(/-+$/, '') || fallback;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
