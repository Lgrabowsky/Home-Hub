import { expect, test } from '@playwright/test';
import { hubState } from './helpers.ts';

/** Govee lights of the demo: two LED strips with LAN control, a lamp only the cloud reaches. */

const STRIP = 'govee:aabbccddee010203';
const LAMP = 'govee:aabbccddee010205';

test('Govee lights appear in the rooms from their names and change colour, locally or through the cloud', async ({ page, request }) => {
  const entity = async (id: string) => (await hubState(request)).entities[id];
  await expect.poll(() => entity(STRIP), { timeout: 15_000 }).toMatchObject({ available: true, name: 'Wohnzimmer LED-Streifen', room: 'Wohnzimmer', features: { dim: true, color: true, colorTemp: true } });
  await expect.poll(() => entity(LAMP), { timeout: 15_000 }).toMatchObject({ available: true, name: 'Schlafzimmer Leselampe', room: 'Schlafzimmer' });

  await page.goto('/licht');
  // Over the LAN.
  await page.getByRole('button', { name: 'Wohnzimmer LED-Streifen: Einstellungen' }).click();
  let sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Farbe #5b9dff' }).click();
  await expect.poll(() => entity(STRIP)).toMatchObject({ on: true, color: '#5b9dff' });
  await sheet.getByRole('button', { name: 'Schließen' }).first().click();
  await expect(sheet).toBeHidden();

  // Through the cloud.
  await page.getByRole('button', { name: 'Schlafzimmer Leselampe: Einstellungen' }).click();
  sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Farbe #ff5a5a' }).click();
  await expect.poll(() => entity(LAMP)).toMatchObject({ on: true, color: '#ff5a5a' });
  await sheet.getByRole('button', { name: 'Schließen' }).first().click();

  // The settings list the lights; the test says where each one is reached.
  await page.goto('/einstellungen/dienste/govee');
  await expect(page.getByText('Küche Unterschrank')).toBeVisible();
  await page.getByRole('button', { name: 'Testen', exact: true }).click();
  await expect(page.getByText('3 Govee-Lichter gefunden.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Schlafzimmer Leselampe \(H6008\): nur über die Govee-Cloud/)).toBeVisible();
});
