import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

/** A storey: its name as a quiet heading with a hairline, the rooms below. */
export function FloorSection({ name, meta, children }: { name: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-9">
      {name && (
        <div className="mb-3.5 flex items-center gap-3 px-1">
          <h2 className="text-lg font-semibold tracking-tight">{name}</h2>
          <span className="h-px flex-1 bg-line" aria-hidden />
          {meta && <span className="text-[13px] text-muted">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A room inside a storey, as a heading that leads to the room. */
export function RoomHeading({ id, name, meta, actions }: { id?: string; name: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-9 items-center gap-2 px-1">
      {id ? (
        <Link to={`/raeume/${id}`} className="group inline-flex min-w-0 items-center gap-1 text-[15px] font-medium text-fg/90 hover:text-fg">
          <span className="truncate">{name}</span>
          <ChevronRight className="size-4 shrink-0 text-faint transition group-hover:translate-x-0.5" aria-hidden />
        </Link>
      ) : (
        <span className="truncate text-[15px] font-medium text-fg/90">{name}</span>
      )}
      {meta && <span className="truncate text-[13px] text-muted">{meta}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}
