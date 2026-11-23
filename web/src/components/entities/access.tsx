import { ChevronDown, DoorClosed, DoorOpen, KeyRound, Lock, Square, Warehouse, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { AccessEntity, EntityCommand } from '@home-hub/shared';
import { post } from '../../lib/api.ts';
import { haptic } from '../../lib/platform.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useSession } from '../../store/session.ts';
import { toast } from '../toast.tsx';
import { Button, ConfirmDialog, cx, Notice, SlideToConfirm } from '../ui.tsx';

/**
 * Doors, gates and barriers of the building controller ("Zutritt").
 *
 * Opening needs the permission "doors.open" (not just "home.control"), a
 * deliberate gesture, and is written to the audit log by the hub.
 */

export function isGate(entity: AccessEntity): boolean {
  return entity.accessType === 'gate' || entity.accessType === 'gate_operation' || entity.accessType === 'barrier';
}

export function accessIcon(entity: AccessEntity): LucideIcon {
  if (isGate(entity)) return Warehouse;
  return entity.open || entity.action === 'hold_open' ? DoorOpen : DoorClosed;
}

export function accessIsOpen(entity: AccessEntity): boolean {
  return entity.open === true || entity.action === 'open' || entity.action === 'hold_open' || entity.action === 'partially_open' || entity.action === 'partially_hold_open';
}

export function accessStateText(entity: AccessEntity): string {
  if (entity.action === 'hold_open') return 'Dauerhaft offen';
  if (entity.action === 'partially_hold_open') return 'Teilweise offen, gehalten';
  const level = entity.level !== null && entity.level > 0 && entity.level < 100 ? ` · ${entity.level} %` : '';
  if (entity.action === 'partially_open') return `Teilweise offen${level}`;
  if (entity.open === true || entity.action === 'open') return `Offen${level}`;
  if (entity.open === false) return 'Zu';
  return entity.action === 'closed' ? 'Zu' : '–';
}

const DONE: Partial<Record<EntityCommand['action'], string>> = {
  open: 'geöffnet',
  hold_open: 'dauerhaft geöffnet',
  close: 'wird geschlossen',
  lock: 'gesperrt',
  stop: 'angehalten',
};

const OPTIMISTIC: Partial<Record<EntityCommand['action'], Partial<AccessEntity>>> = {
  open: { action: 'open' },
  hold_open: { action: 'hold_open' },
  close: { action: 'closed' },
};

/** Sends a door command (checks "doors.open" instead of "home.control"). */
export async function accessCommand(entity: AccessEntity, command: EntityCommand): Promise<boolean> {
  if (!useSession.getState().can('doors.open')) {
    toast.error('Du darfst keine Türen öffnen.');
    return false;
  }
  const hub = useHub.getState();
  const before = hub.entities[entity.id];
  const optimistic = OPTIMISTIC[command.action];
  if (optimistic) hub.patchEntity(entity.id, optimistic);
  haptic('medium');
  try {
    await post(`/api/entities/${encodeURIComponent(entity.id)}/command`, command);
    toast.success(`${entity.name} ${DONE[command.action] ?? ''}`.trim());
    return true;
  } catch (err) {
    if (optimistic && before) useHub.getState().patchEntity(entity.id, before);
    toast.fromError(err);
    return false;
  }
}

/** Opening by slider, the other commands as buttons — as on the controller's own access page. */
export function AccessControls({ entity, compact }: { entity: AccessEntity; compact?: boolean }) {
  const canOpen = useCan('doors.open');
  const [confirmHold, setConfirmHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const gate = isGate(entity);
  const run = async (command: EntityCommand) => {
    setBusy(true);
    try {
      await accessCommand(entity, command);
    } finally {
      setBusy(false);
    }
  };

  if (!canOpen) {
    return compact ? null : <Notice className="mt-1">Öffnen und Schließen darf nur, wer die Berechtigung „Türen öffnen“ hat.</Notice>;
  }
  const disabled = !entity.available;
  const secondary: { key: string; label: string; icon: LucideIcon; show: boolean; onClick(): void }[] = [
    { key: 'hold', label: 'Dauerhaft öffnen', icon: KeyRound, show: entity.features.holdOpen && entity.action !== 'hold_open', onClick: () => setConfirmHold(true) },
    { key: 'stop', label: 'Anhalten', icon: Square, show: entity.features.stop && gate, onClick: () => void run({ action: 'stop' }) },
    { key: 'close', label: gate ? 'Zufahren' : 'Schließen', icon: ChevronDown, show: entity.features.close, onClick: () => void run({ action: 'close' }) },
    { key: 'lock', label: 'Sperren', icon: Lock, show: entity.features.lock && !compact, onClick: () => void run({ action: 'lock' }) },
  ];
  return (
    <div className={cx('flex flex-col gap-2.5', !compact && 'mt-1')}>
      {entity.features.open && (
        <SlideToConfirm label={gate ? 'Zum Öffnen des Tors schieben' : 'Zum Öffnen schieben'} icon={DoorOpen} disabled={disabled} busy={busy} onConfirm={() => void run({ action: 'open' })} />
      )}
      <div className="flex flex-wrap gap-2">
        {secondary
          .filter((button) => button.show)
          .map((button) => (
            <Button key={button.key} size="sm" icon={button.icon} disabled={disabled || busy} onClick={button.onClick} className="flex-1">
              {button.label}
            </Button>
          ))}
      </div>
      <ConfirmDialog
        open={confirmHold}
        onClose={() => setConfirmHold(false)}
        title={`${entity.name} dauerhaft öffnen?`}
        text="Bleibt offen, bis jemand sie wieder schließt."
        confirmLabel="Dauerhaft öffnen"
        onConfirm={() => run({ action: 'hold_open' })}
      />
    </div>
  );
}
