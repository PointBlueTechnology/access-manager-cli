import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute, plan, substituteEnv } from '../src/apply.ts';
import type { ApplyFile } from '../src/apply.ts';
import type { Client } from '../src/client.ts';
import { normalizeBaseUrl } from '../src/config.ts';
import { CliError } from '../src/errors.ts';
import { changes, mergeProperties } from '../src/model.ts';
import { Nam, pick } from '../src/nam.ts';
import { REDACTED, redact } from '../src/redact.ts';
import { FakeConsole } from './fake-console.ts';

function nam(fake: FakeConsole): Nam {
    return new Nam(fake as unknown as Client);
}

test('redact hides secret values but keeps flags and numbers readable', () => {
    const out = redact({
        nidsAuthClassProperties: { RECOVERY_PEPPER: 'abc', RP_ID: 'idp', SIGNAL_PASSWORD_MANAGERS: 'true', TIMEOUT: '30' },
        proxyPassword: 'secret',
        nidsAuthContractProperties: [{ name: 'API_KEY', value: 'k', type: 'string' }, { name: 'MODE', value: 'LOGIN' }],
        nested: [{ clientSecret: 'x' }],
    });
    assert.deepEqual(out, {
        nidsAuthClassProperties: { RECOVERY_PEPPER: REDACTED, RP_ID: 'idp', SIGNAL_PASSWORD_MANAGERS: 'true', TIMEOUT: '30' },
        proxyPassword: REDACTED,
        nidsAuthContractProperties: [{ name: 'API_KEY', value: REDACTED, type: 'string' }, { name: 'MODE', value: 'LOGIN' }],
        nested: [{ clientSecret: REDACTED }],
    });
});

test('pick finds by ID, exact name, then a unique case-insensitive name', () => {
    const items = [{ id: 'A1', name: 'Login' }, { id: 'A2', name: 'login2' }];
    assert.equal(pick(items, 'A2', 'x').name, 'login2');
    assert.equal(pick(items, 'Login', 'x').id, 'A1');
    assert.equal(pick(items, 'LOGIN', 'x').id, 'A1');
    assert.throws(() => pick(items, 'nope', 'x'), (e: unknown) => e instanceof CliError && e.code === 'NOT_FOUND');
    assert.throws(() => pick([...items, { id: 'A3', name: 'LOGIN' }], 'login', 'x'), (e: unknown) => e instanceof CliError && e.code === 'USAGE');
});

test('mergeProperties merges, replaces and unsets', () => {
    assert.deepEqual(mergeProperties({ A: '1', B: '2' }, { B: '3' }), { A: '1', B: '3' });
    assert.deepEqual(mergeProperties({ A: '1', B: '2' }, { B: '3' }, { replace: true }), { B: '3' });
    assert.deepEqual(mergeProperties({ A: '1', B: '2' }, undefined, { unset: ['A'] }), { B: '2' });
});

test('changes ignores order in lists and keys', () => {
    assert.deepEqual(changes({ a: [1, 2], b: { x: 1, y: 2 } }, { a: [2, 1], b: { y: 2, x: 1 } }), {});
    assert.deepEqual(changes({ a: 1 }, { a: 2 }), { a: { from: 1, to: 2 } });
});

