import { expect, test } from '@playwright/test';
import { slugify } from '@home-hub/shared';
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
    // A blind of the living room that is not already all the way down (it would not move).
    const blind = Object.values((await hubState(request)).entities).find(
      (entity) => entity.kind === 'blind' && entity.room === 'Wohnzimmer' && !entity.isGroup && entity.available && (entity.position ?? 0) < 80,
    );
    expect(blind).toBeTruthy();
    const name = blind!.name;
    const current = async () => Object.values((await hubState(request)).entities).find((entity) => entity.id === blind!.id);

    await page.goto('/raeume');
    await page.getByRole('link', { name: /Wohnzimmer/ }).first().click();
    await page.getByRole('button', { name: `${name}: Herunterfahren` }).click();
    // The controller is polled every few seconds; give it time to report the movement.
    await expect.poll(current, { timeout: 20_000 }).toMatchObject({ motion: 'down' });
    await page.getByRole('button', { name: `${name}: Anhalten` }).click();
    await expect.poll(current, { timeout: 20_000 }).toMatchObject({ motion: 'stopped' });
  });

  test('the rooms are grouped by storey', async ({ page }) => {
    await page.goto('/raeume');
    await expect(page.getByRole('heading', { name: 'Erdgeschoss' })).toBeVisible();
    const upstairs = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Obergeschoss' }) });
    await expect(upstairs.getByRole('link', { name: 'Bad öffnen' })).toBeVisible();
    await expect(upstairs.getByRole('link', { name: 'Küche öffnen' })).toHaveCount(0);
  });

  test('the light menu switches a lamp of any room', async ({ page, request }) => {
    await page.goto('/raeume');
    await page.getByRole('navigation', { name: 'Bereiche' }).getByRole('link', { name: /Licht/ }).click();
    await expect(page.getByRole('heading', { name: 'Licht', level: 1 })).toBeVisible();
    const lamp = page.getByRole('switch', { name: /^Stehlampe (ein|aus)schalten$/ });
    const wasOn = (await lamp.getAttribute('aria-checked')) === 'true';
    await lamp.click();
    await expect(lamp).toHaveAttribute('aria-checked', String(!wasOn));
    await expect
      .poll(async () => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'light' && entity.name === 'Stehlampe'))
      .toMatchObject({ on: !wasOn });
  });

  test('the heating menu changes the wished temperature', async ({ page, request }) => {
    const room = Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'climate' && entity.available && entity.features.target && entity.target !== null);
    expect(room).toBeTruthy();
    if (room?.kind !== 'climate') return;
    const before = room.target!;
    const up = before + room.targetRange.step <= room.targetRange.max;
    await page.goto('/klima');
    await page.getByRole('button', { name: `${room.name}: ${up ? 'wärmer' : 'kälter'}` }).click();
    // Sent once the taps stop, then read back from the controller.
    await expect
      .poll(async () => {
        const now = Object.values((await hubState(request)).entities).find((entity) => entity.id === room.id);
        return now?.kind === 'climate' ? now.target : null;
      }, { timeout: 20_000 })
      .toBe(up ? before + room.targetRange.step : before - room.targetRange.step);
  });

  test('all blinds of the house move with one tap', async ({ page, request }) => {
    const moving = async () => Object.values((await hubState(request)).entities).filter((entity) => entity.kind === 'blind' && !entity.isGroup && entity.motion === 'up').length;
    await page.goto('/jalousien');
    await page.getByRole('button', { name: 'Alle hoch' }).click();
    await expect.poll(moving, { timeout: 20_000 }).toBeGreaterThan(1);
  });

  test('room tiles can be rearranged and the order is kept', async ({ page, request }) => {
    const order = async () => ((await (await request.get('/api/auth/me')).json()) as { prefs: { roomOrder: string[] } }).prefs.roomOrder;
    await page.goto('/raeume');
    await page.getByRole('button', { name: 'Anordnen' }).click();
    const downstairs = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Erdgeschoss' }) });
    const cards = downstairs.getByRole('button', { name: / verschieben$/ });
    const first = (await cards.first().getAttribute('aria-label'))!.replace(' verschieben', '');
    const second = (await cards.nth(1).getAttribute('aria-label'))!.replace(' verschieben', '');

    // Keyboard: pick up, move one place to the right, put down.
    // (The sensor listens from the next frame on; a human never types this fast.)
    await cards.first().focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await expect(cards.first()).toHaveAttribute('aria-label', `${second} verschieben`);
    await expect.poll(async () => (await order()).slice(0, 2)).toEqual([second, first].map(slugify));
    await page.getByRole('button', { name: 'Fertig' }).click();

    // Kept after a reload, and on the overview too.
    await page.reload();
    const tiles = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Erdgeschoss' }) }).getByRole('link', { name: / öffnen$/ });
    await expect(tiles.first()).toHaveAttribute('aria-label', `${second} öffnen`);

    // Back to alphabetical.
    await page.getByRole('button', { name: 'Anordnen' }).click();
    await page.getByRole('button', { name: 'Alphabetisch' }).click();
    await expect.poll(order).toEqual([]);
  });
});
