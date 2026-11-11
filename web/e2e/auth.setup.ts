import { expect, test as setup } from '@playwright/test';
import { ADMIN, STORAGE } from '../playwright.config.ts';

/** First start of a fresh hub: the set-up code creates the first administrator. */
setup('the first administrator is created with the set-up code', async ({ page, request }) => {
  // Before set-up nothing but the public status is reachable.
  expect((await request.get('/api/state')).status()).toBe(401);

  await page.goto('/');
  await expect(page.getByText('Home Hub einrichten')).toBeVisible();

  // A wrong code does not get in.
  await page.getByLabel('Einrichtungscode').fill('AAAA-BBBB-CCCC');
  await page.getByLabel('Dein Name').fill(ADMIN.name);
  await page.getByLabel('Benutzername').fill(ADMIN.username);
  await page.getByLabel('Passwort', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Passwort wiederholen').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Einrichtungscode').fill('DEMO-DEMO-DEMO');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Erika');

  await page.context().storageState({ path: STORAGE });
});
