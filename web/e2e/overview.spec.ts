import { expect, test } from '@playwright/test';
import type { HomeWidget } from '@home-hub/shared';

test('the start page is arranged to taste, and the arrangement belongs to the person', async ({ page, request }) => {
  const home = async () => ((await (await request.get('/api/auth/me')).json()) as { prefs: { home?: HomeWidget[] | null } }).prefs.home ?? null;

  await page.goto('/');
  await page.getByRole('button', { name: 'Startseite bearbeiten' }).click();
  await expect(page.getByRole('button', { name: 'Fertig' })).toBeVisible();

  // Move "Licht" one place on (keyboard: pick up, move, put down).
  const light = page.getByRole('button', { name: 'Licht', exact: true });
  await light.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');

  // Wider, one tile less, one more.
  await page.getByRole('button', { name: 'Licht: Größe ändern, jetzt Klein' }).click();
  await expect(page.getByRole('button', { name: 'Licht: Größe ändern, jetzt Breit' })).toBeVisible();
  await page.getByRole('button', { name: 'Klima entfernen' }).click();
  await page.getByRole('button', { name: 'Kachel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Kachel hinzufügen' }).getByRole('button', { name: 'Nächste Zeitschaltuhren' }).click();
  await expect(page.getByRole('button', { name: 'Zeitschaltuhren entfernen' })).toBeVisible();
  await page.getByRole('button', { name: 'Fertig' }).click();

  // Stored on the hub, so every device of this person shows the same.
  await expect.poll(home).not.toBeNull();
  const saved = (await home())!;
  const functions = saved.filter((widget) => widget.type === 'function').map((widget) => (widget.type === 'function' ? widget.function : ''));
  expect(functions.slice(0, 2)).toEqual(['jalousien', 'licht']);
  expect(functions).not.toContain('klima');
  expect(saved.find((widget) => widget.type === 'function' && widget.function === 'licht')?.size).toBe('wide');
  expect(saved.some((widget) => widget.type === 'timers')).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Erika');
  await expect(page.getByRole('link', { name: /Zeitschaltuhren/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Klima/ })).toHaveCount(0);

  // Back to the standard.
  await page.getByRole('button', { name: 'Startseite bearbeiten' }).click();
  await page.getByRole('button', { name: 'Standard' }).click();
  await page.getByRole('dialog', { name: 'Standard-Startseite?' }).getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect.poll(home).toBeNull();
  await expect(page.getByRole('link', { name: /^Klima/ })).toBeVisible();
});
