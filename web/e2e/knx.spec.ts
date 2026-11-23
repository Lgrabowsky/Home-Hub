import { expect, test } from '@playwright/test';
import type { ContactEntity, KnxSettings } from '@home-hub/shared';
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
  await sheet.getByLabel('Name').fill('Fenster Treppenhaus');
  await sheet.getByLabel('Raum').fill('Flur');
  await sheet.getByRole('button', { name: 'Übernehmen' }).click();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Alles gespeichert')).toBeVisible();

  await expect.poll(() => contact('fenster-treppenhaus'), { timeout: 15_000 }).toMatchObject({ available: true, open: true, room: 'Flur', contactType: 'window' });
  await page.goto('/sicherheit');
  await expect(page.getByText('Fenster Treppenhaus').first()).toBeVisible();
  await demo(request, { action: 'contact', name: 'Fenster Treppenhaus', open: false });
  await expect.poll(async () => (await contact('fenster-treppenhaus'))?.open, { timeout: 15_000 }).toBe(false);

  // A contact that sends 0 for open: found the same way, "Umgekehrt" switched on by itself.
  await page.goto('/einstellungen/dienste/knx');
  await page.getByRole('button', { name: 'Kontakt suchen' }).click();
  await demo(request, { action: 'contact', name: 'Kellerfenster', open: true });
  await page.getByRole('dialog', { name: 'KNX-Kontakt suchen' }).getByRole('button', { name: '1/1/4: Das ist es' }).click();
  await expect(page.getByRole('dialog', { name: 'KNX-Kontakt hinzufügen' }).getByRole('switch', { name: 'Umgekehrt' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('dialog', { name: 'KNX-Kontakt hinzufügen' }).getByRole('button', { name: 'Schließen' }).click();
  await demo(request, { action: 'contact', name: 'Kellerfenster', open: false });

  // Leave the demo as it was.
  const saved = await request.put('/api/admin/settings/knx', { headers: APP_HEADERS, data: before });
  expect(saved.ok()).toBe(true);
});
