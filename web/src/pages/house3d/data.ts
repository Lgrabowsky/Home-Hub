import { useQuery } from '@tanstack/react-query';
import type { House3DGroup, House3DModelInfo, House3DState } from '@home-hub/shared';
import { get, getBlob } from '../../lib/api.ts';

/** Model description, view settings and device positions. */
export function useHouse3D() {
  return useQuery({ queryKey: ['house3d'], queryFn: () => get<House3DState>('/api/house3d') });
}

export interface ParsedModel {
  version: string;
  info: House3DModelInfo;
  groups: House3DGroup[];
  buffer: ArrayBuffer;
  dataOffset: number;
}

/** Reads the hub's binary model file ("HH3D", see hub/src/house3d/model.ts). */
export function parseModel(version: string, buffer: ArrayBuffer): ParsedModel {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'HH3D') throw new Error('Das 3D-Modell ist beschädigt.');
  const format = view.getUint32(4, true);
  if (format !== 1) throw new Error('Das 3D-Modell stammt von einem neueren Hub. Bitte die App aktualisieren.');
  const length = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length))) as { info: House3DModelInfo; groups: House3DGroup[] };
  return { version, info: header.info, groups: header.groups, buffer, dataOffset: 12 + length };
}

// One model in memory: going back and forth between pages does not download it again.
let cached: ParsedModel | null = null;

export function useModel(version: string | undefined) {
  return useQuery({
    queryKey: ['house3d-model', version],
    enabled: Boolean(version),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (cached && cached.version === version) return cached;
      const blob = await getBlob(`/api/house3d/model?v=${encodeURIComponent(version!)}`, { timeoutMs: 120_000 });
      cached = parseModel(version!, await blob.arrayBuffer());
      return cached;
    },
  });
}
