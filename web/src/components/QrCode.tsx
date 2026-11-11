import { encode } from 'uqr';
import { useMemo } from 'react';

/** QR code rendered as inline SVG (no network, no canvas). */
export function QrCode({ value, size = 208, label }: { value: string; size?: number; label: string }) {
  const { path, cells } = useMemo(() => {
    const result = encode(value, { border: 2, ecc: 'M' });
    let d = '';
    result.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, cells: result.size };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${cells} ${cells}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <path d={path} fill="#000" />
    </svg>
  );
}
