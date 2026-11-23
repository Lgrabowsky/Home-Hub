import { expect, test } from '@playwright/test';
import { APP_HEADERS, demo, expectVideoPlaying, hubState } from './helpers.ts';

test.describe('windows, doors and cameras', () => {
  test('an opened window shows up at once and disappears when it is closed', async ({ page, request }) => {
    await page.goto('/sicherheit');
    await expect(page.getByRole('heading', { name: 'Sicherheit' })).toBeVisible();

    await demo(request, { action: 'contact', name: 'Fenster Küche', open: true });
    await expect(page.getByText(/1 von \d+ offen/)).toBeVisible();
    await expect(page.getByText('Fenster Küche').first()).toBeVisible();
    // The tab bar carries the number of open contacts on every screen.
    await expect(page.locator('[aria-label="1 offen"]:visible')).toBeVisible();

    await demo(request, { action: 'contact', name: 'Fenster Küche', open: false });
    await expect(page.getByText(/1 von \d+ offen/)).toBeHidden();
  });

  test('opening the door needs the slide gesture and is written to the audit log', async ({ page }) => {
    await page.goto('/sicherheit/tuer/seiteneingang');
    const thumb = page.getByRole('button', { name: 'Zum Öffnen schieben' });
    await expect(thumb).toBeVisible();

    // A tap is not enough.
    await thumb.click();
    await page.waitForTimeout(500);
    await expect(page.getByText(/geöffnet/)).toBeHidden();

    const box = (await thumb.boundingBox())!;
    const track = (await thumb.locator('..').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width - 8, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByText('Seitentür geöffnet')).toBeVisible();

    await page.goto('/einstellungen/protokoll');
    await expect(page.getByText(/erika hat Seiteneingang geöffnet/).first()).toBeVisible();
  });

  test('doors and gates of the building controller open from "Zutritt", and every use is on record', async ({ page, request }) => {
    const door = async (name: string) => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'access' && entity.name === name);
    await page.goto('/zutritt');
    await expect(page.getByRole('heading', { name: 'Zutritt', level: 1 })).toBeVisible();

    // A door: opened with the slide gesture, like the door station's opener.
    const card = page.getByRole('button', { name: 'Nebeneingang: Details' }).locator('..');
    const thumb = card.getByRole('button', { name: 'Zum Öffnen schieben' });
    // Above the mini player at the bottom of the screen.
    await thumb.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    const box = (await thumb.boundingBox())!;
    const track = (await thumb.locator('..').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width - 8, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByText('Nebeneingang geöffnet')).toBeVisible();

    // A gate: held open after asking, then closed again.
    const gate = page.getByRole('button', { name: 'Einfahrtstor: Details' }).locator('..');
    await gate.getByRole('button', { name: 'Dauerhaft öffnen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Dauerhaft öffnen' }).click();
    await expect.poll(() => door('Einfahrtstor'), { timeout: 20_000 }).toMatchObject({ action: 'hold_open' });
    await expect(gate.getByText(/Dauerhaft offen/)).toBeVisible();
    await gate.getByRole('button', { name: 'Zufahren' }).click();
    await expect.poll(async () => { const gate = await door('Einfahrtstor'); return gate?.kind === 'access' ? gate.action : null; }, { timeout: 20_000 }).not.toBe('hold_open');

    // No storey filter here; instead the order can be changed (administrators).
    await expect(page.getByRole('tablist', { name: 'Stockwerk' })).toHaveCount(0);
    const titles = async () => page.getByRole('button', { name: /: Details$/ }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect((await titles())[0]).toBe('Einfahrtstor: Details');
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await page.getByRole('button', { name: 'Nebeneingang verschieben' }).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await expect.poll(async () => ((await (await request.get('/api/layout')).json()) as { layout: { pageOrder?: Record<string, string[]> } }).layout.pageOrder?.zutritt?.[0]).toBe('gekko:accessdoors/item2');
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect.poll(async () => (await titles())[0]).toBe('Nebeneingang: Details');
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await page.getByRole('button', { name: 'Reihenfolge zurücksetzen' }).click();
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect.poll(async () => (await titles())[0]).toBe('Einfahrtstor: Details');

    await page.goto('/einstellungen/protokoll');
    await expect(page.getByText('erika hat Nebeneingang geöffnet').first()).toBeVisible();
    await expect(page.getByText('erika hat Einfahrtstor dauerhaft geöffnet').first()).toBeVisible();
  });

  test('the lighting zone shows the lights that are on, switches them off, and leaves out the excluded ones', async ({ page, request }) => {
    const light = async (name: string, room: string) => Object.values((await hubState(request)).entities).find((entity) => entity.kind === 'light' && entity.name === name && entity.room === room)!;
    const turnOn = async (name: string, room: string) => {
      const target = await light(name, room);
      expect((await request.post(`/api/entities/${encodeURIComponent(target.id)}/command`, { headers: APP_HEADERS, data: { action: 'turn_on' } })).ok()).toBe(true);
    };
    await turnOn('Stehlampe', 'Wohnzimmer');
    await turnOn('Flur', 'Flur');

    await page.goto('/sicherheit');
    // Lights on are no open window: the summary is about windows and doors only.
    await expect(page.getByText('Mindestens ein Kontakt ist offen')).toHaveCount(0);
    await expect(page.getByText(/Fenster und Türen überwacht|von \d+ offen/).first()).toBeVisible();

    const row = page.getByRole('button', { name: /^Status Beleuchtung/ });
    await expect(row).toContainText('an:');
    await row.click();
    const sheet = page.getByRole('dialog', { name: 'Status Beleuchtung' });
    await expect(sheet.getByText('Stehlampe')).toBeVisible();
    // Only lights that are on: switched off, it is gone.
    await sheet.getByRole('switch', { name: 'Flur ausschalten' }).click();
    await expect(sheet.getByRole('switch', { name: /^Flur / })).toHaveCount(0);
    await expect.poll(async () => (await light('Flur', 'Flur')).kind === 'light' && ((await light('Flur', 'Flur')) as { on: boolean }).on, { timeout: 20_000 }).toBe(false);

    // Left out in the settings: no longer listed.
    await sheet.getByRole('button', { name: 'Lichter von der Überwachung ausnehmen' }).click();
    await expect(page).toHaveURL(/lichtueberwachung$/);
    await page.getByLabel('Licht oder Raum suchen').fill('Stehlampe');
    await page.getByRole('switch', { name: 'Stehlampe überwachen' }).click();
    await expect.poll(async () => ((await (await request.get('/api/layout')).json()) as { layout: { lightWatchExcluded?: string[] } }).layout.lightWatchExcluded).toEqual([(await light('Stehlampe', 'Wohnzimmer')).id]);
    await page.goto('/sicherheit');
    await page.getByRole('button', { name: /^Status Beleuchtung/ }).click();
    await expect(page.getByRole('dialog', { name: 'Status Beleuchtung' }).getByText('Stehlampe')).toHaveCount(0);

    // Watched again (the demo as it was).
    await page.goto('/einstellungen/lichtueberwachung');
    await page.getByRole('switch', { name: 'Stehlampe überwachen' }).click();
    await expect.poll(async () => ((await (await request.get('/api/layout')).json()) as { layout: { lightWatchExcluded?: string[] } }).layout.lightWatchExcluded).toBeUndefined();
  });

  test('cameras show live video, can be turned and jump to stored positions', async ({ page, request }) => {
    const state = await hubState(request);
    test.skip(state.services.media.status !== 'ok', 'live video needs go2rtc and ffmpeg');

    await page.goto('/sicherheit/kamera/garten');
    await expectVideoPlaying(page);

    const position = page.getByRole('button', { name: 'Tor', exact: true });
    await expect(position).toBeVisible();
    await position.click();
    // Holding an arrow turns the camera; letting go stops it.
    const right = page.getByRole('button', { name: /rechts/i }).first();
    const box = (await right.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByRole('alert')).toBeHidden();
  });

  test('a camera without HTTP interface is turned and positioned through ONVIF', async ({ page, request }) => {
    const camera = (await hubState(request)).entities['cam:wohnzimmer'];
    expect(camera).toMatchObject({ available: true, model: 'E1 Pro', features: { ptz: true, presets: true, light: false, siren: false } });

    await page.goto('/sicherheit/kamera/wohnzimmer');
    const position = page.getByRole('button', { name: 'Rasen', exact: true });
    await expect(position).toBeVisible();
    await position.click();
    await expect(page.getByRole('alert')).toBeHidden();
    const right = page.getByRole('button', { name: /rechts/i }).first();
    const box = (await right.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.up();
    await expect(page.getByRole('alert')).toBeHidden();
    // Neither spotlight nor siren are offered: ONVIF cannot switch them.
    await expect(page.getByRole('button', { name: /Sirene/ })).toHaveCount(0);
  });

  test('talking to a camera opens the microphone channel', async ({ page, request }) => {
    const state = await hubState(request);
    test.skip(state.services.media.status !== 'ok', 'live video needs go2rtc and ffmpeg');

    await page.goto('/sicherheit/kamera/terrasse');
    await expectVideoPlaying(page);
    await page.getByRole('button', { name: /^Sprechen/ }).click();
    const live = page.getByRole('button', { name: /^Du sprichst/ });
    await expect(live).toBeVisible({ timeout: 20_000 });
    await live.click();
    await expect(page.getByRole('button', { name: /^Sprechen/ })).toBeVisible();
  });

  // Last in this file: a ring stays "fresh" for 45 seconds and would greet the following tests as well.
  test('ringing the doorbell interrupts whatever screen is open', async ({ page, request }) => {
    await page.goto('/musik');
    await demo(request, { action: 'ring', door: 'haustuer' });
    const overlay = page.getByRole('dialog', { name: 'Es klingelt: Haustür' });
    await expect(overlay).toBeVisible();
    await overlay.getByRole('button', { name: 'Schließen' }).click();
    await expect(overlay).toBeHidden();

    // The ring is in the door station's history, with a picture.
    await page.goto('/sicherheit/tuer/haustuer');
    await expect(page.getByRole('heading', { name: 'Verlauf' })).toBeVisible();
    await expect(page.getByText(/Geklingelt|Klingel/).first()).toBeVisible({ timeout: 20_000 });
  });
});
