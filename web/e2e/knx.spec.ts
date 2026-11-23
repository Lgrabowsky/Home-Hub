import { expect, test } from '@playwright/test';
import { EMPTY_LAYOUT, type ContactEntity, type HouseLayout, type KnxSettings } from '@home-hub/shared';
import { APP_HEADERS, demo, hubState } from './helpers.ts';

test('a window contact is found on the KNX bus by opening the window, and shows up with the others', async ({ page, request }) => {
  const contact = async (id: string) => (await hubState(request)).entities[`knx:${id}`] as ContactEntity | undefined;
  const settings = async () => ((await (await request.get('/api/admin/settings/knx')).json()) as { value: KnxSettings }).value;
  const before = await settings();

  // The contacts that are set up are asked for their state at once.
  await expect.poll(() => contact('dachfenster-bad'), { timeout: 15_000 }).toMatchObject({ available: true, open: false, room: 'Bad' });

  await page.goto('/einstellungen/dienste/knx');
  await expect(page.getByText('Dachfenster Bad')).toBeVisible();
  await page.getByRole('button', { name: 'Kontakt suchen' }).click();
  const search = page.getByRole('dialog', { name: 'KNX-Kontakt suchen' });
  await expect(search.getByText('Öffne jetzt das Fenster oder die Tür')).toBeVisible();

  // Someone opens the staircase window: its group address appears.
  await demo(request, { action: 'contact', name: 'Fenster Treppenhaus', open: true });
  await search.getByRole('button', { name: '1/1/3: Das ist es' }).click();
  const sheet = page.getByRole('dialog', { name: 'KNX-Kontakt hinzufügen' });
  await expect(sheet.getByLabel('Gruppenadresse')).toHaveValue('1/1/3');
  // An existing room; no name of its own: it is called by kind and room.
  await sheet.getByLabel('Raum').selectOption('Flur');
  await expect(sheet.getByText('Ohne eigenen Namen heißt der Kontakt „Fenster Flur“.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Übernehmen' }).click();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Alles gespeichert')).toBeVisible();

  await expect.poll(() => contact('ga-1-1-3'), { timeout: 15_000 }).toMatchObject({ name: 'Fenster Flur', available: true, open: true, room: 'Flur', contactType: 'window' });
  await page.goto('/sicherheit');
  await expect(page.getByText('Fenster Flur').first()).toBeVisible();
  await demo(request, { action: 'contact', name: 'Fenster Treppenhaus', open: false });
  await expect.poll(async () => (await contact('ga-1-1-3'))?.open, { timeout: 15_000 }).toBe(false);

  // A contact that sends 0 for open: "Umgekehrt" switched on by itself; a room created on the spot, with an own name.
  await page.goto('/einstellungen/dienste/knx');
  await page.getByRole('button', { name: 'Kontakt suchen' }).click();
  await demo(request, { action: 'contact', name: 'Kellerfenster', open: true });
  await page.getByRole('dialog', { name: 'KNX-Kontakt suchen' }).getByRole('button', { name: '1/1/4: Das ist es' }).click();
  const cellar = page.getByRole('dialog', { name: 'KNX-Kontakt hinzufügen' });
  await expect(cellar.getByRole('switch', { name: 'Umgekehrt' })).toHaveAttribute('aria-checked', 'true');
  await cellar.getByLabel('Raum').selectOption({ label: 'Neuer Raum …' });
  await cellar.getByLabel('Name des neuen Raums').fill('Keller');
  await cellar.getByLabel('Bereich des neuen Raums').selectOption('Erdgeschoss');
  await cellar.getByLabel('Name (optional)').fill('Kellerfenster Nord');
  await cellar.getByRole('button', { name: 'Übernehmen' }).click();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Alles gespeichert')).toBeVisible();
  await expect.poll(() => contact('ga-1-1-4'), { timeout: 15_000 }).toMatchObject({ name: 'Kellerfenster Nord', room: 'Keller', open: true });
  const layout = ((await (await request.get('/api/layout')).json()) as { layout: HouseLayout }).layout;
  expect(layout.floors?.find((floor) => floor.name === 'Erdgeschoss')?.rooms).toContain('Keller');
  await page.goto('/raeume');
  await expect(page.getByRole('link', { name: 'Keller öffnen' })).toBeVisible();
  await demo(request, { action: 'contact', name: 'Kellerfenster', open: false });

  // Leave the demo as it was.
  expect((await request.put('/api/admin/settings/knx', { headers: APP_HEADERS, data: before })).ok()).toBe(true);
  expect((await request.put('/api/layout', { headers: APP_HEADERS, data: { layout: { ...EMPTY_LAYOUT, cameraLights: layout.cameraLights } } })).ok()).toBe(true);
});
