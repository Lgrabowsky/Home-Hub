import { ChevronRight, Disc3, Heart, History, ListMusic, Mic2, Music2, Play, Podcast, Search, Speaker, TrendingUp, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MediaItem, MediaPage, MusicGroup, PlayRequest, SpotifySearchResult, SpotifyStatus } from '@home-hub/shared';
import {
  Cover,
  GroupingSheet,
  groupSubtitle,
  ItemMenu,
  ItemRow,
  NowPlayingSheet,
  playOn,
  sourceBadge,
  TransportButtons,
  useTargetGroup,
} from '../../components/music/parts.tsx';
import { Badge, Button, Card, cx, EmptyState, Notice, PageHeader, Section, Segmented, Slider, Spinner, TextInput } from '../../components/ui.tsx';
import { groupCommand } from '../../lib/actions.ts';
import { errorMessage, get } from '../../lib/api.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useIsAdmin } from '../../store/session.ts';

const FOLDER_ICONS: Record<string, LucideIcon> = { playlists: ListMusic, tracks: Heart, albums: Disc3, recent: History, top: TrendingUp, shows: Podcast };
const browsePath = (id: string) => `/musik/b/${encodeURIComponent(id)}`;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Shows where the next "play" goes and lets the user change it. */
function TargetBar({ group, onChange }: { group: MusicGroup | undefined; onChange(group: MusicGroup): void }) {
  const groups = useHub((state) => state.music.groups);
  if (groups.length === 0) return null;
  return (
    <div className="no-scrollbar -mx-4 mb-4 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="radiogroup" aria-label="Abspielen in">
      <span className="shrink-0 text-sm text-muted">Abspielen in</span>
      {groups.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={entry.id === group?.id}
          onClick={() => onChange(entry)}
          className={cx(
            'flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition',
            entry.id === group?.id ? 'bg-music/20 text-fg ring-1 ring-music/50' : 'bg-surface text-muted shadow-tile hover:text-fg',
          )}
        >
          <Speaker className="size-4" aria-hidden />
          {entry.name}
        </button>
      ))}
    </div>
  );
}

function GroupCard({ group, selected, onOpen }: { group: MusicGroup; selected: boolean; onOpen(): void }) {
  const can = useCan('music.control');
  const badge = sourceBadge(group);
  const playing = group.state === 'playing';
  return (
    <Card className={cx('p-3.5 transition', selected && 'ring-1 ring-music/50', playing && 'bg-raised')}>
      <div className="flex items-center gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onOpen} aria-label={`${group.name}: Details öffnen`}>
          <Cover src={group.track?.artUrl} className="size-14" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold">{group.name}</span>
              {badge && (
                <Badge tone="music">
                  <badge.icon className="size-3" aria-hidden />
                  {badge.label}
                </Badge>
              )}
            </span>
            <span className={cx('block truncate text-sm', playing ? 'text-fg/80' : 'text-muted')}>{group.track?.title ?? 'Nichts ausgewählt'}</span>
            {group.track && <span className="block truncate text-[13px] text-muted">{groupSubtitle(group)}</span>}
          </span>
        </button>
        <TransportButtons group={group} />
      </div>
      <div className="mt-2.5">
        <Slider thin tone="music" label={`Lautstärke ${group.name}`} value={group.volume} disabled={!can} onCommit={(value) => void groupCommand(group, { action: 'set_volume', value }, { volume: value })} />
      </div>
    </Card>
  );
}

function Rooms({ target, onSelect }: { target: MusicGroup | undefined; onSelect(group: MusicGroup): void }) {
  const music = useHub((state) => state.music);
  const sonos = useHub((state) => state.services.sonos);
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const [grouping, setGrouping] = useState(false);

  // Deep link from a room page or the mini player: select that room (and open it).
  useEffect(() => {
    const playerId = params.get('raum');
    if (!playerId) return;
    const group = music.groups.find((entry) => entry.memberIds.includes(playerId));
    if (group) {
      onSelect(group);
      if (params.get('offen')) setOpen(group.id);
    }
    setParams({}, { replace: true });
  }, [params, music.groups, onSelect, setParams]);

  const groups = useMemo(() => [...music.groups].sort((a, b) => Number(b.state === 'playing') - Number(a.state === 'playing') || a.name.localeCompare(b.name, 'de')), [music.groups]);

  if (music.players.length === 0) {
    const offline = sonos?.status === 'offline' || sonos?.status === 'degraded';
    return (
      <Card>
        <EmptyState
          icon={Speaker}
          title={offline ? 'Lautsprecher nicht erreichbar' : 'Noch keine Lautsprecher'}
          text={offline ? (sonos?.message ?? undefined) : isAdmin ? 'Verbinde deine Lautsprecher in den Einstellungen.' : 'Bitte einen Administrator, die Lautsprecher einzurichten.'}
          action={
            isAdmin ? (
              <Link to="/einstellungen/dienste/sonos" className="text-accent underline-offset-4 hover:underline">
                Lautsprecher einrichten
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-2.5">
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          selected={group.id === target?.id}
          onOpen={() => {
            onSelect(group);
            setOpen(group.id);
          }}
        />
      ))}
      <NowPlayingSheet groupId={grouping ? null : open} onClose={() => setOpen(null)} onGroup={() => setGrouping(true)} />
      <GroupingSheet groupId={open} open={grouping} onClose={() => setGrouping(false)} />
    </div>
  );
}

