import { expect, test, type APIRequestContext } from '@playwright/test';
import { EMPTY_LAYOUT, type Entity, type HouseLayout } from '@home-hub/shared';
import { APP_HEADERS, hubState } from './helpers.ts';

const currentLayout = async (request: APIRequestContext) => ((await (await request.get('/api/layout')).json()) as { layout: HouseLayout }).layout;

/** A device by the name it reports (or has now), with its room. */
async function device(request: APIRequestContext, name: string, room?: string): Promise<Entity | undefined> {
  return Object.values((await hubState(request)).entities).find((entity) => (entity.name === name || entity.auto?.name === name) && (!room || (entity.auto?.room ?? entity.room) === room));
}

test.describe('arranging the house', () => {
  test.afterEach(async ({ request }) => {
    // Every test leaves the house as the hub recognised it.
    const layout = await currentLayout(request);
    await request.put('/api/layout', { headers: APP_HEADERS, data: { layout: { ...EMPTY_LAYOUT, cameraLights: layout.cameraLights } } });
  });

  test('rooms are renamed, merged, created and filled — and every change can be undone', async ({ page, request }) => {
    await page.goto('/raeume');
    await page.getByRole('button', { name: 'Bearbeiten' }).click();

    // A room gets another name; its devices follow.
    await page.getByRole('button', { name: 'Büro bearbeiten' }).click();
    const office = page.getByRole('dialog', { name: 'Raum bearbeiten' });
    await office.getByLabel('Name').fill('Arbeitszimmer');
    await office.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(async () => (await device(request, 'Büro Decke'))?.room).toBe('Arbeitszimmer');
    await expect(page.getByRole('button', { name: 'Arbeitszimmer bearbeiten' })).toBeVisible();

    // A new area with a new room, and a lamp brought into it.
    await page.getByRole('button', { name: 'Bereich', exact: true }).click();
    const area = page.getByRole('dialog', { name: 'Neuer Bereich' });
    await area.getByLabel('Name').fill('Dachgeschoss');
    await area.getByRole('button', { name: 'Anlegen' }).click();
    await page.getByRole('button', { name: 'Raum in Dachgeschoss' }).click();
    const newRoom = page.getByRole('dialog', { name: 'Neuer Raum in Dachgeschoss' });
    await newRoom.getByLabel('Name').fill('Spitzboden');
    await newRoom.getByRole('button', { name: 'Anlegen' }).click();
    const attic = page.getByRole('dialog', { name: 'Raum bearbeiten' });
    await expect(attic).toContainText('Spitzboden');
    await attic.getByRole('button', { name: 'Gerät hierher holen' }).click();
    const bring = page.getByRole('dialog', { name: 'Gerät nach „Spitzboden“ holen' });
    await bring.getByLabel('Gerät oder Raum suchen').fill('Kinderzimmer Decke');
    await bring.getByRole('button', { name: /Kinderzimmer Decke/ }).click();
    await expect.poll(() => device(request, 'Kinderzimmer Decke')).toMatchObject({ room: 'Spitzboden', auto: { room: 'Kinderzimmer' } });
    await bring.getByRole('button', { name: 'Schließen' }).click();
    await expect(attic.getByText('Kinderzimmer Decke')).toBeVisible();
    await attic.getByRole('button', { name: 'Schließen' }).click();

    // Two rooms become one.
    await page.getByRole('button', { name: 'Esszimmer bearbeiten' }).click();
    const dining = page.getByRole('dialog', { name: 'Raum bearbeiten' });
    await dining.getByLabel('Mit einem anderen Raum zusammenführen').selectOption('Küche');
    await dining.getByRole('button', { name: 'Zusammenführen' }).click();
    await page.getByRole('dialog', { name: '„Esszimmer“ und „Küche“ zusammenführen?' }).getByRole('button', { name: 'Zusammenführen' }).click();
    await expect.poll(async () => (await device(request, 'Esstisch'))?.room).toBe('Küche');

    // Areas in another order.
    await page.getByRole('button', { name: 'Dachgeschoss nach oben' }).click();
    await expect.poll(async () => {
      const names = (await currentLayout(request)).floors!.map((floor) => floor.name);
      return names.indexOf('Dachgeschoss') === names.length - 2;
    }).toBe(true);
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect(page.getByRole('heading', { name: 'Dachgeschoss' })).toBeVisible();

    // One room back: the dining room returns, in its place on the ground floor.
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await page.getByRole('button', { name: 'Küche bearbeiten' }).click();
    await page.getByRole('dialog', { name: 'Raum bearbeiten' }).getByRole('button', { name: 'Zurücksetzen' }).click();
    await page.getByRole('dialog', { name: '„Küche“ zurücksetzen?' }).getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect.poll(async () => (await device(request, 'Esstisch'))?.room).toBe('Esszimmer');
    expect((await currentLayout(request)).floors!.find((floor) => floor.name === 'Erdgeschoss')!.rooms).toEqual(expect.arrayContaining(['Küche', 'Esszimmer']));

    // Everything back.
    await page.getByRole('button', { name: 'Zurücksetzen' }).click();
    await page.getByRole('dialog', { name: 'Alles zurücksetzen?' }).getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect.poll(() => currentLayout(request)).toMatchObject({ floors: null, rooms: {}, devices: {}, order: {} });
    await expect.poll(async () => (await device(request, 'Büro Decke'))?.room).toBe('Büro');
    await expect.poll(async () => (await device(request, 'Kinderzimmer Decke'))?.room).toBe('Kinderzimmer');
    await expect(page.getByRole('heading', { name: 'Dachgeschoss' })).toHaveCount(0);

    await page.goto('/einstellungen/protokoll');
    await expect(page.getByText('erika hat Räume und Geräte geändert: Raum „Büro“ heißt jetzt „Arbeitszimmer“').first()).toBeVisible();
  });

  test('the menus are edited as well: devices hidden, renamed and sorted', async ({ page, request }) => {
    await page.goto('/licht');
    await page.getByRole('button', { name: 'Bearbeiten' }).click();

    // Hidden: gone from the menu, still known to the hub.
    await page.getByRole('button', { name: 'Stehlampe ausblenden' }).click();
    await expect.poll(async () => (await device(request, 'Stehlampe', 'Wohnzimmer'))?.hidden).toBe(true);
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect(page.getByRole('switch', { name: /^Stehlampe (ein|aus)schalten$/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await page.getByRole('button', { name: 'Stehlampe einblenden' }).click();
    await expect.poll(async () => (await device(request, 'Stehlampe', 'Wohnzimmer'))?.hidden).toBeUndefined();

    // Renamed, and back to the name the controller reports.
    await page.getByRole('button', { name: 'LED-Band bearbeiten' }).click();
    const editor = page.getByRole('dialog', { name: 'Gerät bearbeiten' });
    await editor.getByLabel('Name').fill('Lichtleiste');
    await editor.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => device(request, 'LED-Band')).toMatchObject({ name: 'Lichtleiste', auto: { name: 'LED-Band' } });
    await page.getByRole('button', { name: 'Lichtleiste bearbeiten' }).click();
    await page.getByRole('dialog', { name: 'Gerät bearbeiten' }).getByRole('button', { name: 'Zurücksetzen' }).click();
    await expect.poll(async () => (await device(request, 'LED-Band'))?.name).toBe('LED-Band');

    // Sorted within the room by its grip (keyboard here).
    const lamp = (await device(request, 'Stehlampe', 'Wohnzimmer'))!;
    const band = (await device(request, 'LED-Band'))!;
    await page.getByRole('button', { name: 'Stehlampe verschieben' }).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await expect.poll(async () => {
      const order = (await currentLayout(request)).order.wohnzimmer ?? [];
      return order.indexOf(lamp.id) >= 0 && order.indexOf(lamp.id) < order.indexOf(band.id);
    }).toBe(true);
  });

  test('a camera gets the lights it needs, switched right on its page', async ({ page, request }) => {
    const terrace = async () => Object.values((await hubState(request)).entities).find((entity): entity is Extract<Entity, { kind: 'light' }> => entity.kind === 'light' && entity.name === 'Terrasse');
    await page.goto('/sicherheit/kamera/garten');
    await page.getByRole('button', { name: 'Lichter zuordnen' }).click();
    const picker = page.getByRole('dialog', { name: 'Lichter für diese Kamera' });
    await picker.getByRole('checkbox', { name: 'Terrasse' }).click();
    await picker.getByRole('button', { name: '1 Licht übernehmen' }).click();
    await expect.poll(async () => (await currentLayout(request)).cameraLights['cam:garten']).toEqual([(await terrace())!.id]);

    // An ordinary light switch below the picture.
    const before = (await terrace())!.on;
    await page.getByRole('switch', { name: `Terrasse ${before ? 'ausschalten' : 'einschalten'}` }).click();
    await expect.poll(async () => (await terrace())?.on, { timeout: 20_000 }).toBe(!before);

    // And off the page again.
    await page.getByRole('button', { name: 'Ändern' }).click();
    await picker.getByRole('checkbox', { name: 'Terrasse' }).click();
    await picker.getByRole('button', { name: 'Ohne Lichter speichern' }).click();
    await expect.poll(async () => (await currentLayout(request)).cameraLights['cam:garten']).toBeUndefined();
    await expect(page.getByRole('switch', { name: /^Terrasse/ })).toHaveCount(0);
  });

  test('an older hub is pointed out instead of new functions failing with "Nicht gefunden"', async ({ page }) => {
    // As a hub of version 0.3 would answer.
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), version: '0.3.0' } });
    });
    await page.route('**/api/layout', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 404, json: { error: 'not_found', message: 'Nicht gefunden.' } }) : route.fallback()));
    await page.goto('/licht');
    await expect(page.getByText(/Der Hub ist älter als die App \(Hub 0\.3\.0/)).toBeVisible();
    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    await page.getByRole('button', { name: 'Stehlampe ausblenden' }).click();
    await expect(page.getByText('Der Hub kennt diese Funktion noch nicht. Bitte den Hub auf Version 0.4.0 oder neuer aktualisieren.')).toBeVisible();
    // Nothing changed.
    await expect(page.getByRole('button', { name: 'Stehlampe ausblenden' })).toBeVisible();
    await page.getByRole('button', { name: 'Hinweis schließen' }).click();
    await expect(page.getByText(/Der Hub ist älter als die App/)).toHaveCount(0);
  });

  test('actions and time switches are separate menus', async ({ page }) => {
    await page.goto('/aktionen');
    const menus = page.getByRole('navigation', { name: 'Bereiche' });
    await expect(menus.getByRole('link', { name: 'Uhren' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Szenen' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Zeitschaltuhren/ })).toHaveCount(0);
    await menus.getByRole('link', { name: 'Uhren' }).click();
    await expect(page).toHaveURL(/\/uhren$/);
    await expect(page.getByRole('heading', { name: 'Zeitschaltuhren des Hubs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zeitschaltuhren am myGEKKO' })).toBeVisible();
  });
});
