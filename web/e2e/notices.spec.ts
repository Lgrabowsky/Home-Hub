import { expect, test } from '@playwright/test';
import type { GoveeSettings } from '@home-hub/shared';
import { APP_HEADERS } from './helpers.ts';

/** The demo's Govee simulator key (see hub/src/sim/govee-sim.ts). */
const GOVEE_DEMO_KEY = '00000000-demo-4000-8000-000000000000';

test('a problem shows as a banner that can be dismissed, and stays in the notification centre', async ({ page, request }) => {
  const before = ((await (await request.get('/api/admin/settings/govee')).json()) as { value: GoveeSettings }).value;
  try {
    // A refused API key: the Govee service reports a problem (its LAN lights keep working).
    expect((await request.put('/api/admin/settings/govee', { headers: APP_HEADERS, data: { ...before, apiKey: 'falsch' } })).ok()).toBe(true);
    await page.goto('/');
    const dismiss = page.getByRole('button', { name: 'Meldung Govee ausblenden' });
    await expect(dismiss).toBeVisible({ timeout: 15_000 });
    await dismiss.click();
    await expect(dismiss).toHaveCount(0);

    // The bell in the header keeps it, under "Ausgeblendet" — not a tab of its own.
    const bell = page.getByRole('button', { name: /^Meldungen: / });
    await expect(bell).toHaveAttribute('aria-label', /1 ausgeblendet/);
    await bell.click();
    const centre = page.getByRole('dialog', { name: 'Meldungen' });
    await expect(centre.getByText('Ausgeblendet', { exact: true })).toBeVisible();
    await expect(centre.getByText('Govee nimmt den API-Key nicht an.')).toBeVisible();
    await centre.getByRole('button', { name: 'Schließen' }).first().click();

    // Dismissed on this device: still dismissed after a reload; the bell is on every page.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Meldungen: / })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Meldung Govee ausblenden' })).toHaveCount(0);
    await page.goto('/sicherheit');
    await expect(page.getByRole('button', { name: /^Meldungen: / })).toBeVisible();

    // Shown again from the centre.
    await page.getByRole('button', { name: /^Meldungen: / }).click();
    await page.getByRole('dialog', { name: 'Meldungen' }).getByRole('button', { name: 'Govee wieder anzeigen' }).click();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Meldung Govee ausblenden' })).toBeVisible();
  } finally {
    expect((await request.put('/api/admin/settings/govee', { headers: APP_HEADERS, data: { ...before, apiKey: GOVEE_DEMO_KEY } })).ok()).toBe(true);
  }
});