test('substituteEnv reads ${env:NAME} and refuses unset names', () => {
    process.env.AMCLI_TEST_VALUE = 'v';
    assert.deepEqual(substituteEnv({ a: ['x-${env:AMCLI_TEST_VALUE}'] }), { a: ['x-v'] });
    assert.throws(() => substituteEnv('${env:AMCLI_TEST_UNSET_NAME}'), /isn't set/);
});

test('normalizeBaseUrl adds /nps and requires https', () => {
    assert.equal(normalizeBaseUrl('https://ac.example.com:8443'), 'https://ac.example.com:8443/nps');
    assert.equal(normalizeBaseUrl('https://ac.example.com:8443/nps/'), 'https://ac.example.com:8443/nps');
    assert.throws(() => normalizeBaseUrl('http://ac.example.com'), /https/);
});

const FILE: ApplyFile = {
    classes: [{ name: 'Passkey1', javaClass: 'com.example.Passkey', properties: { RP_ID: 'idp.example.com' } }],
    methods: [{ name: 'Login', class: 'Passkey1', userStores: ['eDirectory'], properties: { MODE: 'LOGIN' } }],
    contracts: [{ name: 'Login', uri: '/passkey/login', methods: ['Login'] }],
};

test('apply creates what is missing, keeps unlisted properties, and is idempotent', async () => {
    const fake = new FakeConsole();
    const first = await plan(nam(fake), FILE, false);
    assert.deepEqual(first.map(i => `${i.action} ${i.kind}`), ['unchanged class', 'create method', 'create contract']);
    await execute(nam(fake), FILE, first);
    assert.equal(fake.store.methods[0].nidsAuthClassCN, 'AC1');
    assert.deepEqual(fake.store.contracts[0].nidsAuthMethodCNList, [fake.store.methods[0].id]);
    assert.equal(fake.store.contracts[0].nidsCardID, 'Login');
    // The pepper the file doesn't mention is still there
    assert.equal((fake.store.classes[0].nidsAuthClassProperties as Record<string, string>).RECOVERY_PEPPER, 'pepper-value');
    const again = await plan(nam(fake), FILE, false);
    assert.deepEqual(again.map(i => i.action), ['unchanged', 'unchanged', 'unchanged']);
});

test('apply updates only what differs, and --delete removes contracts before methods', async () => {
    const fake = new FakeConsole();
    await execute(nam(fake), FILE, await plan(nam(fake), FILE, false));
    const changed: ApplyFile = { ...FILE, methods: [{ ...FILE.methods![0], properties: { MODE: 'LOGIN', ACCOUNT_CHECK: 'verify-rights' } }] };
    const items = await plan(nam(fake), changed, false);
    assert.deepEqual(items.map(i => i.action), ['unchanged', 'update', 'unchanged']);
    await execute(nam(fake), changed, items);
    assert.equal((fake.store.methods[0].nidsAuthClassProperties as Record<string, string>).ACCOUNT_CHECK, 'verify-rights');

    const removal = await plan(nam(fake), { methods: FILE.methods, contracts: FILE.contracts }, true);
    assert.deepEqual(removal.map(i => `${i.action} ${i.kind}`), ['delete contract', 'delete method']);
    await execute(nam(fake), FILE, removal);
    assert.equal(fake.store.contracts.length, 0);
    assert.equal(fake.store.methods.length, 0);
    assert.equal(fake.store.classes.length, 1);
});

test('extract takes one file out of the console\'s .tar.gz download', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { extract } = await import('../src/afc.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcli-'));
    const target = path.join(dir, 'customfiles/opt/novell/nids/lib/webapp/jsp');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'login.jsp'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'customfiles/filesSucceeded'), '/opt/novell/nids/lib/webapp/jsp/login.jsp\n');
    const archive = path.join(dir, 'files.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'customfiles']);
    assert.equal(extract(fs.readFileSync(archive), '/opt/novell/nids/lib/webapp/jsp/login.jsp').toString(), 'hello\n');
    assert.throws(() => extract(fs.readFileSync(archive), '/opt/other.jsp'), /didn't contain/);
    assert.equal(extract(Buffer.from('plain'), '/x').toString(), 'plain');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('substitute reads ${env:NAME:-default} and ${file:path}', async () => {
    const { substitute } = await import('../src/apply.ts');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcli-'));
    fs.writeFileSync(path.join(dir, 'root.pem'), '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n');
    delete process.env.AMCLI_TEST_UNSET_NAME;
    assert.equal(substitute('${env:AMCLI_TEST_UNSET_NAME:-fallback}', dir), 'fallback');
    process.env.AMCLI_TEST_VALUE = 'v';
    assert.equal(substitute('${env:AMCLI_TEST_VALUE:-fallback}', dir), 'v');
    assert.equal(substitute('${file:root.pem}', dir), '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----');
    assert.throws(() => substitute('${file:missing.pem}', dir), /can't be read/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup undoes an apply exactly: old values back, added ones unset, created objects removed', async () => {
    const { Backup } = await import('../src/apply.ts');
    const fake = new FakeConsole();
    await execute(nam(fake), FILE, await plan(nam(fake), FILE, false));
    const before = structuredClone(fake.store);

    const setup: ApplyFile = {
        classes: [{ name: 'Passkey1', properties: { RECOVERY_CODES: 'false' } } as never],
        methods: [{ name: 'Login', properties: { MODE: 'MANAGE', ACCOUNT_CHECK: 'verify-rights' } } as never],
        contracts: [{ name: 'Extra', uri: '/x', methods: ['Login'] }],
    };
    const backup = new Backup();
    await execute(nam(fake), setup, await plan(nam(fake), setup, false), backup);
    assert.equal((fake.store.methods[0].nidsAuthClassProperties as Record<string, string>).MODE, 'MANAGE');
    assert.equal(fake.store.contracts.length, 2);
    // Only what the setup touched is recorded: not the pepper
    assert.deepEqual(backup.restore.classes, [{ name: 'Passkey1', unsetProperties: ['RECOVERY_CODES'] }]);
    assert.deepEqual(backup.restore.methods, [{ name: 'Login', properties: { MODE: 'LOGIN' }, unsetProperties: ['ACCOUNT_CHECK'] }]);
    assert.deepEqual(backup.restore.remove.contracts, ['Extra']);

    await execute(nam(fake), backup.restore, await plan(nam(fake), backup.restore, false));
    assert.deepEqual(fake.store, before);
});

test('redact keeps settings that describe a secret, and still hides the secret itself', () => {
    const out = redact({
        tokenEndpoint: 'https://idp/token', nidsTokenIssuer: 'https://idp', forgotPasswordUserUrl: 'https://idp/fp',
        securityTokenType: 'saml2', secretName: 'my-store', accessTokenTTL: '3600',
        clientSecret: 'abc', nidsAdminPassword: 'pw', encryptionPasswordHashKey: 'k', RECOVERY_PEPPER: 'p',
    });
    assert.deepEqual(out, {
        tokenEndpoint: 'https://idp/token', nidsTokenIssuer: 'https://idp', forgotPasswordUserUrl: 'https://idp/fp',
        securityTokenType: 'saml2', secretName: 'my-store', accessTokenTTL: '3600',
        clientSecret: REDACTED, nidsAdminPassword: REDACTED, encryptionPasswordHashKey: REDACTED, RECOVERY_PEPPER: REDACTED,
    });
});

test('idsFrom takes IDs from the shallowest list that has them, and can filter', async () => {
    const { idsFrom } = await import('../src/export.ts');
    assert.deepEqual(idsFrom({ content: [{ id: 'A' }, { id: 'B' }] }, ['id']), ['A', 'B']);
    assert.deepEqual(idsFrom({ assigned: [{ clusterId: 'C1', servers: [{ deviceId: 'D1' }] }] }, ['deviceId']), ['D1']);
    assert.deepEqual(idsFrom({ list: { item: [{ uri: 'https://ac/amsvc/v1/things/T1' }] } }, ['x'], '/amsvc/v1/things'), ['T1']);
    assert.deepEqual(idsFrom([{ id: 'ST1' }, { id: 'LT2' }], ['id'], undefined, item => String(item.id).startsWith('ST')), ['ST1']);
});

test('diffValues pairs list items by ID, ignores order and normalizes signed metadata', async () => {
    const { diffValues, normalizeText } = await import('../src/diff.ts');
    const ignore = new Set<string>();
    assert.deepEqual(diffValues([{ id: 'A', v: 1 }, { id: 'B', v: 2 }], [{ id: 'B', v: 2 }, { id: 'A', v: 1 }], ignore), []);
    assert.deepEqual(diffValues([{ id: 'A', v: 1 }], [{ id: 'A', v: 2 }, { id: 'C', v: 3 }], ignore), [
        { path: '[id=A].v', kind: 'changed', from: 1, to: 2 },
        { path: '[id=C]', kind: 'added', to: { id: 'C', v: 3 } },
    ]);
    assert.deepEqual(diffValues(['x', 'y'], ['y', 'x'], ignore), []);
    const signed = (id: string, sig: string) => `<md:EntityDescriptor ID="${id}" entityID="e"><ds:SignatureValue>${sig}</ds:SignatureValue><md:IDPSSODescriptor ID="${id}2"/></md:EntityDescriptor>`;
    assert.equal(normalizeText(signed('a1', 'xx')), normalizeText(signed('b2', 'yy')));
});

test('readZip opens a ZipCrypto zip, and parseXml finds elements and attributes', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readZip } = await import('../src/zip.ts');
    const { parseXml, findAll } = await import('../src/xml.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcli-'));
    fs.mkdirSync(path.join(dir, 'agConfig'));
    fs.writeFileSync(path.join(dir, 'agConfig/AG_AgConfig.xml'), '<?xml version="1.0"?><A><B Name="one &amp; two"/><B Name=\'x\'><C/></B><!-- note --></A>'.repeat(3));
    execFileSync('zip', ['-q', '-r', '-P', 'secret-pw', 'out.zip', 'agConfig'], { cwd: dir });
    const entries = readZip(fs.readFileSync(path.join(dir, 'out.zip')), 'secret-pw');
    const xml = entries.get('agConfig/AG_AgConfig.xml')!.toString();
    assert.ok(xml.startsWith('<?xml'));
    const names = findAll(parseXml(xml), 'B').map(b => b.attrs.Name);
    assert.deepEqual(names, ['one & two', 'x', 'one & two', 'x', 'one & two', 'x']);
    assert.throws(() => readZip(fs.readFileSync(path.join(dir, 'out.zip'))), /needs a password/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('certificate dates and PEM layout', async () => {
    const { parseDate, formatPem } = await import('../src/certs.ts');
    assert.equal(parseDate('Monday, July 21, 2025 at 6:14:57 PM GMT')?.toISOString(), '2025-07-21T18:14:57.000Z');
    assert.equal(parseDate('nonsense'), undefined);
    const body = 'A'.repeat(100);
    assert.equal(formatPem(`-----BEGIN CERTIFICATE-----${body}-----END CERTIFICATE-----`), `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'A'.repeat(36)}\n-----END CERTIFICATE-----\n`);
});

test('contractRefs finds contract IDs under contract-named keys and their children', async () => {
    const { contractRefs } = await import('../src/saml.ts');
    assert.deepEqual(contractRefs({
        authCardConfig: { authContracts: ['ALC1'] },
        providerAccessSettings: { satisfiesContractList: { refId: [{ value: 'ALC2' }] } },
        other: 'ALC3',
    }).sort(), ['ALC1', 'ALC2']);
});

test('backups are named by time, listed only when complete, and pruned oldest first', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { backupName, listBackups, toPrune } = await import('../src/backup.ts');
    const { diffExports } = await import('../src/diff.ts');
    assert.equal(backupName(new Date('2026-11-16T03:04:05.678Z')), '2026-11-16T03-04-05Z');
    const root = fs.mkdtempSync(`${os.tmpdir()}/amcli-test-`);
    try {
        for (const name of ['2026-11-14T03-00-00Z', '2026-11-15T03-00-00Z', '2026-11-16T03-00-00Z']) {
            fs.mkdirSync(`${root}/${name}/_backup`, { recursive: true });
            fs.writeFileSync(`${root}/${name}/manifest.json`, '{}');
            fs.writeFileSync(`${root}/${name}/a.json`, '{"x":1}');
            fs.writeFileSync(`${root}/${name}/_backup/backup.json`, JSON.stringify({ name }));
        }
        fs.mkdirSync(`${root}/2026-11-17T03-00-00Z.partial`);
        fs.mkdirSync(`${root}/2026-11-13T03-00-00Z`);
        fs.mkdirSync(`${root}/notes`);
        assert.deepEqual(listBackups(root), ['2026-11-14T03-00-00Z', '2026-11-15T03-00-00Z', '2026-11-16T03-00-00Z']);
        assert.deepEqual(toPrune(listBackups(root), 2), ['2026-11-14T03-00-00Z']);
        assert.deepEqual(toPrune(listBackups(root), 0), ['2026-11-14T03-00-00Z', '2026-11-15T03-00-00Z'], 'never removes the newest');
        assert.deepEqual(toPrune(listBackups(root), 5), []);
        // What a backup run writes beside the export doesn't count as a change
        assert.equal(diffExports(`${root}/2026-11-15T03-00-00Z`, `${root}/2026-11-16T03-00-00Z`).summary.same, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--settings loads the settings file; a missing one is a usage error from amcli, not Node', async () => {
    const { spawnSync } = await import('node:child_process');
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const missing = run('--settings', '/nonexistent/amcli.env', 'ping');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Settings file not found/);
    assert.equal(run('--settings', '/nonexistent/amcli.env', '--version').stdout.trim(), run('--version').stdout.trim());
    const both = run('--settings', 'a.env', '--env-file', '/dev/null', 'ping');
    assert.equal(both.status, 2);
    assert.match(both.stderr, /not both/);
});

test('mcp: tools come from the command table, with positionals and options as inputs', async () => {
    const { positionalsOf, toolsFor, toInvocation, toolTerms } = await import('../src/mcp.ts');
    assert.equal(toolTerms('Run amcli update --yes to apply it'), 'Run the update tool with yes: true to apply it');
    assert.equal(toolTerms('run amcli saml get x'), 'run the saml_get tool x');
    assert.equal(toolTerms('x isn\'t an amcli export folder'), 'x isn\'t an amcli export folder');
    assert.equal(toolTerms('add --yes to go ahead, or --dry-run to see it first'), 'add yes: true to go ahead, or dry-run: true to see it first');
    const { COMMANDS } = await import('../src/commands.ts');
    assert.deepEqual(positionalsOf('<export> [<export>]').map(p => [p.name, p.required]), [['export', true], ['export2', false]]);
    assert.deepEqual(positionalsOf('<name|id|entityID>...').map(p => [p.name, p.many]), [['names', true]]);
    const all = toolsFor(false).map(t => t.tool.name);
    const readOnly = toolsFor(true).map(t => t.tool.name);
    assert.ok(all.includes('class_delete') && all.includes('update') && all.includes('saml_create_sp'));
    assert.ok(!readOnly.includes('class_delete') && !readOnly.includes('update') && !readOnly.includes('api') && readOnly.includes('report'));
    assert.ok(!all.includes('mcp') && !all.includes('describe'));
    const deleteTool = toolsFor(false).find(t => t.tool.name === 'class_delete')!.tool as { annotations: { destructiveHint: boolean }; inputSchema: { properties: Record<string, unknown> } };
    assert.equal(deleteTool.annotations.destructiveHint, true);
    assert.ok('yes' in deleteTool.inputSchema.properties && !('exit-code' in deleteTool.inputSchema.properties));
    const diff = COMMANDS.find(c => c.name === 'diff')!;
    assert.deepEqual(toInvocation(diff, { export: 'a', export2: 'b', only: ['apply'], summary: true }), { values: { only: ['apply'], summary: true }, positionals: ['a', 'b'] });
    assert.throws(() => toInvocation(diff, { export: 'a', bogus: 1 }), /no input bogus/);
    assert.throws(() => toInvocation(diff, {}), /needs export/);
    assert.throws(() => toInvocation(diff, { export: 'a', summary: 'yes' }), /true or false/);
});

test('mcp: calls run the command, redact secrets, and report errors as tool errors', async () => {
    const { McpServer } = await import('../src/mcp.ts');
    const fake = new FakeConsole();
    const server = new McpServer({ readOnly: false, revealSecrets: false, config: {}, nam: () => nam(fake) });
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as { result: { protocolVersion: string } };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: { text: string }[]; isError?: boolean } };
        return { isError: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) };
    };
    const shown = await call('class_get', { name: 'Passkey1' });
    assert.equal(shown.isError, false);
    assert.equal(JSON.stringify(shown.body).includes('pepper-value'), false, 'secrets are redacted');
    const refused = await call('class_delete', { names: ['Passkey1'] });
    assert.equal(refused.isError, true);
    assert.equal(refused.body.error.code, 'CONFIRM');
    assert.match(refused.body.error.message, /add yes: true to go ahead, or dry-run: true/);
    assert.equal(fake.store.classes.length, 1, 'nothing deleted without yes');
    const missing = await call('class_get', { name: 'nope' });
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    const unknown = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } }) as { error: { code: number } };
    assert.equal(unknown.error.code, -32602);
});
