import { useQueryClient } from '@tanstack/react-query';
import { Box, FlaskConical, MapPin, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { House3DState, House3DView } from '@home-hub/shared';
import { toast } from '../../../components/toast.tsx';
import { Button, Card, ConfirmDialog, Field, Notice, PageHeader, Row, RowGroup, Section, Spinner, TextInput } from '../../../components/ui.tsx';
import { del, errorMessage, put, uploadFile } from '../../../lib/api.ts';
import { formatAgo } from '../../../lib/format.ts';
import { useLabs } from '../../../store/labs.ts';
import { useHouse3D } from '../../house3d/data.ts';

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Administration of the 3D house: the model, where north is, where the house stands, names and colours. */
export function House3DSettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useHouse3D();
  const labs = useLabs();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = query.data;
  const model = state?.model ?? null;
  const apply = (next: House3DState) => {
    queryClient.setQueryData(['house3d'], next);
  };

  const upload = async (file: File) => {
    setError(null);
    if (!/\.ifc$/i.test(file.name)) {
      setError('Bitte eine .ifc-Datei wählen (kein .ifczip, kein .bimx).');
      return;
    }
    setUploading(true);
    try {
      const next = await uploadFile<House3DState>('/api/house3d/model', file, { headers: { 'X-File-Name': encodeURIComponent(file.name) } });
      apply(next);
      toast.success('Modell übernommen');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  if (query.isPending) {
    return (
      <>
        <PageHeader title="3D-Haus" back="/einstellungen" />
        <div className="flex justify-center py-12">
          <Spinner className="size-7" />
        </div>
      </>
    );
  }
  if (query.isError || !state) {
    return (
      <>
        <PageHeader title="3D-Haus" back="/einstellungen" />
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="3D-Haus" subtitle="Labs · Modell, Ausrichtung und Farben" back="/einstellungen" />

      {!labs.house3d && (
        <Notice tone="accent" icon={FlaskConical} className="mb-5">
          Die 3D-Ansicht ist eine Testfunktion. Auf diesem Gerät ist sie noch aus – schalte sie unter Einstellungen › Labs ein. Jedes Gerät entscheidet selbst.
        </Notice>
      )}
      {state.demo && <Notice className="mb-5">Im Demo-Modus zeigt der Hub ein erfundenes Haus. Ein hochgeladenes Modell gilt nur bis zum Neustart.</Notice>}

      <input
        ref={input}
        type="file"
        accept=".ifc"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <Section title="Modell">
        {model ? (
          <RowGroup>
            <Row icon={Box} tone="accent" title={model.fileName} subtitle={`${megabytes(model.fileBytes)} · hochgeladen ${formatAgo(model.uploadedAt)} · ${model.application || model.schema}`} />
            <Row
              title="Erkannt"
              subtitle={`${model.elements.toLocaleString('de-DE')} Bauteile · ${model.levels.filter((l) => l.kind === 'storey').map((l) => l.short).join(', ')}${model.levels.some((l) => l.kind === 'roof') ? ', Dach' : ''}${model.levels.some((l) => l.kind === 'outside') ? ', Außenbereich' : ''}`}
            />
            <div className="flex flex-wrap gap-2 px-4 py-3">
              <Button icon={Upload} loading={uploading} onClick={() => input.current?.click()}>
                Neues Modell hochladen
              </Button>
              <Button variant="danger" icon={Trash2} onClick={() => setRemoving(true)}>
                Entfernen
              </Button>
              <Button variant="ghost" icon={MapPin} onClick={() => navigate('/haus3d?platzieren=1')}>
                Geräte platzieren
              </Button>
            </div>
          </RowGroup>
        ) : (
          <Card className="flex flex-col items-start gap-3 p-5">
            <p className="text-muted">
              Exportiere das Gebäudemodell als <strong className="text-fg">IFC</strong> (z. B. aus ArchiCAD, Revit, Vectorworks oder cadwork; BIMx-Dateien gehen nicht). Der Hub wandelt es einmal um und behält beides verschlüsselt bei sich.
            </p>
            <Button variant="primary" icon={Upload} loading={uploading} onClick={() => input.current?.click()}>
              IFC-Datei hochladen
            </Button>
          </Card>
        )}
        {uploading && <p className="mt-2 text-sm text-muted">Große Modelle brauchen etwas – der Hub liest und vereinfacht das Modell.</p>}
        {error && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
        {model && model.warnings.length > 0 && (
          <Notice tone="warn" className="mt-3">
            {model.warnings.join(' ')}
          </Notice>
        )}
      </Section>

      <ViewSettings state={state} onSaved={apply} />

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="3D-Modell entfernen?"
        text="Das Modell wird vom Hub gelöscht. Die Positionen der Geräte bleiben erhalten, falls du später wieder ein Modell hochlädst."
        confirmLabel="Entfernen"
        danger
        onConfirm={async () => {
          try {
            apply(await del<House3DState>('/api/house3d/model'));
          } catch (err) {
            toast.fromError(err);
          }
        }}
      />
    </>
  );
}

function ViewSettings({ state, onSaved }: { state: House3DState; onSaved(next: House3DState): void }) {
  const [draft, setDraft] = useState<House3DView>(state.view);
  const [latitude, setLatitude] = useState(String(state.view.latitude).replace('.', ','));
  const [longitude, setLongitude] = useState(String(state.view.longitude).replace('.', ','));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(state.view);
    setLatitude(String(state.view.latitude).replace('.', ','));
    setLongitude(String(state.view.longitude).replace('.', ','));
  }, [state.view]);
  const model = state.model;

  const save = async () => {
    setError(null);
    const lat = Number(latitude.replace(',', '.'));
    const lon = Number(longitude.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setError('Bitte Breiten- und Längengrad als Zahl angeben, z. B. 47,51 und 12,23.');
      return;
    }
    setSaving(true);
    try {
      onSaved(await put<House3DState>('/api/house3d/view', { ...draft, latitude: lat, longitude: lon }));
      toast.success('Gespeichert');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Section title="Sonne">
        <Card className="flex flex-col gap-4 p-5">
          <p className="text-sm text-muted">
            Das Licht im 3D-Haus folgt der Tageszeit. Damit Sonne und Schatten stimmen, braucht der Hub den ungefähren Standort und die Himmelsrichtung des Modells. Beides bleibt auf deinem Hub.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Breitengrad" hint="z. B. 47,51">
              <TextInput inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
            </Field>
            <Field label="Längengrad" hint="z. B. 12,23">
              <TextInput inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
            </Field>
          </div>
          <Field label={`Norden: ${Math.round(draft.northDeg)}°`} hint={model && model.trueNorthDeg !== 0 ? `Das Modell selbst sagt ${Math.round(model.trueNorthDeg)}°.` : 'Winkel im Uhrzeigersinn von der „oberen“ Kante des Plans (Y-Achse) bis Norden.'}>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={draft.northDeg}
              onChange={(event) => setDraft({ ...draft, northDeg: Number(event.target.value) })}
              className="hh-range"
              style={{ '--fill': `${((draft.northDeg + 180) / 360) * 100}%`, '--tone': 'var(--hh-accent)' } as React.CSSProperties}
            />
          </Field>
        </Card>
      </Section>

      {model && (
        <Section title="Geschosse">
          <Card className="grid gap-4 p-5 sm:grid-cols-2">
            {model.levels
              .filter((level) => level.kind === 'storey')
              .map((level) => (
                <Field key={level.id} label={`${level.short} · ${level.name}`}>
                  <TextInput
                    value={draft.levelNames[level.id] ?? ''}
                    placeholder={level.name}
                    maxLength={30}
                    onChange={(event) => setDraft({ ...draft, levelNames: { ...draft.levelNames, [level.id]: event.target.value } })}
                  />
                </Field>
              ))}
          </Card>
        </Section>
      )}

      {model && (
        <Section title="Farben">
          <RowGroup>
            {model.materials.map((material) => {
              const value = draft.colors[material.key] ?? material.color;
              const changed = draft.colors[material.key] !== undefined;
              return (
                <Row
                  key={material.key}
                  title={material.label}
                  subtitle={`${material.elements.toLocaleString('de-DE')} Bauteile`}
                  trailing={
                    <>
                      {changed && (
                        <button
                          type="button"
                          aria-label={`${material.label}: Farbe zurücksetzen`}
                          className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-sunken"
                          onClick={() => {
                            const colors = { ...draft.colors };
                            delete colors[material.key];
                            setDraft({ ...draft, colors });
                          }}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </button>
                      )}
                      <input
                        type="color"
                        aria-label={`Farbe für ${material.label}`}
                        value={value}
                        onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, [material.key]: event.target.value } })}
                        className="size-9 cursor-pointer rounded-full border border-line bg-transparent p-0.5"
                      />
                    </>
                  }
                />
              );
            })}
          </RowGroup>
          <p className="mt-2 text-sm text-faint">CAD-Programme färben nach Bauteilart. Der Hub wählt deshalb Farben nach Material – hier passt du sie an euer echtes Haus an.</p>
        </Section>
      )}

      {error && (
        <Notice tone="danger" className="mb-3">
          {error}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          Speichern
        </Button>
      </div>
    </>
  );
}
