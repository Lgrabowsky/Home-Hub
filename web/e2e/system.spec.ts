import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('an administrator restarts the server from the app', async ({ page }) => {
  const request = join(process.env.HH_E2E_CONTROL!, 'reboot-request');
  // A ring from an earlier test may still be fresh and greet this page; close it whenever it shows up.
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^Es klingelt/ }), async (overlay) => {
    await overlay.getByRole('button', { name: 'Schließen' }).click();
  });
  await page.goto('/einstellungen/diagnose');
  await page.getByRole('button', { name: /Server neu starten/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Server neu starten?' });
  await expect(dialog).toContainText('etwa zwei Minuten nicht erreichbar');
  await dialog.getByRole('button', { name: 'Neu starten' }).click();

  await expect(page.getByText('Der Server startet neu.')).toBeVisible();
  // The hub left its request for the helper on the machine – it cannot restart anything itself.
  expect(existsSync(request)).toBe(true);
  expect(JSON.parse(readFileSync(request, 'utf8'))).toMatchObject({ by: 'erika' });

  await page.goto('/einstellungen/protokoll');
  await expect(page.getByText('hat den Server neu gestartet')).toBeVisible();
});
