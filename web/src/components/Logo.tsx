import { cx } from './ui.tsx';

/** The app mark: a house with a warm light inside. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cx('size-12', className)} role="img" aria-label="Home Hub">
      <defs>
        <linearGradient id="hh-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6aa2ff" />
          <stop offset="1" stopColor="#7a5cff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="#0b0e13" />
      <path d="M32 13 12 30.5a2 2 0 0 0 1.3 3.5H17v13.5a3.5 3.5 0 0 0 3.5 3.5h23a3.5 3.5 0 0 0 3.5-3.5V34h3.7a2 2 0 0 0 1.3-3.5Z" fill="url(#hh-logo)" />
      <circle cx="32" cy="37" r="6.2" fill="#0b0e13" />
      <circle cx="32" cy="37" r="2.6" fill="#ffd27a" />
    </svg>
  );
}
