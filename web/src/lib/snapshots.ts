/** How often camera and door tiles show a new picture (while they are on screen and the app is in front). */
export const TILE_REFRESH_MS = 3000;

/**
 * The still picture for a tile: cameras send a picture of their sub stream (a few dozen kB instead
 * of a full 4K picture), door stations their only one.
 */
export function tileSnapshot(entity: { id: string; kind: string }): string {
  const deviceId = entity.id.slice(entity.id.indexOf(':') + 1);
  return entity.kind === 'door' ? `/api/doors/${encodeURIComponent(deviceId)}/snapshot` : `/api/cameras/${encodeURIComponent(deviceId)}/snapshot?size=small`;
}
