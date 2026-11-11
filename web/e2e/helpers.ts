import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { DemoTrigger, HubState } from '@home-hub/shared';

/** The header every state-changing request of the app carries (the hub's CSRF check). */
export const APP_HEADERS = { 'X-Requested-With': 'HomeHub' };

export async function hubState(request: APIRequestContext): Promise<HubState> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBe(true);
  return (await response.json()) as HubState;
}

/** Makes the simulated house do something (demo mode only). */
export async function demo(request: APIRequestContext, trigger: DemoTrigger): Promise<void> {
  const response = await request.post('/api/demo/trigger', { headers: APP_HEADERS, data: trigger });
  expect(response.ok()).toBe(true);
}

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).first()).toBeVisible();
}

/** Waits until a `<video>` really shows moving pictures. */
export async function expectVideoPlaying(page: Page): Promise<void> {
  const video = page.locator('video').first();
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState >= 2 && element.videoWidth > 0 && element.currentTime > 0.2), { timeout: 30_000 })
    .toBe(true);
}
