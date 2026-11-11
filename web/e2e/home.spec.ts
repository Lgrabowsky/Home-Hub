import { expect, test } from '@playwright/test';
import { hubState } from './helpers.ts';

test.describe('rooms and devices', () => {
  test('the overview shows the house at a glance', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Erika');
    await expect(page.getByRole('heading', { name: 'Räume' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Bad/ }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Szenen' })).toBeVisible();
  });

  test('switching a light reaches the controller and survives a reload', async ({ page, request }) => {
    await page.goto('/raeume');
    await page.getByRole('link', { name: /Wohnzimmer/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Wohnzimmer' })).toBeVisible();

    const lamp = page.getByRole('button', { name: /^Stehlampe (ein|aus)schalten$/ });
    await expect(lamp).toBeVisible();
    const wasOn = (await lamp.getAttribute('aria-label'))!.endsWith('ausschalten');
    await lamp.click();
    const expected = wasOn ? 'Stehlampe einschalten' : 'Stehlampe ausschalten';
    await expect(page.getByRole('button', { name: expected })).toBeVisible();

    // The hub's own state (read from the simulated controller) agrees …
    await expect
      .poll(async () => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'light' && entity.name === 'Stehlampe' && entity.room === 'Wohnzimmer'))
      .toMatchObject({ on: !wasOn });
    // … and so does a freshly loaded page.
    await page.reload();
    await expect(page.getByRole('button', { name: expected })).toBeVisible();
  });

  test('a blind can be sent down and stopped', async ({ page, request }) => {
    await page.goto('/raeume');
    await page.getByRole('link', { name: /Wohnzimmer/ }).first().click();
    const down = page.getByRole('button', { name: /: Herunterfahren$/ }).first();
    await expect(down).toBeVisible();
    const name = (await down.getAttribute('aria-label'))!.replace(': Herunterfahren', '');
    await down.click();
    await expect
      .poll(async () => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'blind' && entity.name === name && entity.room === 'Wohnzimmer'))
      .toMatchObject({ motion: 'down' });
    await page.getByRole('button', { name: `${name}: Anhalten` }).click();
    await expect
      .poll(async () => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'blind' && entity.name === name && entity.room === 'Wohnzimmer'))
      .toMatchObject({ motion: 'stopped' });
  });
});
