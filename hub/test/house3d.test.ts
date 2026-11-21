import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { House3DState, LightEntity, LoginResponse } from '@home-hub/shared';
import { readIfc } from '../src/house3d/ifc.ts';
import { buildHouseModel, readModelHeader, storeyToken } from '../src/house3d/model.ts';
import { decodeStepString, Enum, parseStep, Ref, StepError, Typed } from '../src/house3d/step.ts';
import { demoHouseIfc, stepString } from '../src/sim/demo-house.ts';
import { Client, createTestHub, setupAdmin, type TestHub } from './helpers.ts';

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.destroy();
});

function ifcFile(data: string, schema = 'IFC2X3'): string {
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','Test','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

describe('STEP files', () => {
  it('decodes the string escapes CAD programs write', () => {
    expect(decodeStepString('Haus M\\X2\\00FC\\X0\\ller')).toBe('Haus Müller');
    expect(decodeStepString("it''s")).toBe("it's");
    expect(decodeStepString('Gr\\X\\FC\\X\\DFe')).toBe('Grüße');
    expect(decodeStepString('\\X2\\00E400F6\\X0\\')).toBe('äö');
    expect(decodeStepString('a\\\\b')).toBe('a\\b');
    expect(decodeStepString(stepString("Wände 'innen'").slice(1, -1))).toBe("Wände 'innen'");
  });

  it('reads references, lists, enums, typed values and comments', () => {
    const step = parseStep(ifcFile("/* comment */\n#1=IFCTEST(#2,(1.5,-2.E-3,$),.T.,IFCLABEL('x'),*,'a;b');\n#2 = IFCOTHER(());"));
    const e = step.entities.get(1)!;
    expect(e.type).toBe('IFCTEST');
    expect(e.args[0]).toBeInstanceOf(Ref);
    expect((e.args[0] as Ref).id).toBe(2);
    expect(e.args[1]).toEqual([1.5, -0.002, null]);
    expect((e.args[2] as Enum).value).toBe('T');
    expect(e.args[3]).toBeInstanceOf(Typed);
    expect((e.args[3] as Typed).value).toBe('x');
    expect(e.args[4]).toBeNull();
    expect(e.args[5]).toBe('a;b');
    expect(step.byType.get('IFCOTHER')).toEqual([2]);
    expect(step.schema).toBe('IFC2X3');
  });

  it('refuses files that are not IFC, and says where a broken one breaks', () => {
    expect(() => parseStep('PK\u0003\u0004 zipped')).toThrow(StepError);
    expect(() => parseStep(ifcFile('#1=IFCTEST((1,2);'))).toThrow(/Zeile 8/);
  });
});

describe('IFC to the app model', () => {
  it('recognises storeys in CAD layer names', () => {
    expect(storeyToken('EG Wände')?.short).toBe('EG');
    expect(storeyToken('OG 1 Decke')?.short).toBe('1.OG');
    expect(storeyToken('2.OG Innenwände')?.short).toBe('2.OG');
    expect(storeyToken('KG Bodenplatte')?.short).toBe('KG');
    expect(storeyToken('DG Wände')?.short).toBe('DG');
    expect(storeyToken('Obergeschoss')?.order).toBe(1);
    expect(storeyToken('Dach')).toBeNull();
    expect(storeyToken('Liftschacht')).toBeNull();
  });

  it('turns the demo house into storeys, believable colours and a compact binary', () => {
    const result = readIfc(parseStep(demoHouseIfc()));
    expect(result.elements.length).toBeGreaterThan(200);
    expect(result.skipped).toEqual({});
    const built = buildHouseModel(result);
    const { info } = built;
    expect(info.levels.map((l) => l.id)).toEqual(['kg', 'eg', '1-og', 'roof', 'outside']);
    const eg = info.levels.find((l) => l.id === 'eg')!;
    expect(eg.floorZ).toBeCloseTo(0.05, 2);
    expect(eg.cutZ).toBeCloseTo(1.25, 2);
    // The basement wall standing on the cellar floor belongs to the cellar, the ceiling slab to the storey above.
    expect(info.levels.find((l) => l.id === 'kg')!.floorZ).toBeLessThan(-2);
    expect(info.materials.map((m) => m.key)).toEqual(expect.arrayContaining(['fassade', 'glas', 'beton', 'dach', 'putz', 'clt', 'stahl']));
    expect(info.materials.find((m) => m.key === 'glas')!.opacity).toBeLessThan(1);
    // Centred on the ground.
    expect(info.bounds.min[0]).toBeCloseTo(-info.bounds.max[0], 3);
    expect(info.origin[2]).toBeCloseTo(-0.05, 3);

    const { groups, dataOffset, info: header } = readModelHeader(built.binary);
    expect(header.triangles).toBe(info.triangles);
    let triangles = 0;
    for (const group of groups) {
      expect(dataOffset + group.indexOffset + group.indexCount * 4).toBeLessThanOrEqual(built.binary.length);
      const positions = new Float32Array(built.binary.buffer.slice(built.binary.byteOffset + dataOffset + group.positionOffset, built.binary.byteOffset + dataOffset + group.positionOffset + group.vertexCount * 12));
      expect(positions.every(Number.isFinite)).toBe(true);
      const indices = new Uint32Array(built.binary.buffer.slice(built.binary.byteOffset + dataOffset + group.indexOffset, built.binary.byteOffset + dataOffset + group.indexOffset + group.indexCount * 4));
      expect(Math.max(...indices)).toBeLessThan(group.vertexCount);
      triangles += group.indexCount / 3;
    }
    expect(triangles).toBe(info.triangles);
  });

  it('reads extrusions, IFC4 face sets, millimetres and the direction of north', () => {
    const data = [
      "#1=IFCPROJECT('p',$,'Projekt',$,$,$,$,(#4),#2);",
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      '#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,\'Model\',3,1.E-05,#6,#5);',
      '#5=IFCDIRECTION((1.,1.));',
      '#6=IFCAXIS2PLACEMENT3D(#7,$,$);',
      '#7=IFCCARTESIANPOINT((0.,0.,0.));',
      '#8=IFCLOCALPLACEMENT($,#6);',
      // A 4 m × 0.3 m × 2.5 m wall, extruded from a rectangle.
      '#10=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,4000.,300.);',
      '#11=IFCAXIS2PLACEMENT2D(#12,$);',
      '#12=IFCCARTESIANPOINT((2000.,150.));',
      '#13=IFCEXTRUDEDAREASOLID(#10,#6,#14,2500.);',
      '#14=IFCDIRECTION((0.,0.,1.));',
      "#15=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#13));",
      '#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#15));',
      "#17=IFCWALL('w',$,'Wand',$,$,#8,#16,$,$);",
      // A triangle mesh 1 m above.
      '#20=IFCCARTESIANPOINTLIST3D(((0.,0.,1000.),(1000.,0.,1000.),(0.,1000.,1000.)));',
      '#21=IFCTRIANGULATEDFACESET(#20,$,.F.,((1,2,3)),$);',
      "#22=IFCSHAPEREPRESENTATION(#4,'Body','Tessellation',(#21));",
      '#23=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));',
      "#24=IFCFURNISHINGELEMENT('f',$,'Tisch',$,$,#8,#23,$);",
      // An opening must not be drawn.
      "#25=IFCOPENINGELEMENT('o',$,$,$,$,#8,#16,$,$);",
    ].join('\n');
    const result = readIfc(parseStep(ifcFile(data, 'IFC4')));
    expect(result.trueNorthDeg).toBeCloseTo(45, 1);
    expect(result.elements.map((e) => e.type).sort()).toEqual(['IFCFURNISHINGELEMENT', 'IFCWALL']);
    const wall = result.elements.find((e) => e.type === 'IFCWALL')!;
    const xs = wall.pieces[0]!.positions.filter((_, i) => i % 3 === 0);
    const zs = wall.pieces[0]!.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 5);
    expect(Math.max(...zs)).toBeCloseTo(2.5, 5);
    expect(wall.pieces[0]!.indices.length / 3).toBe(12);
    const built = buildHouseModel(result);
    expect(built.info.trueNorthDeg).toBeCloseTo(45, 1);
    expect(built.info.size[2]).toBeCloseTo(2.5, 3);
  });
});

