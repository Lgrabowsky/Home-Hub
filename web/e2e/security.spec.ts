import { expect, test } from '@playwright/test';
import { demo, expectVideoPlaying, hubState } from './helpers.ts';

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