/** Handles "play" for lists of items, including the play-from-here rule inside containers. */
function usePlayer(target: MusicGroup | undefined, context?: { id: string | null; items: MediaItem[] }) {
  const [menu, setMenu] = useState<MediaItem | null>(null);
  const play = (item: MediaItem, mode: PlayRequest['mode'] = 'now') => {
    const inContext = context?.id && item.type === 'track' && mode === 'now';
    void playOn(target, {
      itemId: item.id,
      mode,
      title: item.title,
      contextId: inContext ? context.id : undefined,
      index: inContext ? context.items.findIndex((entry) => entry.id === item.id) : undefined,
    });
  };
  const menuSheet = (
    <ItemMenu
      item={menu}
      onClose={() => setMenu(null)}
      onPick={(mode) => {
        if (menu) play(menu, mode);
        setMenu(null);
      }}
    />
  );
  return { play, setMenu, menuSheet };
}

function ItemList({ items, target, context, numbered }: { items: MediaItem[]; target: MusicGroup | undefined; context?: { id: string | null; items: MediaItem[] }; numbered?: boolean }) {
  const navigate = useNavigate();
  const can = useCan('music.control');
  const { play, setMenu, menuSheet } = usePlayer(target, context);
  return (
    <>
      <Card className="divide-y divide-line overflow-hidden py-1">
        {items.map((item, index) => (
          <ItemRow
            key={`${item.id}-${index}`}
            item={item}
            number={numbered ? index + 1 : undefined}
            onOpen={item.browsable ? () => navigate(browsePath(item.id)) : undefined}
            onPlay={item.playable && can ? () => play(item) : undefined}
            onMenu={item.playable && can ? () => setMenu(item) : undefined}
          />
        ))}
      </Card>
      {menuSheet}
    </>
  );
}

function SpotifyUnavailable({ status }: { status: SpotifyStatus | undefined }) {
  const isAdmin = useIsAdmin();
  return (
    <Card>
      <EmptyState
        icon={Music2}
        title={status?.configured ? 'Spotify ist noch nicht verbunden' : 'Spotify ist nicht eingerichtet'}
        text={isAdmin ? 'Verbinde ein Spotify-Konto, um hier zu suchen und deine Playlists zu sehen.' : 'Bitte einen Administrator, Spotify zu verbinden. Favoriten funktionieren auch ohne.'}
        action={
          isAdmin ? (
            <Link to="/einstellungen/dienste/spotify" className="text-accent underline-offset-4 hover:underline">
              Spotify einrichten
            </Link>
          ) : undefined
        }
      />
    </Card>
  );
}

