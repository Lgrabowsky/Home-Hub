import { expect, test } from '@playwright/test';
import { APP_HEADERS, hubState, signIn } from './helpers.ts';

const GUEST = { username: 'gast', password: 'Besuch-darf-wenig-2026' };

test.describe('who may do what', () => {
  test('nothing works without signing in', async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const outsider = context.request;
    for (const path of ['/api/state', '/api/users', '/api/admin/settings', '/api/cameras/garten/snapshot', '/api/doors/haustuer/history', '/api/music/favorites', '/api/spotify/status', '/api/demo/state']) {
      expect((await outsider.get(path)).status(), path).toBe(401);
    }
    expect((await outsider.post('/api/doors/haustuer/open', { headers: APP_HEADERS, data: { relay: '1' } })).status()).toBe(401);
    expect((await outsider.post('/api/auth/ticket', { headers: APP_HEADERS, data: { scope: 'media' } })).status()).toBe(401);
    await context.close();
  });

  test('a request from another web page is refused even with a valid session', async ({ request }) => {
    // The session cookie is present (signed-in context), but the app's own header is not: this is what a foreign page could send.
    const forged = await request.post('/api/doors/haustuer/open', { data: { relay: '1' } });
    expect(forged.status()).toBe(403);
    const crossOrigin = await request.post('/api/doors/haustuer/open', { headers: { ...APP_HEADERS, Origin: 'https://evil.example' }, data: { relay: '1' } });
    expect(crossOrigin.status()).toBe(403);
  });

  test('a guest sees and does only what was allowed', async ({ browser, request }) => {
    const created = await request.post('/api/users', {
      headers: APP_HEADERS,
      data: { username: GUEST.username, displayName: 'Gast', role: 'guest', permissions: ['home.control', 'music.control'], password: GUEST.password },
    });
    expect(created.status()).toBe(200);

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await signIn(page, GUEST.username, GUEST.password);

    // The hub does not even send what the guest may not see.
    const state = await hubState(context.request);
    const kinds = new Set(Object.values(state.entities).map((entity) => entity.kind));
    expect(kinds.has('light')).toBe(true);
    for (const hidden of ['camera', 'door', 'contact', 'alarm']) expect(kinds.has(hidden as never), hidden).toBe(false);

    expect((await context.request.get('/api/cameras/garten/snapshot')).status()).toBe(403);
    expect((await context.request.get('/api/doors/haustuer/history')).status()).toBe(403);
    expect((await context.request.post('/api/doors/haustuer/open', { headers: APP_HEADERS, data: { relay: '1' } })).status()).toBe(403);
    expect((await context.request.post('/api/cameras/garten/ptz', { headers: APP_HEADERS, data: { op: 'left' } })).status()).toBe(403);
    expect((await context.request.get('/api/admin/settings')).status()).toBe(403);
    expect((await context.request.get('/api/users')).status()).toBe(403);
    expect((await context.request.get('/api/admin/audit')).status()).toBe(403);
    expect((await context.request.patch(`/api/users/${(await created.json()).user.id}`, { headers: APP_HEADERS, data: { role: 'admin' } })).status()).toBe(403);

    // What was allowed works.
    const lamp = Object.values(state.entities).find((entity) => entity.kind === 'light')!;
    expect((await context.request.post(`/api/entities/${encodeURIComponent(lamp.id)}/command`, { headers: APP_HEADERS, data: { action: 'toggle' } })).status()).toBe(200);

    // And the app shows no door or camera anywhere.
    await page.goto('/sicherheit');
    await expect(page.getByText('Kameras')).toBeHidden();
    await page.goto('/einstellungen/benutzer');
    await expect(page.getByText('Nur für Administratoren')).toBeVisible();
    await context.close();
  });

  test('signing out ends the session for good', async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await signIn(page, GUEST.username, GUEST.password);
    expect((await context.request.get('/api/state')).status()).toBe(200);
    const cookies = await context.cookies();

    await page.goto('/mehr');
    await page.getByRole('button', { name: 'Abmelden' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Abmelden' }).click();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();

    // Even somebody who copied the cookie beforehand is out.
    const thief = await browser.newContext({ storageState: undefined });
    await thief.addCookies(cookies);
    expect((await thief.request.get('/api/state')).status()).toBe(401);
    await thief.close();
    await context.close();
  });
});
