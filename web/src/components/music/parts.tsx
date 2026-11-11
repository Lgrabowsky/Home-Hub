import { ListEnd, ListPlus, ListStart, MoreHorizontal, Music2, Pause, Play, Radio, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Speaker, Tv, Unlink, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MediaItem, MusicGroup, MusicPlayer, PlayRequest } from '@home-hub/shared';
import { groupCommand, playerCommand, playMedia } from '../../lib/actions.ts';
import { formatDuration } from '../../lib/format.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useSession } from '../../store/session.ts';
import { HubImage } from '../HubImage.tsx';
import { toast } from '../toast.tsx';
import { Button, cx, IconButton, Row, RowGroup, Sheet, Slider, Toggle } from '../ui.tsx';

export function Cover({ src, className, alt = '' }: { src: string | null | undefined; className?: string; alt?: string }) {
  const fallback = (
    <span className="flex size-full items-center justify-center bg-music/15 text-music">
      <Music2 className="size-1/3" aria-hidden />
    </span>
  );
  return <HubImage src={src ?? null} alt={alt} className={cx('aspect-square shrink-0 overflow-hidden rounded-xl', className)} fallback={fallback} />;
}

/** Which group the next "play" goes to: the user's choice, else something sensible. */
export function useTargetGroup(): { group: MusicGroup | undefined; select(group: MusicGroup): void } {
  const music = useHub((state) => state.music);
  const preferred = useSession((state) => state.prefs.lastMusicPlayerId);
  const group = useMemo(() => {
    const byPlayer = preferred ? music.groups.find((entry) => entry.memberIds.includes(preferred)) : undefined;
    return byPlayer ?? music.groups.find((entry) => entry.state === 'playing') ?? music.groups[0];
  }, [music.groups, preferred]);
  const select = (next: MusicGroup) => {
    if (next.coordinatorId !== preferred) void useSession.getState().savePrefs({ lastMusicPlayerId: next.coordinatorId }).catch(() => {});
  };
  return { group, select };
}

/** Playback position, advancing locally between updates from the hub. */
export function usePosition(group: MusicGroup | undefined): number | null {
  const clockOffset = useHub((state) => state.clockOffset);
  const [, tick] = useState(0);
  const playing = group?.state === 'playing';
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);
  if (!group || group.position === null) return null;
  const elapsed = playing ? (Date.now() + clockOffset - group.positionAt) / 1000 : 0;
  const position = group.position + Math.max(0, elapsed);
  return group.track?.duration ? Math.min(group.track.duration, position) : position;
}

export function sourceBadge(group: MusicGroup): { icon: typeof Tv; label: string } | null {
  switch (group.track?.source) {
    case 'tv':
      return { icon: Tv, label: 'TV' };
    case 'radio':
      return { icon: Radio, label: 'Radio' };
    case 'line_in':
      return { icon: Speaker, label: 'Eingang' };
    default:
      return null;
  }
}

export function groupSubtitle(group: MusicGroup): string {
  if (!group.track) return 'Nichts ausgewählt';
  return [group.track.artist, group.track.album].filter(Boolean).join(' · ') || (group.state === 'playing' ? 'Spielt' : 'Pausiert');
}

export function TransportButtons({ group, large }: { group: MusicGroup; large?: boolean }) {
  const can = useCan('music.control');
  const playing = group.state === 'playing' || group.state === 'transitioning';
  return (
    <div className={cx('flex items-center', large ? 'justify-center gap-5' : 'gap-0.5')}>
      {large && <IconButton icon={SkipBack} label="Vorheriger Titel" size="lg" disabled={!can || !group.canSkip} onClick={() => void groupCommand(group, { action: 'previous' })} />}
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? 'Pause' : 'Wiedergabe'}
        size={large ? 'lg' : 'md'}
        variant={large ? 'filled' : 'plain'}
        tone="music"
        active={large && playing}
        disabled={!can || !group.track}
        onClick={() => void groupCommand(group, { action: playing ? 'pause' : 'play' }, { state: playing ? 'paused' : 'playing' })}
      />
      <IconButton icon={SkipForward} label="Nächster Titel" size={large ? 'lg' : 'md'} disabled={!can || !group.canSkip} onClick={() => void groupCommand(group, { action: 'next' })} />
    </div>
  );
}

