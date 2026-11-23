import { expect, test } from '@playwright/test';

/** Labs: the 3D house. The demo hub brings a generated house with its devices already placed. */
test('the 3D house is switched on in Labs, opens storey by storey and controls a device', async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^Es klingelt/ }), async (overlay) => {
    await overlay.getByRole('button', { name: 'Schließen' }).click();
  });

  // Off by default: nothing about it in "Mehr".
  await page.goto('/mehr');
  await expect(page.getByRole('heading', { name: 'Mehr' })).toBeVisible();
  await expect(page.getByText('Labs · das Haus als Modell')).toHaveCount(0);

  const labs = page.getByRole('switch', { name: '3D-Haus' });
  await labs.click();
  await expect(labs).toHaveAttribute('aria-checked', 'true');
  await page.getByText('Labs · das Haus als Modell').click();
  await expect(page).toHaveURL(/\/haus3d$/);

  const viewer = page.getByRole('application', { name: /3D-Ansicht des Hauses/ });
  await expect(viewer).toBeVisible();
  await expect(page.getByText('keine 3D-Grafik')).toHaveCount(0);
  await expect(viewer.locator('canvas')).toHaveCount(1);
  await expect(viewer.getByText('Haus', { exact: true })).toBeVisible();

  // Outdoors the terrace light is in place; inside nothing until a storey is opened.
  await expect(viewer.getByRole('button', { name: 'Terrasse, Außen' }).first()).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Stehlampe, Wohnzimmer' })).toBeHidden();

  // Open the ground floor from the rail: its devices appear in the model and in the list below.
  await viewer.getByRole('button', { name: 'Erdgeschoss' }).click();
  await expect(viewer.getByText('Erdgeschoss', { exact: true }).first()).toBeVisible();
  const lamp = viewer.getByRole('button', { name: 'Stehlampe, Wohnzimmer' });
  await expect(lamp).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Erdgeschoss' })).toBeVisible();

  // A device in the model opens its controls.
  await lamp.click();
  const sheet = page.getByRole('dialog', { name: 'Stehlampe' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Schließen' }).first().click();

  // The time of day can be previewed and set back to now (an hour far from now: the slider must move).
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Berlin' }).format(new Date()));
  const previewHour = (hourNow + 12) % 24;
  await viewer.getByRole('slider', { name: 'Tageszeit ansehen' }).fill(String(previewHour));
  await expect(viewer.getByText(`${String(previewHour).padStart(2, '0')}:00`)).toBeVisible();
  await viewer.getByRole('button', { name: 'Jetzt' }).click();
  await expect(viewer.getByRole('button', { name: 'Jetzt' })).toHaveCount(0);

  // Back out to the whole house.
  await viewer.getByRole('button', { name: 'Eine Ebene zurück' }).click();
  await expect(viewer.getByText('Haus geöffnet')).toBeVisible();
});

test('the administrator sees the model, its storeys and colours', async ({ page }) => {
  await page.goto('/einstellungen/haus3d');
  await expect(page.getByText('Demo-Haus.ifc')).toBeVisible();
  await expect(page.getByText(/KG, EG, 1\.OG, Dach, Außenbereich/)).toBeVisible();
  await expect(page.getByLabel('Farbe für Fassade (Holz)')).toBeVisible();
  await page.getByLabel('Breitengrad').fill('47,5');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Gespeichert')).toBeVisible();
});
