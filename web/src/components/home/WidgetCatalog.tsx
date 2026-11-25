import { Check, Plus, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { HOME_FUNCTIONS, type Entity, type HomeFunction, type HomeWidget } from '@home-hub/shared';
import { useRooms } from '../../hooks/entities.ts';
import { useHub } from '../../store/hub.ts';
import { useLabs } from '../../store/labs.ts';
import { useCan } from '../../store/session.ts';
import { entityStateText } from '../entities/EntityTile.tsx';
import { entityIcon } from '../entities/icons.ts';
import { Button, cx, Sheet, TextInput } from '../ui.tsx';
import { FUNCTION_LABELS, WidgetView, widgetKey } from './widgets.tsx';

/**
 * "+ Kachel": what can go on the start page — by kind, each with a preview of the real tile and a
 * sentence on what it shows and what it does.
 */

type Category = 'bereiche' | 'uebersichten' | 'raeume' | 'kameras' | 'geraete';

const CATEGORY_LABELS: Record<Category, string> = { bereiche: 'Bereiche', uebersichten: 'Übersichten', raeume: 'Räume', kameras: 'Kameras', geraete: 'Geräte' };

const CATEGORY_HINTS: Record<Category, string> = {
  bereiche: 'Eine Kachel je Bereich des Hauses: der Zustand auf einen Blick, Antippen öffnet den Bereich.',
  uebersichten: 'Zusammenfassungen und Listen – zum Anschauen, zum Teil mit Knöpfen.',
  raeume: 'Ein Raum mit Licht, Temperatur und offenen Fenstern. Antippen öffnet den Raum.',
  kameras: 'Das Bild der Kamera, alle paar Sekunden neu. Antippen öffnet das Live-Bild.',
  geraete: 'Ein einzelnes Gerät als Kachel: sein Zustand und Schalten mit einem Tipp.',
};

const FUNCTION_INFO: Record<HomeFunction, string> = {
  licht: 'Wie viele Lichter an sind und in welchen Räumen – mit Knopf „Alle aus“.',
  jalousien: 'Wie viele Jalousien zu sind – mit Knöpfen für alle hoch und alle runter.',
  klima: 'Temperaturen im Haus und ob gerade geheizt wird.',
  sicherheit: 'Welche Fenster und Türen offen sind.',
  zutritt: 'Türen, Tore und Türstationen.',
  geraete: 'Welche Geräte und Steckdosen an sind.',
  musik: 'Was gerade läuft.',
};

interface OverviewEntry {
  type: Exclude<HomeWidget['type'], 'function' | 'entity' | 'camera' | 'room'>;
  title: string;
  info: string;
  size: HomeWidget['size'];
}

const OVERVIEWS: OverviewEntry[] = [
  { type: 'lights', title: 'Lichter-Status', info: 'Welche Lichter an sind, nach Räumen. Nur zum Nachsehen und einzeln Schalten – ohne Knopf, der alle Lichter schaltet.', size: 'small' },
  { type: 'scenes', title: 'Szenen', info: 'Deine Szenen als Knöpfe – ein Tipp startet sie.', size: 'wide' },
  { type: 'favorites', title: 'Favoriten', info: 'Die Geräte, die du mit dem Stern als Favorit markiert hast.', size: 'wide' },
  { type: 'rooms', title: 'Alle Räume', info: 'Alle Räume untereinander, mit Licht, Temperatur und offenen Fenstern.', size: 'wide' },
  { type: 'weather', title: 'Wetter', info: 'Außentemperatur, Wind und Regen von der Wetterstation.', size: 'small' },
  { type: 'timers', title: 'Nächste Zeitschaltuhren', info: 'Was die Zeitschaltuhren als Nächstes tun.', size: 'wide' },
  { type: 'house3d', title: '3D-Haus', info: 'Dein Haus als 3D-Modell.', size: 'small' },
];

/** The real tile, drawn small and not clickable. */
function Preview({ widget, wide }: { widget: HomeWidget; wide?: boolean }) {
  return (
    <div className={cx('pointer-events-none relative max-h-44 select-none overflow-hidden', wide ? 'w-full' : 'w-[min(13rem,100%)]')} aria-hidden inert>
      <WidgetView widget={widget} onDetails={() => {}} />
      {wide && <span className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sunken to-transparent" />}
    </div>
  );
}

function AddButton({ title, added, onAdd }: { title: string; added: boolean; onAdd(): void }) {
  return (
    <Button size="sm" variant={added ? 'ghost' : 'primary'} icon={added ? Check : Plus} disabled={added} onClick={onAdd} aria-label={added ? `${title}: schon auf der Startseite` : `${title} hinzufügen`}>
      {added ? 'Ist drauf' : 'Hinzufügen'}
    </Button>
  );
}

/** A tile with its preview, what it is and the button to add it. */
function Entry({ title, info, preview, added, onAdd }: { title: string; info: string; preview: ReactNode; added: boolean; onAdd(): void }) {
  return (
    <div className={cx('rounded-tile bg-sunken p-3', added && 'opacity-70')}>
      {preview}
      <div className="mt-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="text-sm text-muted">{info}</p>
        </div>
        <AddButton title={title} added={added} onAdd={onAdd} />
      </div>
    </div>
  );
}

export function WidgetCatalog({ open, onClose, current, onAdd }: { open: boolean; onClose(): void; current: HomeWidget[]; onAdd(widget: HomeWidget): void }) {
  const entities = useHub((state) => state.entities);
  const music = useHub((state) => state.music);
  const labs = useLabs((state) => state.house3d);
  const canSecurity = useCan('security.view');
  const rooms = useRooms();
  const [category, setCategory] = useState<Category>('bereiche');
  const [query, setQuery] = useState('');

  const all = useMemo(() => Object.values(entities), [entities]);
  const kinds = new Set(all.map((entity) => entity.kind));
  const functionAvailable: Record<HomeFunction, boolean> = {
    licht: kinds.has('light'),
    jalousien: kinds.has('blind'),
    klima: kinds.has('climate'),
    sicherheit: canSecurity && (kinds.has('contact') || kinds.has('alarm')),
    zutritt: kinds.has('access'),
    geraete: kinds.has('switch'),
    musik: music.players.length > 0,
  };
  const overviewAvailable: Record<OverviewEntry['type'], boolean> = {
    lights: kinds.has('light'),
    scenes: kinds.has('action'),
    favorites: true,
    rooms: true,
    weather: Boolean(entities['gekko:meteo/temperature']),
    timers: true,
    house3d: labs,
  };
  const has = (match: (widget: HomeWidget) => boolean) => current.some(match);
  const media = all.filter((entity): entity is Extract<Entity, { kind: 'camera' | 'door' }> => entity.kind === 'camera' || entity.kind === 'door');
  const q = query.trim().toLowerCase();
  const devices = all
    .filter((entity) => entity.kind !== 'camera' && entity.kind !== 'door' && (q === '' || `${entity.name} ${entity.room ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => `${a.room ?? ''} ${a.name}`.localeCompare(`${b.room ?? ''} ${b.name}`, 'de'))
    .slice(0, q === '' ? 60 : 150);

  const categories = (['bereiche', 'uebersichten', 'raeume', 'kameras', 'geraete'] as const).filter((entry) => (entry === 'raeume' ? rooms.length > 0 : entry === 'kameras' ? media.length > 0 : true));

  return (
    <Sheet open={open} onClose={onClose} title="Kachel hinzufügen" subtitle="Mit Vorschau und Erklärung">
      {/* All kinds visible at once (wrapping), none hidden off the edge. */}
      <div role="tablist" aria-label="Art der Kachel" className="mb-3 flex flex-wrap gap-2">
        {categories.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={value === category}
            onClick={() => setCategory(value)}
            className={cx('h-9 rounded-full px-3.5 text-sm font-medium transition active:scale-95', value === category ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg')}
          >
            {CATEGORY_LABELS[value]}
          </button>
        ))}
      </div>
      <p className="mb-4 px-0.5 text-sm text-muted">{CATEGORY_HINTS[category]}</p>

      {category === 'bereiche' && (
        <div className="flex flex-col gap-3">
          {HOME_FUNCTIONS.filter((fn) => functionAvailable[fn]).map((fn) => {
            const widget: HomeWidget = { key: `preview-${fn}`, size: 'small', type: 'function', function: fn };
            return (
              <Entry
                key={fn}
                title={FUNCTION_LABELS[fn]}
                info={FUNCTION_INFO[fn]}
                preview={<Preview widget={widget} />}
                added={has((w) => w.type === 'function' && w.function === fn)}
                onAdd={() => onAdd({ ...widget, key: widgetKey('fn') })}
              />
            );
          })}
        </div>
      )}

      {category === 'uebersichten' && (
        <div className="flex flex-col gap-3">
          {OVERVIEWS.filter((entry) => overviewAvailable[entry.type]).map((entry) => {
            const widget = { key: `preview-${entry.type}`, size: entry.size, type: entry.type } as HomeWidget;
            return (
              <Entry
                key={entry.type}
                title={entry.title}
                info={entry.info}
                preview={<Preview widget={widget} wide={entry.size !== 'small'} />}
                added={has((w) => w.type === entry.type)}
                onAdd={() => onAdd({ ...widget, key: widgetKey(entry.type) })}
              />
            );
          })}
        </div>
      )}

      {category === 'raeume' && (
        <div className="grid grid-cols-2 gap-2.5">
          {rooms.map((room) => {
            const added = has((w) => w.type === 'room' && (w.room === room.name || w.room === room.id));
            return (
              <div key={room.id} className={cx('flex flex-col gap-2 rounded-tile bg-sunken p-2.5', added && 'opacity-70')}>
                <Preview widget={{ key: `preview-room-${room.id}`, size: 'small', type: 'room', room: room.name }} />
                <AddButton title={room.name} added={added} onAdd={() => onAdd({ key: widgetKey('room'), size: 'small', type: 'room', room: room.name })} />
              </div>
            );
          })}
        </div>
      )}

      {category === 'kameras' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {media.map((entity) => {
            const added = has((w) => w.type === 'camera' && w.entityId === entity.id);
            return (
              <div key={entity.id} className={cx('rounded-tile bg-sunken p-2.5', added && 'opacity-70')}>
                <Preview widget={{ key: `preview-${entity.id}`, size: 'small', type: 'camera', entityId: entity.id }} wide />
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate font-semibold">{entity.name}</p>
                  <AddButton title={entity.name} added={added} onAdd={() => onAdd({ key: widgetKey('cam'), size: 'wide', type: 'camera', entityId: entity.id })} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {category === 'geraete' && (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3.5 top-3.5 size-5 text-faint" aria-hidden />
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gerät oder Raum suchen" aria-label="Gerät oder Raum suchen" className="pl-11" />
          </div>
          <ul className="divide-y divide-line/70 overflow-hidden rounded-tile bg-sunken">
            {devices.map((entity) => {
              const Icon = entityIcon(entity);
              const added = has((w) => w.type === 'entity' && w.entityId === entity.id);
              return (
                <li key={entity.id} className={cx('flex items-center gap-3 px-3.5 py-2.5', added && 'opacity-70')}>
                  <Icon className="size-5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{entity.name}</p>
                    <p className="truncate text-[13px] text-muted">{[entity.room, entity.available ? entityStateText(entity) : 'Nicht erreichbar'].filter(Boolean).join(' · ')}</p>
                  </div>
                  <AddButton title={entity.name} added={added} onAdd={() => onAdd({ key: widgetKey('dev'), size: 'small', type: 'entity', entityId: entity.id })} />
                </li>
              );
            })}
            {devices.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nichts gefunden.</li>}
          </ul>
        </>
      )}
    </Sheet>
  );
}
