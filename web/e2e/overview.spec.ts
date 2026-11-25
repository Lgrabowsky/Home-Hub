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
  const catalog = page.getByRole('dialog', { name: 'Kachel hinzufügen' });
  await catalog.getByRole('tab', { name: 'Übersichten' }).click();
  await catalog.getByRole('button', { name: 'Nächste Zeitschaltuhren hinzufügen' }).click();
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

test('the catalog shows each tile with a preview and what it does; the lights status cannot switch every light', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Startseite bearbeiten' }).click();
  await page.getByRole('button', { name: 'Kachel', exact: true }).click();
  const catalog = page.getByRole('dialog', { name: 'Kachel hinzufügen' });
  // Areas come first; those already on the page say so.
  await expect(catalog.getByText('Wie viele Lichter an sind und in welchen Räumen – mit Knopf „Alle aus“.')).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'Licht: schon auf der Startseite' })).toBeDisabled();
  await catalog.getByRole('tab', { name: 'Übersichten' }).click();
  await expect(catalog.getByText(/ohne Knopf, der alle Lichter schaltet/)).toBeVisible();
  await catalog.getByRole('button', { name: 'Lichter-Status hinzufügen' }).click();
  await page.getByRole('button', { name: 'Fertig' }).click();

  const tile = page.getByRole('button', { name: /^Lichter-Status: .* – anzeigen$/ });
  await expect(tile).toBeVisible();
  // No "all off" on this tile, nor in what it opens.
  await expect(tile.locator('..').getByRole('button', { name: 'Alle Lichter ausschalten' })).toHaveCount(0);
  await tile.click();
  const sheet = page.getByRole('dialog', { name: 'Lichter-Status' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Alle ausschalten' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Alle Lichter ansehen' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Schließen' }).first().click();

  // Back to the standard.
  await page.getByRole('button', { name: 'Startseite bearbeiten' }).click();
  await page.getByRole('button', { name: 'Standard' }).click();
  await page.getByRole('dialog', { name: 'Standard-Startseite?' }).getByRole('button', { name: 'Zurücksetzen' }).click();
});
