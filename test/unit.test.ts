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