function Discover({ target }: { target: MusicGroup | undefined }) {
  const navigate = useNavigate();
  const can = useCan('music.control');
  const hasSpeakers = useHub((state) => state.music.players.length > 0);
  const linked = useHub((state) => state.music.spotify.linked);
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), 350);
  const searching = term.length >= 2;

  const status = useQuery({ queryKey: ['spotify-status'], queryFn: () => get<SpotifyStatus>('/api/spotify/status'), staleTime: 60_000 });
  const favorites = useQuery({ queryKey: ['music-favorites'], queryFn: () => get<{ items: MediaItem[] }>('/api/music/favorites'), enabled: hasSpeakers, staleTime: 60_000 });
  const library = useQuery({ queryKey: ['spotify-browse', 'home'], queryFn: () => get<MediaPage>('/api/spotify/browse?id=home'), enabled: linked, staleTime: 5 * 60_000 });
  const search = useQuery({
    queryKey: ['spotify-search', term],
    queryFn: () => get<SpotifySearchResult>(`/api/spotify/search?q=${encodeURIComponent(term)}`),
    enabled: linked && searching,
    staleTime: 60_000,
  });
  const { play, menuSheet } = usePlayer(target);

  const sections: [string, MediaItem[]][] = search.data
    ? [
        ['Titel', search.data.tracks],
        ['Alben', search.data.albums],
        ['Playlists', search.data.playlists],
        ['Künstler', search.data.artists],
      ]
    : [];

  return (
    <div>
      {linked && (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-faint" aria-hidden />
          <TextInput value={text} onChange={(event) => setText(event.target.value)} placeholder="Titel, Alben, Künstler suchen" aria-label="Musik suchen" className="pl-11 pr-11" enterKeyHint="search" />
          {text && (
            <button type="button" aria-label="Suche leeren" className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:text-fg" onClick={() => setText('')}>
              <X className="size-4.5" aria-hidden />
            </button>
          )}
        </div>
      )}

      {linked && searching ? (
        search.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : search.isError ? (
          <Notice tone="danger">{errorMessage(search.error)}</Notice>
        ) : sections.every(([, items]) => items.length === 0) ? (
          <EmptyState icon={Search} title={`Nichts gefunden für „${term}“`} />
        ) : (
          sections.map(
            ([title, items]) =>
              items.length > 0 && (
                <Section key={title} title={title}>
                  <ItemList items={items} target={target} />
                </Section>
              ),
          )
        )
      ) : (
        <>
          {(favorites.data?.items.length ?? 0) > 0 && (
            <Section title="Favoriten">
              <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]">
                {favorites.data!.items.map((item) => (
                  <button key={item.id} type="button" disabled={!can} className="group text-left disabled:opacity-60" onClick={() => play(item)} aria-label={`${item.title} abspielen`}>
                    <span className="relative block">
                      <Cover src={item.artUrl} className="w-full rounded-2xl shadow-tile" />
                      <span className="absolute bottom-1.5 right-1.5 flex size-9 items-center justify-center rounded-full bg-music text-black opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-visible:opacity-100">
                        <Play className="size-4" aria-hidden />
                      </span>
                    </span>
                    <span className="mt-1.5 block truncate text-sm font-medium">{item.title}</span>
                    {item.subtitle && <span className="block truncate text-xs text-muted">{item.subtitle}</span>}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {linked ? (
            <Section title="Deine Musik">
              {library.isPending ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : library.isError ? (
                <Notice tone="danger">{errorMessage(library.error)}</Notice>
              ) : (
                <Card className="divide-y divide-line overflow-hidden">
                  {library.data.items.map((folder) => {
                    const Icon = FOLDER_ICONS[folder.id] ?? Mic2;
                    return (
                      <button key={folder.id} type="button" className="flex min-h-14 w-full items-center gap-3 px-4 text-left transition hover:bg-sunken/60" onClick={() => navigate(browsePath(folder.id))}>
                        <span className="flex size-9 items-center justify-center rounded-full bg-music/15 text-music">
                          <Icon className="size-4.5" aria-hidden />
                        </span>
                        <span className="flex-1 font-medium">{folder.title}</span>
                        <ChevronRight className="size-4.5 text-faint" aria-hidden />
                      </button>
                    );
                  })}
                </Card>
              )}
            </Section>
          ) : (
            !status.isPending && <SpotifyUnavailable status={status.data} />
          )}
        </>
      )}
      {menuSheet}
    </div>
  );
}

function MusicHome() {
  const { group: target, select } = useTargetGroup();
  const [tab, setTab] = useState<'rooms' | 'discover'>('rooms');
  return (
    <>
      <PageHeader title="Musik" />
      <Segmented
        className="mb-4 lg:hidden"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'rooms', label: 'Räume' },
          { value: 'discover', label: 'Entdecken' },
        ]}
      />
      <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8">
        <div className={cx(tab !== 'rooms' && 'hidden lg:block')}>
          <Rooms target={target} onSelect={select} />
        </div>
        <div className={cx(tab !== 'discover' && 'hidden lg:block')}>
          <TargetBar group={target} onChange={select} />
          <Discover target={target} />
        </div>
      </div>
    </>
  );
}

/** A library section, album, playlist, artist or podcast. */
function BrowsePage() {
  const { id = '' } = useParams();
  const { group: target, select } = useTargetGroup();
  const can = useCan('music.control');
  const query = useInfiniteQuery({
    queryKey: ['spotify-browse', id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => get<MediaPage>(`/api/spotify/browse?id=${encodeURIComponent(id)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next,
    staleTime: 60_000,
  });
  const first = query.data?.pages[0];
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const self = first?.self ?? null;
  const isTrackList = items.length > 0 && items.every((item) => item.type === 'track' || item.type === 'episode');

  return (
    <>
      <PageHeader title={first?.title ?? 'Musik'} subtitle={first?.subtitle ?? undefined} back="/musik" />
      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <>
          <TargetBar group={target} onChange={select} />
          {(first?.artUrl || self?.playable) && (
            <div className="mb-5 flex items-center gap-4">
              {first?.artUrl && <Cover src={first.artUrl} className="size-28 rounded-2xl shadow-float sm:size-36" />}
              {self?.playable && can && (
                <Button variant="primary" size="lg" icon={Play} onClick={() => void playOn(target, { itemId: self.id, mode: 'now', title: self.title })}>
                  Abspielen
                </Button>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState icon={ListMusic} title="Keine Einträge" text={first?.subtitle ?? undefined} />
          ) : (
            <ItemList items={items} target={target} context={isTrackList ? { id: self?.id ?? null, items } : undefined} numbered={isTrackList && Boolean(self)} />
          )}
          {query.hasNextPage && (
            <Button block className="mt-3" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Mehr laden
            </Button>
          )}
        </>
      )}
    </>
  );
}

export function MusicPage() {
  return (
    <Routes>
      <Route index element={<MusicHome />} />
      <Route path="b/:id" element={<BrowsePage />} />
    </Routes>
  );
}