export function VolumeRow({ label, value, muted, disabled, onVolume, onMute }: { label: string; value: number; muted: boolean; disabled?: boolean; onVolume(value: number): void; onMute(): void }) {
  return (
    <div className="flex items-center gap-2">
      <IconButton icon={muted ? VolumeX : Volume2} label={muted ? `${label}: Ton an` : `${label}: stumm`} size="sm" active={muted} tone="music" disabled={disabled} onClick={onMute} />
      <Slider thin tone="music" label={`Lautstärke ${label}`} value={value} disabled={disabled} onCommit={onVolume} className="flex-1" />
      <span className="w-8 text-right text-sm tabular-nums text-muted">{Math.round(value)}</span>
    </div>
  );
}

/** Everything about one group: what plays, transport, volume, its speakers. */
export function NowPlayingSheet({ groupId, onClose, onGroup }: { groupId: string | null; onClose(): void; onGroup(): void }) {
  const music = useHub((state) => state.music);
  const can = useCan('music.control');
  const group = music.groups.find((entry) => entry.id === groupId);
  const position = usePosition(group);
  if (!group) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const members = group.memberIds.map((id) => music.players.find((player) => player.id === id)).filter((player): player is MusicPlayer => Boolean(player));
  const track = group.track;
  const RepeatIcon = group.repeat === 'one' ? Repeat1 : Repeat;
  const nextRepeat = group.repeat === 'off' ? 'all' : group.repeat === 'all' ? 'one' : 'off';

  return (
    <Sheet open onClose={onClose} title={group.name} subtitle={track ? undefined : 'Nichts ausgewählt'} wide>
      <div className="sm:flex sm:gap-6">
        <Cover src={track?.artUrl} className="mx-auto w-56 rounded-2xl shadow-float sm:mx-0 sm:w-60" alt={track?.album ?? ''} />
        <div className="mt-5 min-w-0 flex-1 sm:mt-1">
          <p className="truncate text-xl font-bold">{track?.title ?? 'Keine Wiedergabe'}</p>
          <p className="truncate text-muted">{groupSubtitle(group)}</p>

          {track && (
            <div className="mt-4">
              <Slider
                thin
                tone="music"
                label="Position im Titel"
                value={position ?? 0}
                max={track.duration ?? Math.max(1, position ?? 1)}
                disabled={!can || !group.canSeek || !track.duration}
                onCommit={(value) => void groupCommand(group, { action: 'seek', value }, { position: value, positionAt: Date.now() + useHub.getState().clockOffset })}
              />
              <div className="mt-1 flex justify-between text-xs tabular-nums text-muted">
                <span>{formatDuration(position)}</span>
                <span>{track.duration ? formatDuration(track.duration) : 'Live'}</span>
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <IconButton icon={Shuffle} label="Zufällige Reihenfolge" size="sm" active={group.shuffle} tone="music" disabled={!can || !group.canSkip} onClick={() => void groupCommand(group, { action: 'set_shuffle', value: !group.shuffle }, { shuffle: !group.shuffle })} />
            <TransportButtons group={group} large />
            <IconButton icon={RepeatIcon} label="Wiederholen" size="sm" active={group.repeat !== 'off'} tone="music" disabled={!can || !group.canSkip} onClick={() => void groupCommand(group, { action: 'set_repeat', value: nextRepeat }, { repeat: nextRepeat })} />
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-3 rounded-tile bg-sunken p-4">
        {members.length > 1 && (
          <VolumeRow
            label="Alle"
            value={group.volume}
            muted={group.muted}
            disabled={!can}
            onVolume={(value) => void groupCommand(group, { action: 'set_volume', value }, { volume: value })}
            onMute={() => void groupCommand(group, { action: 'set_mute', value: !group.muted }, { muted: !group.muted })}
          />
        )}
        {members.map((player) => (
          <div key={player.id} className={cx(!player.available && 'opacity-50')}>
            <div className="mb-0.5 flex items-center justify-between gap-2 pl-1">
              <span className="truncate text-sm font-medium">{player.name}</span>
              {members.length > 1 && player.id !== group.coordinatorId && can && (
                <button type="button" className="flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => void playerCommand(player, { action: 'leave' })}>
                  <Unlink className="size-3.5" aria-hidden /> Aus Gruppe lösen
                </button>
              )}
            </div>
            <VolumeRow
              label={player.name}
              value={player.volume}
              muted={player.muted}
              disabled={!can || !player.available}
              onVolume={(value) => void playerCommand(player, { action: 'set_volume', value }, { volume: value })}
              onMute={() => void playerCommand(player, { action: 'set_mute', value: !player.muted }, { muted: !player.muted })}
            />
          </div>
        ))}
        {can && music.players.length > 1 && (
          <Button block size="sm" icon={Speaker} onClick={onGroup}>
            Räume gruppieren
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** Add or remove speakers from the selected group. */
export function GroupingSheet({ groupId, open, onClose }: { groupId: string | null; open: boolean; onClose(): void }) {
  const music = useHub((state) => state.music);
  const group = music.groups.find((entry) => entry.id === groupId);
  if (!group) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const others = music.players.filter((player) => !group.memberIds.includes(player.id) && player.available);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Räume gruppieren"
      subtitle={`Spielt gemeinsam mit ${music.players.find((player) => player.id === group.coordinatorId)?.name ?? group.name}`}
      footer={
        others.length > 0 ? (
          <Button
            block
            onClick={() => {
              for (const player of others) void playerCommand(player, { action: 'join', groupId: group.id }, { groupId: group.id });
            }}
          >
            Überall abspielen
          </Button>
        ) : undefined
      }
    >
      <RowGroup className="bg-sunken shadow-none">
        {music.players.map((player) => {
          const member = group.memberIds.includes(player.id);
          const isCoordinator = player.id === group.coordinatorId;
          return (
            <Row
              key={player.id}
              icon={Speaker}
              tone={member ? 'music' : 'neutral'}
              className={cx(!player.available && 'opacity-50')}
              title={player.name}
              subtitle={isCoordinator ? 'Gibt die Musik vor' : !player.available ? 'Nicht erreichbar' : (player.model ?? undefined)}
              trailing={
                <Toggle
                  checked={member}
                  label={`${player.name} ${member ? 'aus der Gruppe nehmen' : 'zur Gruppe hinzufügen'}`}
                  tone="music"
                  disabled={isCoordinator || !player.available}
                  onChange={(next) => void playerCommand(player, next ? { action: 'join', groupId: group.id } : { action: 'leave' }, { groupId: next ? group.id : player.id })}
                />
              }
            />
          );
        })}
      </RowGroup>
    </Sheet>
  );
}

/** Starts something on the target group and tells the user where it plays. */
export async function playOn(group: MusicGroup | undefined, request: PlayRequest & { title?: string }): Promise<void> {
  if (!group) {
    toast.error('Wähle zuerst einen Raum aus.');
    return;
  }
  const ok = await playMedia(group.id, request);
  if (ok) toast.success(request.mode === 'now' ? `Spielt in ${group.name}` : request.mode === 'next' ? 'Wird als Nächstes gespielt' : 'Zur Warteschlange hinzugefügt');
}

/** One playable / browsable thing in a list. */
export function ItemRow({ item, onPlay, onOpen, onMenu, number }: { item: MediaItem; onPlay?(): void; onOpen?(): void; onMenu?(): void; number?: number }) {
  const primary = item.browsable ? onOpen : onPlay;
  return (
    <div className="group flex items-center gap-3 px-3 py-2">
      <button type="button" disabled={!primary} onClick={primary} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
        {number !== undefined && <span className="w-5 shrink-0 text-right text-sm tabular-nums text-faint">{number}</span>}
        <Cover src={item.artUrl} className={cx('size-12', item.type === 'artist' && 'rounded-full')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.title}</span>
          {item.subtitle && <span className="block truncate text-sm text-muted">{item.subtitle}</span>}
        </span>
        {item.duration ? <span className="shrink-0 text-sm tabular-nums text-faint">{formatDuration(item.duration)}</span> : null}
      </button>
      {item.playable && item.browsable && onPlay && <IconButton icon={Play} label={`${item.title} abspielen`} size="sm" tone="music" onClick={onPlay} />}
      {item.playable && onMenu && <IconButton icon={MoreHorizontal} label={`Mehr zu ${item.title}`} size="sm" onClick={onMenu} />}
    </div>
  );
}

/** "Play now / next / add to queue" for one item. */
export function ItemMenu({ item, onClose, onPick }: { item: MediaItem | null; onClose(): void; onPick(mode: PlayRequest['mode']): void }) {
  return (
    <Sheet open={item !== null} onClose={onClose} title={item?.title} subtitle={item?.subtitle ?? undefined}>
      <RowGroup className="bg-sunken shadow-none">
        <Row icon={Play} tone="music" title="Jetzt abspielen" onClick={() => onPick('now')} />
        <Row icon={ListStart} title="Als Nächstes spielen" onClick={() => onPick('next')} />
        <Row icon={ListEnd} title="Ans Ende der Warteschlange" onClick={() => onPick('queue')} />
      </RowGroup>
    </Sheet>
  );
}

export { ListPlus };
