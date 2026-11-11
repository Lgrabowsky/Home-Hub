import { expect, test } from '@playwright/test';
import { hubState } from './helpers.ts';

test.describe('music', () => {
  test('the rooms show what is playing', async ({ page }) => {
    await page.goto('/musik');
    await expect(page.getByRole('button', { name: 'Wohnzimmer + 1: Details öffnen' })).toContainText('Kleine Fluchten');
    await expect(page.getByRole('button', { name: 'Bad: Details öffnen' })).toBeVisible();
  });

  test('an album found in Spotify plays on the chosen speaker', async ({ page, request }) => {
    await page.goto('/musik');
    await page.getByRole('tab', { name: 'Entdecken' }).click();
    await page.getByRole('radiogroup', { name: 'Abspielen in' }).getByText('Büro').click();
    await page.getByLabel('Musik suchen').fill('Polarnacht');
    await page.getByRole('button', { name: 'Polarnacht abspielen' }).first().click();

    await expect
      .poll(async () => {
        const state = await hubState(request);
        const office = state.music.players.find((player) => player.name === 'Büro')!;
        const group = state.music.groups.find((entry) => entry.id === office.groupId)!;
        return { state: group.state, title: group.track?.title, source: group.track?.source };
      })
      .toEqual({ state: 'playing', title: 'Erstes Licht', source: 'spotify' });

    await page.getByRole('tab', { name: 'Räume' }).click();
    await expect(page.getByRole('button', { name: 'Büro: Details öffnen' })).toContainText('Erstes Licht');
  });

  test('pausing from the app stops the speaker', async ({ page, request }) => {
    await page.goto('/musik');
    const card = page.getByRole('button', { name: 'Wohnzimmer + 1: Details öffnen' });
    await expect(card).toBeVisible();
    await card.locator('xpath=ancestor::div[contains(@class,"rounded-tile")][1]').getByRole('button', { name: 'Pause' }).click();
    await expect
      .poll(async () => (await hubState(request)).music.groups.find((group) => group.name === 'Wohnzimmer + 1')?.state)
      .toBe('paused');
  });
});
