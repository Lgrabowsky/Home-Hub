import { DoorClosed, DoorOpen, Pencil, Plus, Radar, Search, Sparkles, Trash2, Warehouse, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContactCandidate, ContactMapping, ContactType } from '@home-hub/shared';
import { errorMessage, get } from '../../lib/api.ts';
import { useHub } from '../../store/hub.ts';
import { Badge, Button, cx, EmptyState, Field, Notice, Row, RowGroup, Segmented, Select, Sheet, Spinner, TextInput } from '../ui.tsx';
import { NumberInput, uniqueId } from './parts.tsx';

const TYPE_LABELS: Record<ContactType, string> = { window: 'Fenster', door: 'Tür', garage: 'Garage', motion: 'Bewegungsmelder', other: 'Sonstiges' };
const TYPE_ICONS: Record<ContactType, LucideIcon> = { window: DoorClosed, door: DoorOpen, garage: Warehouse, motion: Radar, other: DoorClosed };
const SYSTEM_LABELS: Record<string, string> = { alarms_logics: 'Logiken', roomtemps: 'Raumregler', accessdoors: 'Zutritt', trends: 'Trends' };
const SOURCE_PATTERN = /^[a-z_]{2,40}\/(item|group)\d{1,5}$/;

const isZero = (raw: string | undefined): boolean => {
  const number = Number.parseFloat(raw ?? '');
  return !Number.isFinite(number) || number === 0;
};

function blankMapping(zone: string): ContactMapping {
  return { id: '', source: '', field: 0, openWhen: 'nonzero', name: '', contactType: 'window', room: '', zone };
}

// --- One mapping ----------------------------------------------------------------------------------

