import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../ui.tsx';

interface Item {
  id: string;
  /** Read out when the item is picked up and put down. */
  label: string;
}

function SortableRow({ item, children }: { item: Item; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, data: { label: item.label } });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cx('flex items-center gap-1', isDragging && 'relative z-10 rounded-control bg-raised shadow-float')}>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`${item.label} verschieben`}
        aria-roledescription="verschiebbarer Eintrag"
        className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
      >
        <GripVertical className="size-5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A list whose entries are moved by their grip (mouse, touch or keyboard). */
export function SortableList({ items, onReorder, render }: { items: Item[]; onReorder(ids: string[]): void; render(item: Item): ReactNode }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = items.map((item) => item.id);
    onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `${String(active.data.current?.label ?? 'Eintrag')} aufgenommen.`,
          onDragOver: ({ active, over }) => (over ? `${String(active.data.current?.label ?? 'Eintrag')} ist jetzt an der Stelle von ${String(over.data.current?.label ?? 'einem anderen')}.` : undefined),
          onDragEnd: ({ active }) => `${String(active.data.current?.label ?? 'Eintrag')} abgelegt.`,
          onDragCancel: () => 'Verschieben abgebrochen.',
        },
        screenReaderInstructions: { draggable: 'Leertaste zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste zum Ablegen, Escape zum Abbrechen.' },
      }}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <div className="divide-y divide-line/70">
          {items.map((item) => (
            <SortableRow key={item.id} item={item}>
              {render(item)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