describe('3D model on the hub', () => {
  it('lets the administrator upload a model, keeps it encrypted and serves it to every user', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);
    await admin.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30 });
    expect(((await admin.post('/api/users', { username: 'mia', role: 'member', password: 'a long member password' })).statusCode)).toBe(200);
    const member = new Client(hub);
    expect(((await member.post('/api/auth/login', { username: 'mia', password: 'a long member password', client: 'web' })).json() as LoginResponse).status).toBe('ok');

    const empty = (await member.get('/api/house3d')).json() as House3DState;
    expect(empty.model).toBeNull();
    expect((await member.get('/api/house3d/model')).statusCode).toBe(404);

    const ifc = Buffer.from(demoHouseIfc(), 'latin1');
    const upload = (client: Client, body: Buffer | string) =>
      client.request('POST', '/api/house3d/model', body, { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Haus Müller.ifc') });

    expect((await upload(member, ifc)).statusCode).toBe(403);
    const broken = await upload(admin, 'kein IFC');
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: 'bad_ifc' });

    const uploaded = await upload(admin, ifc);
    expect(uploaded.statusCode).toBe(200);
    const state = uploaded.json() as House3DState;
    expect(state.model).toMatchObject({ fileName: 'Haus Müller.ifc', fileBytes: ifc.length });
    expect(state.model!.levels.length).toBe(5);

    // Stored encrypted: neither the IFC text nor the model header can be read from the disk.
    expect(hub.ctx.house3d.filesExist()).toBe(true);
    const onDisk = readFileSync(join(hub.dataDir, 'house3d', 'source.bin'));
    expect(onDisk.includes('ISO-10303-21')).toBe(false);
    expect(readFileSync(join(hub.dataDir, 'house3d', 'model.bin')).includes('HH3D')).toBe(false);

    const model = await member.get(`/api/house3d/model?v=${state.model!.version}`);
    expect(model.statusCode).toBe(200);
    expect(model.rawPayload.subarray(0, 4).toString('ascii')).toBe('HH3D');

    // View settings are checked.
    expect((await admin.put('/api/house3d/view', { northDeg: 20, latitude: 47.5, longitude: 12.1, colors: { fassade: '#a07850' }, levelNames: { eg: 'Wohnen' } })).statusCode).toBe(200);
    expect((await admin.put('/api/house3d/view', { latitude: 120 })).statusCode).toBe(400);
    expect((await member.put('/api/house3d/view', { northDeg: 0 })).statusCode).toBe(403);
    expect(((await member.get('/api/house3d')).json() as House3DState).view).toMatchObject({ northDeg: 20, latitude: 47.5, colors: { fassade: '#a07850' } });

    // Devices: only existing ones can be placed; users see only what they may see.
    const light: LightEntity = { id: 'test:lights/1', kind: 'light', name: 'Decke', room: 'Wohnen', available: true, service: 'mygekko', on: false, brightness: null, color: null, colorTemp: null } as LightEntity;
    hub.ctx.state.upsert('test', light);
    expect((await admin.put('/api/house3d/markers/nope', { position: [1, 2, 3], level: 'eg' })).statusCode).toBe(404);
    expect((await admin.put(`/api/house3d/markers/${encodeURIComponent(light.id)}`, { position: [1, 2, 'x'], level: 'eg' })).statusCode).toBe(400);
    expect((await admin.put(`/api/house3d/markers/${encodeURIComponent(light.id)}`, { position: [1, 2, 3], level: 'eg' })).statusCode).toBe(200);
    expect(((await member.get('/api/house3d')).json() as House3DState).markers).toEqual([{ entityId: light.id, position: [1, 2, 3], level: 'eg' }]);

    const audit = (await admin.get('/api/admin/audit')).json() as { entries: { action: string }[] };
    expect(audit.entries.map((e) => e.action)).toContain('house3d.uploaded');

    // Survives a restart of the hub.
    await hub.stop();
    const again = await createTestHub({ HUB_DATA_DIR: hub.dataDir });
    hubs.push(again);
    const state2 = again.ctx.house3d.state();
    expect(state2.model?.version).toBe(state.model!.version);
    expect(again.ctx.house3d.model()?.subarray(0, 4).toString('ascii')).toBe('HH3D');
  });

  it('can be removed again', async () => {
    const hub = await createTestHub();
    hubs.push(hub);
    const { client: admin } = await setupAdmin(hub);
    hub.ctx.house3d.import(Buffer.from(demoHouseIfc(), 'latin1'), 'demo.ifc');
    expect((await admin.delete('/api/house3d/model')).statusCode).toBe(200);
    expect(hub.ctx.house3d.state().model).toBeNull();
    expect(hub.ctx.house3d.filesExist()).toBe(false);
    expect((await admin.get('/api/house3d/model')).statusCode).toBe(404);
  });
});