function MappingSheet({
  mapping,
  isNew,
  onClose,
  onApply,
  onRemove,
  liveValue,
}: {
  mapping: ContactMapping | null;
  isNew: boolean;
  onClose(): void;
  onApply(mapping: ContactMapping): void;
  onRemove(): void;
  /** Current raw value of the selected field, when known. */
  liveValue?: (source: string, field: number) => string | undefined;
}) {
  const [draft, setDraft] = useState<ContactMapping | null>(mapping);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    setDraft(mapping);
    setTouched(false);
  }, [mapping]);
  if (!draft) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;

  const set = (changes: Partial<ContactMapping>) => setDraft({ ...draft, ...changes });
  const nameError = touched && draft.name.trim() === '' ? 'Bitte gib dem Kontakt einen Namen.' : null;
  const sourceError = touched && !SOURCE_PATTERN.test(draft.source.trim()) ? 'Erwartet wird z. B. alarms_logics/item12.' : null;
  const raw = liveValue?.(draft.source.trim(), draft.field);
  const openNow = raw === undefined ? null : draft.openWhen === 'nonzero' ? !isZero(raw) : isZero(raw);

  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? 'Kontakt hinzufügen' : draft.name || 'Kontakt'}
      footer={
        <div className="flex gap-2">
          {!isNew && (
            <Button variant="danger" icon={Trash2} onClick={onRemove}>
              Entfernen
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              setTouched(true);
              if (draft.name.trim() === '' || !SOURCE_PATTERN.test(draft.source.trim())) return;
              onApply({ ...draft, name: draft.name.trim(), source: draft.source.trim(), room: draft.room.trim(), zone: draft.zone.trim() });
            }}
          >
            Übernehmen
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name" error={nameError}>
          <TextInput value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="z. B. Terrassentür" maxLength={60} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Art">
            <Select value={draft.contactType} onChange={(event) => set({ contactType: event.target.value as ContactType })}>
              {(Object.keys(TYPE_LABELS) as ContactType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Raum">
            <TextInput value={draft.room} onChange={(event) => set({ room: event.target.value })} placeholder="z. B. Wohnzimmer" maxLength={60} />
          </Field>
        </div>
        <Field label="Zone" hint="Fasst Kontakte zusammen, z. B. „Hülle“ für alles, was nach außen führt.">
          <TextInput value={draft.zone} onChange={(event) => set({ zone: event.target.value })} maxLength={60} />
        </Field>

        <div className="space-y-4 rounded-control bg-sunken p-3.5">
          <p className="text-sm text-muted">Woher der Zustand kommt. Am einfachsten füllst du das über „Kontakt suchen“ aus.</p>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Element am myGEKKO" error={sourceError}>
              <TextInput value={draft.source} onChange={(event) => set({ source: event.target.value })} placeholder="alarms_logics/item12" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="bg-surface font-mono text-sm" />
            </Field>
            <Field label="Wert Nr.">
              <NumberInput value={draft.field} min={0} max={99} onChange={(field) => set({ field })} className="bg-surface" />
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Offen, wenn der Wert …</p>
            <Segmented
              className="w-full"
              value={draft.openWhen}
              onChange={(openWhen) => set({ openWhen })}
              options={[
                { value: 'nonzero', label: 'nicht 0 ist' },
                { value: 'zero', label: '0 ist' },
              ]}
            />
          </div>
          {raw !== undefined && openNow !== null && (
            <p className="text-sm" role="status">
              Aktueller Wert: <span className="font-mono">{raw === '' ? '(leer)' : raw}</span> – das gilt als{' '}
              <span className={cx('font-semibold', openNow ? 'text-warn' : 'text-ok')}>{openNow ? 'offen' : 'geschlossen'}</span>.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// --- Learn mode -----------------------------------------------------------------------------------

interface Change {
  source: string;
  field: number;
  before: string;
  /** The first value seen after the change — what "open" looks like, even if the window is closed again before choosing. */
  openValue: string;
  at: number;
}

function LearnSheet({ open, onClose, onPick, mappings }: { open: boolean; onClose(): void; onPick(mapping: ContactMapping): void; mappings: ContactMapping[] }) {
  const query = useQuery({
    queryKey: ['mygekko-candidates'],
    queryFn: () => get<{ candidates: ContactCandidate[] }>('/api/admin/mygekko/contact-candidates'),
    enabled: open,
    refetchInterval: 1000,
    retry: false,
    gcTime: 0,
  });
  const candidates = query.data?.candidates;
  const baseline = useRef<Map<string, string[]> | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) {
      baseline.current = null;
      setChanges([]);
      setFilter('');
      setShowAll(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !candidates) return;
    if (!baseline.current) {
      baseline.current = new Map(candidates.map((candidate) => [candidate.source, candidate.fields]));
      return;
    }
    const found: Change[] = [];
    for (const candidate of candidates) {
      const before = baseline.current.get(candidate.source);
      if (!before) {
        baseline.current.set(candidate.source, candidate.fields);
        continue;
      }
      candidate.fields.forEach((value, field) => {
        const previous = before[field];
        // A mapping can only tell "0" from "not 0", so only changes across that line can be a contact
        // (this also keeps drifting temperatures and counters out of the list).
        if (previous !== undefined && previous !== value && isZero(previous) !== isZero(value)) found.push({ source: candidate.source, field, before: previous, openValue: value, at: Date.now() });
      });
    }
    if (found.length === 0) return;
    setChanges((known) => {
      const fresh = found.filter((change) => !known.some((other) => other.source === change.source && other.field === change.field));
      return fresh.length > 0 ? [...known, ...fresh] : known;
    });
  }, [candidates, open]);

  const bySource = useMemo(() => new Map((candidates ?? []).map((candidate) => [candidate.source, candidate])), [candidates]);
  const isMapped = (source: string, field: number) => mappings.some((mapping) => mapping.source === source && mapping.field === field);
  const changed = (source: string, field: number) => changes.some((change) => change.source === source && change.field === field);

  const pick = (candidate: ContactCandidate, field: number, openValue: string | null) => {
    const suggestion = candidate.suggestion;
    onPick({
      id: '',
      source: candidate.source,
      field,
      // Learned from a change: whatever the value turned into is "open". Picked by hand: the usual "not 0".
      openWhen: openValue === null ? (suggestion?.field === field ? suggestion.openWhen : 'nonzero') : isZero(openValue) ? 'zero' : 'nonzero',
      name: suggestion?.name ?? candidate.name,
      contactType: suggestion?.contactType ?? 'window',
      room: suggestion?.room ?? candidate.page ?? '',
      zone: '',
    });
  };

  const suggestions = (candidates ?? []).filter((candidate) => candidate.suggestion && candidate.mappedIds.length === 0 && !isMapped(candidate.source, candidate.suggestion.field));
  const needle = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map<string, ContactCandidate[]>();
    for (const candidate of candidates ?? []) {
      if (needle && !`${candidate.name} ${candidate.page ?? ''} ${candidate.source}`.toLowerCase().includes(needle)) continue;
      const list = out.get(candidate.system) ?? [];
      list.push(candidate);
      out.set(candidate.system, list);
    }
    return [...out.entries()];
  }, [candidates, needle]);

  return (
    <Sheet open={open} onClose={onClose} wide title="Kontakt suchen" subtitle="Der Hub beobachtet, was sich am myGEKKO ändert">
      {query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : !candidates ? (
        <div className="flex justify-center py-12">
          <Spinner className="size-7" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-start gap-3 rounded-control bg-accent/15 px-3.5 py-3">
            <span className="relative mt-1 flex size-3 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex size-3 rounded-full bg-accent" />
            </span>
            <p className="text-sm">
              <span className="font-medium">Öffne jetzt das Fenster oder die Tür,</span> die du hinzufügen möchtest, und lass sie einen Moment offen. Was sich dabei ändert, erscheint hier.
            </p>
          </div>

          <section aria-live="polite">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Erkannte Änderungen</h3>
            {changes.length === 0 ? (
              <p className="rounded-control bg-sunken px-3.5 py-3 text-sm text-muted">Noch nichts erkannt. Es kann ein paar Sekunden dauern, bis der myGEKKO die Änderung meldet.</p>
            ) : (
              <ul className="space-y-2">
                {changes.map((change) => {
                  const candidate = bySource.get(change.source);
                  if (!candidate) return null;
                  const mapped = isMapped(change.source, change.field);
                  const label = candidate.fieldLabels[change.field];
                  return (
                    <li key={`${change.source}#${change.field}`} className="flex animate-pop items-center gap-3 rounded-control bg-warn/15 px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{candidate.name}</p>
                        <p className="truncate text-sm text-muted">
                          {SYSTEM_LABELS[candidate.system] ?? candidate.system}
                          {candidate.page ? ` · ${candidate.page}` : ''} · {label || `Wert ${change.field}`}:{' '}
                          <span className="font-mono">
                            {change.before || '–'} → {change.openValue || '–'}
                          </span>
                        </p>
                      </div>
                      {mapped ? (
                        <Badge tone="ok">Schon angelegt</Badge>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => pick(candidate, change.field, change.openValue)}>
                          Das ist es
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {suggestions.length > 0 && (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Vorschläge</h3>
              <RowGroup className="bg-sunken shadow-none">
                {suggestions.map((candidate) => (
                  <Row
                    key={candidate.source}
                    icon={Sparkles}
                    tone="accent"
                    title={candidate.suggestion!.name}
                    subtitle={`${TYPE_LABELS[candidate.suggestion!.contactType]}${candidate.suggestion!.room ? ` · ${candidate.suggestion!.room}` : ''}`}
                    trailing={
                      <Button size="sm" onClick={() => pick(candidate, candidate.suggestion!.field, null)}>
                        Übernehmen
                      </Button>
                    }
                  />
                ))}
              </RowGroup>
            </section>
          )}

          <section>
            <button type="button" className="text-sm font-medium text-accent hover:underline" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Alle Elemente ausblenden' : `Alle ${candidates.length} Elemente mit ihren Werten anzeigen`}
            </button>
            {showAll && (
              <div className="mt-3 space-y-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3.5 top-3 size-5 text-faint" aria-hidden />
                  <TextInput value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Nach Name oder Raum suchen" className="pl-11" aria-label="Elemente durchsuchen" />
                </div>
                {groups.length === 0 && <p className="text-sm text-muted">Nichts gefunden.</p>}
                {groups.map(([system, list]) => (
                  <div key={system}>
                    <p className="mb-1.5 text-sm font-medium">
                      {SYSTEM_LABELS[system] ?? system} <span className="font-normal text-muted">({list.length})</span>
                    </p>
                    <ul className="divide-y divide-line rounded-control bg-sunken">
                      {list.map((candidate) => (
                        <li key={candidate.source} className="px-3.5 py-2.5">
                          <p className="flex items-baseline gap-2">
                            <span className="min-w-0 truncate font-medium">{candidate.name}</span>
                            <span className="shrink-0 truncate text-xs text-faint">{candidate.page}</span>
                            {candidate.mappedIds.length > 0 && <Badge tone="ok" className="ml-auto shrink-0">Kontakt</Badge>}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {candidate.fields.length === 0 && <span className="text-xs text-faint">Keine Werte</span>}
                            {candidate.fields.map((value, field) => (
                              <button
                                key={field}
                                type="button"
                                title={`${candidate.fieldLabels[field] || `Wert ${field}`} – als Kontakt verwenden`}
                                onClick={() => pick(candidate, field, null)}
                                className={cx(
                                  'rounded-md px-1.5 py-0.5 font-mono text-xs transition hover:ring-1 hover:ring-accent',
                                  changed(candidate.source, field) ? 'bg-warn/25 text-fg' : isMapped(candidate.source, field) ? 'bg-ok/20 text-fg' : 'bg-surface text-muted',
                                )}
                              >
                                <span className="text-faint">{field}:</span> {value === '' ? '–' : value}
                              </button>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

// --- The list -------------------------------------------------------------------------------------

export function ContactsEditor({ value, onChange, connected, defaultZone }: { value: ContactMapping[]; onChange(next: ContactMapping[]): void; connected: boolean; defaultZone: string }) {
  const entities = useHub((state) => state.entities);
  const [editing, setEditing] = useState<{ mapping: ContactMapping; index: number | null } | null>(null);
  const [learning, setLearning] = useState(false);
  // Live values for the "this counts as open/closed" line in the editor.
  const live = useQuery({
    queryKey: ['mygekko-candidates'],
    queryFn: () => get<{ candidates: ContactCandidate[] }>('/api/admin/mygekko/contact-candidates'),
    enabled: connected && editing !== null && !learning,
    refetchInterval: 2000,
    retry: false,
    gcTime: 0,
  });
  const liveValue = (source: string, field: number) => live.data?.candidates.find((candidate) => candidate.source === source)?.fields[field];

  const apply = (mapping: ContactMapping) => {
    if (!editing) return;
    if (editing.index === null) {
      onChange([...value, { ...mapping, id: uniqueId(mapping.name, value.map((other) => other.id), 'kontakt') }]);
    } else {
      onChange(value.map((other, index) => (index === editing.index ? mapping : other)));
    }
    setEditing(null);
  };

  return (
    <>
      {value.length === 0 ? (
        <div className="rounded-tile bg-surface shadow-tile">
          <EmptyState
            icon={DoorClosed}
            title="Keine eigenen Zuordnungen"
            text="Meist nicht nötig. Fehlt ein Kontakt, hilft „Kontakt suchen“: Du öffnest das Fenster, der Hub zeigt dir, welcher Wert am myGEKKO darauf reagiert."
          />
        </div>
      ) : (
        <RowGroup>
          {value.map((mapping, index) => {
            const entity = entities[`gekko:contact/${mapping.id}`];
            const Icon = TYPE_ICONS[mapping.contactType];
            return (
              <Row
                key={mapping.id || index}
                icon={Icon}
                tone={entity?.kind === 'contact' && entity.available ? (entity.open ? 'warn' : 'ok') : 'neutral'}
                title={mapping.name}
                subtitle={[TYPE_LABELS[mapping.contactType], mapping.room, mapping.zone].filter(Boolean).join(' · ')}
                trailing={
                  <>
                    {entity?.kind === 'contact' && entity.available && <Badge tone={entity.open ? 'warn' : 'ok'}>{entity.open ? 'Offen' : 'Geschlossen'}</Badge>}
                    <Pencil className="size-4 text-faint" aria-hidden />
                  </>
                }
                onClick={() => setEditing({ mapping, index })}
              />
            );
          })}
        </RowGroup>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" icon={Radar} disabled={!connected} onClick={() => setLearning(true)}>
          Kontakt suchen
        </Button>
        <Button icon={Plus} onClick={() => setEditing({ mapping: blankMapping(defaultZone), index: null })}>
          Von Hand hinzufügen
        </Button>
      </div>
      {!connected && <p className="mt-2 px-1 text-sm text-muted">Zum Suchen muss der myGEKKO verbunden sein: erst die Zugangsdaten oben eintragen und speichern.</p>}

      <LearnSheet
        open={learning}
        onClose={() => setLearning(false)}
        mappings={value}
        onPick={(mapping) => {
          setLearning(false);
          setEditing({ mapping: { ...mapping, zone: defaultZone }, index: null });
        }}
      />
      <MappingSheet
        mapping={editing?.mapping ?? null}
        isNew={editing?.index === null}
        liveValue={liveValue}
        onClose={() => setEditing(null)}
        onApply={apply}
        onRemove={() => {
          if (editing && editing.index !== null) onChange(value.filter((_, index) => index !== editing.index));
          setEditing(null);
        }}
      />
    </>
  );
}
