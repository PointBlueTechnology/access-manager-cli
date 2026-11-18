import fs from 'node:fs';
import os from 'node:os';
import * as afc from './afc.ts';
import { Backup, execute, plan, readApplyFile } from './apply.ts';
import { runBackup } from './backup.ts';
import { getCert, listCerts } from './certs.ts';
import * as saml from './saml.ts';
import { diffExports, exportedApis } from './diff.ts';
import { CliError, EXIT, usage } from './errors.ts';
import { runExport } from './export.ts';
import { progress } from './output.ts';
import { accessGatewayConfigs, buildReport, toMarkdown } from './report.ts';
import { changes, classBody, classView, contractBody, contractView, methodBody, methodView } from './model.ts';
import type { Properties, PropertyChange } from './model.ts';
import { kindLabel } from './nam.ts';
import type { Kind, Nam } from './nam.ts';
import { runUpdate, UPDATE_TYPES } from './update.ts';
import type { Method } from './client.ts';
import type { ConfigFlags } from './config.ts';

/**
 * Every command, with the options it takes. The same table drives argument parsing, `amcli help`
 * and `amcli describe`, so what agents read is what the CLI does.
 */
export interface OptionSpec {
    type: 'string' | 'boolean';
    multiple?: boolean;
    short?: string;
    description: string;
}

export interface Context {
    nam: () => Nam;
    values: Record<string, string | boolean | string[] | undefined>;
    positionals: string[];
    quiet: boolean;
    /** The connection settings given on the command line, for commands that connect themselves (mcp) */
    config?: ConfigFlags;
}

export interface Command {
    name: string;
    summary: string;
    args?: string;
    options?: Record<string, OptionSpec>;
    /** Changes the console's configuration (supports --dry-run) */
    writes?: boolean;
    /** Needs --yes, because it deletes something or interrupts service */
    confirm?: boolean;
    offline?: boolean;
    /** Output holds no secrets and must not be redacted (describe) */
    plain?: boolean;
    /** Talks over stdin and stdout itself, so nothing is printed after it (mcp) */
    stdio?: boolean;
    run: (context: Context) => Promise<unknown>;
}

const RAW: Record<string, OptionSpec> = { raw: { type: 'boolean', description: 'Show the console API\'s own body instead of the CLI\'s shape' } };
const DRY: Record<string, OptionSpec> = { 'dry-run': { type: 'boolean', description: 'Show what would be sent and change nothing' } };
const YES: Record<string, OptionSpec> = { yes: { type: 'boolean', short: 'y', description: 'Confirm a delete or a service-affecting action' } };
const PROPS: Record<string, OptionSpec> = {
    prop: { type: 'string', multiple: true, description: 'Property NAME=VALUE (repeatable)' },
    'props-file': { type: 'string', description: 'JSON file of {"NAME": "VALUE"} properties' },
};
const UPDATE_PROPS: Record<string, OptionSpec> = {
    ...PROPS,
    unset: { type: 'string', multiple: true, description: 'Remove property NAME (repeatable)' },
    'replace-props': { type: 'boolean', description: 'Replace all properties instead of merging' },
};

function str(context: Context, name: string): string | undefined {
    const value = context.values[name];
    return typeof value === 'string' ? value : undefined;
}

function list(context: Context, name: string): string[] {
    const value = context.values[name];
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return items.flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean);
}

function flag(context: Context, name: string): boolean {
    return context.values[name] === true;
}

function int(context: Context, name: string): number | undefined {
    const value = str(context, name);
    if (value === undefined) {
        return undefined;
    }
    const number = Number(value);
    if (!Number.isInteger(number)) {
        throw usage(`--${name} must be a whole number`);
    }
    return number;
}

function properties(context: Context): Properties | undefined {
    const out: Properties = {};
    let any = false;
    const file = str(context, 'props-file');
    if (file) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw usage('--props-file must hold a JSON object');
        }
        for (const [key, value] of Object.entries(parsed)) {
            out[key] = String(value);
            any = true;
        }
    }
    for (const pair of (context.values.prop as string[] | undefined) ?? []) {
        const at = pair.indexOf('=');
        if (at < 1) {
            throw usage(`--prop takes NAME=VALUE, not "${pair}"`);
        }
        out[pair.slice(0, at)] = pair.slice(at + 1);
        any = true;
    }
    return any ? out : undefined;
}

function propertyChange(context: Context): PropertyChange {
    return { replace: flag(context, 'replace-props'), unset: list(context, 'unset') };
}

function one(context: Context, what: string): string {
    const [ref, ...rest] = context.positionals;
    if (!ref || rest.length) {
        throw usage(`Give one ${what} name or ID`);
    }
    return ref;
}

function needYes(context: Context, what: string): void {
    if (!flag(context, 'yes') && !flag(context, 'dry-run')) {
        throw new CliError('CONFIRM', `${what}: add --yes to go ahead, or --dry-run to see it first`);
    }
}

async function view(kind: Kind, raw: Record<string, unknown>, nam: Nam): Promise<unknown> {
    if (kind === 'class') {
        return classView(raw);
    }
    if (kind === 'method') {
        return methodView(raw, nam);
    }
    if (kind === 'contract') {
        return contractView(raw, nam);
    }
    return raw;
}

async function summaries(kind: Kind, nam: Nam): Promise<unknown[]> {
    const raws = await nam.listRaw(kind);
    if (kind === 'class') {
        return raws.map(raw => ({ id: raw.id, name: raw.nidsDisplayName, javaClass: raw.nidsAuthJavaClassName }));
    }
    if (kind === 'method') {
        const classes = await nam.refs('class');
        return raws.map(raw => ({ id: raw.id, name: raw.nidsDisplayName, class: classes.find(c => c.id === raw.nidsAuthClassCN)?.name ?? raw.nidsAuthClassCN }));
    }
    if (kind === 'contract') {
        return raws.map(raw => ({ id: raw.id, name: raw.nidsDisplayName, uri: raw.nidsBaseURL, cardId: raw.nidsCardID }));
    }
    return raws.map(raw => ({ id: raw.id, name: raw.nidsDisplayName ?? raw.displayName ?? raw.name }));
}

/** create / update / delete for the three configuration kinds */
async function write(kind: 'class' | 'method' | 'contract', mode: 'create' | 'update', context: Context): Promise<unknown> {
    const nam = context.nam();
    const ref = mode === 'update' ? one(context, kindLabel(kind)) : undefined;
    const found = ref ? await nam.resolve(kind, ref) : undefined;
    const existing = found ? await nam.getRaw(kind, found.id) : undefined;
    const name = str(context, 'name') ?? (existing?.nidsDisplayName as string | undefined);
    if (!name) {
        throw usage('--name is required');
    }
    if (mode === 'create' && (await nam.find(kind, name))) {
        throw new CliError('REJECTED', `A ${kindLabel(kind)} called "${name}" already exists; use update`);
    }
    const change = propertyChange(context);
    const props = properties(context);
    let body: Record<string, unknown>;
    if (kind === 'class') {
        body = classBody({ name, javaClass: str(context, 'java-class') ?? '', typeId: int(context, 'type-id'), properties: props }, existing, change);
    } else if (kind === 'method') {
        const identifies = flag(context, 'identifies-user') ? true : flag(context, 'no-identifies-user') ? false : undefined;
        const stores = list(context, 'userstore');
        body = await methodBody({ name, class: str(context, 'class') ?? '', userStores: stores.length ? stores : undefined, identifiesUser: identifies, properties: props }, existing, change, nam);
    } else {
        body = await contractBody({
            name,
            uri: str(context, 'uri') ?? '',
            methods: list(context, 'methods'),
            cardId: str(context, 'card-id'),
            cardText: str(context, 'card-text'),
            image: str(context, 'image'),
            timeout: int(context, 'timeout'),
            trustLevel: int(context, 'trust-level'),
            properties: props,
        }, existing, change, nam);
    }
    const diff = changes(existing, body);
    if (flag(context, 'dry-run')) {
        return { dryRun: true, action: mode, kind, name, id: found?.id, changes: diff };
    }
    if (found) {
        await nam.update(kind, found.id, body);
        return { action: Object.keys(diff).length ? 'updated' : 'unchanged', kind, id: found.id, name, changes: diff, next: 'Run amcli update --yes to apply it to the Identity Servers' };
    }
    const created = await nam.create(kind, body);
    return { action: 'created', kind, id: created.id, name, next: 'Run amcli update --yes to apply it to the Identity Servers' };
}

async function remove(kind: Kind, context: Context): Promise<unknown> {
    if (!context.positionals.length) {
        throw usage(`Give the ${kindLabel(kind)} names or IDs to delete`);
    }
    needYes(context, `Deleting ${context.positionals.join(', ')}`);
    const nam = context.nam();
    const targets = [];
    for (const ref of context.positionals) {
        targets.push(await nam.resolve(kind, ref));
    }
    if (flag(context, 'dry-run')) {
        return { dryRun: true, action: 'delete', kind, targets };
    }
    await nam.remove(kind, targets.map(target => target.id));
    return { action: 'deleted', kind, targets };
}

function plural(label: string): string {
    return label.endsWith("s") ? `${label}es` : `${label}s`;
}

/** After sending: the servers pick up AFC files (and restart for --restart ones) only with an Update. */
async function afterSend(c: Context, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    const nam = c.nam();
    if (flag(c, 'update')) {
        return { ...result, update: await runUpdate(nam, { types: ['afc'], wait: true, timeoutSec: int(c, 'timeout') ?? 600, quiet: c.quiet }) };
    }
    const status = await nam.clusterStatus();
    return status.pending?.afc
        ? { ...result, next: 'The servers apply these files, and restart for files that need it, only with an Update: amcli update --type afc --yes --wait' }
        : result;
}

function article(label: string): string {
    return /^[aeiou]/i.test(label) ? 'an' : 'a';
}

function crud(kind: 'class' | 'method' | 'contract', createOptions: Record<string, OptionSpec>, updateOptions: Record<string, OptionSpec>): Command[] {
    const label = kindLabel(kind);
    return [
        { name: `${kind} list`, summary: `List ${plural(label)}`, run: async c => summaries(kind, c.nam()) },
        { name: `${kind} get`, summary: `Show one ${label}`, args: '<name|id>', options: RAW, run: async c => {
            const ref = one(c, label);
            const raw = await c.nam().getRaw(kind, ref);
            return flag(c, 'raw') ? raw : view(kind, raw, c.nam());
        } },
        { name: `${kind} create`, summary: `Create ${article(label)} ${label}`, writes: true, options: { ...createOptions, ...PROPS, ...DRY }, run: c => write(kind, 'create', c) },
        { name: `${kind} update`, summary: `Change ${article(label)} ${label}; properties are merged unless --replace-props`, args: '<name|id>', writes: true, options: { ...updateOptions, ...UPDATE_PROPS, ...DRY }, run: c => write(kind, 'update', c) },
        { name: `${kind} delete`, summary: `Delete ${plural(label)}`, args: '<name|id>...', writes: true, confirm: true, options: { ...YES, ...DRY }, run: c => remove(kind, c) },
    ];
}

const CLASS_OPTIONS: Record<string, OptionSpec> = {
    name: { type: 'string', description: 'Display name' },
    'java-class': { type: 'string', description: 'Fully qualified Java class name' },
    'type-id': { type: 'string', description: 'Console type ID (default 0, a custom class)' },
};
const METHOD_OPTIONS: Record<string, OptionSpec> = {
    name: { type: 'string', description: 'Display name' },
    class: { type: 'string', description: 'Authentication class, by name or ID' },
    userstore: { type: 'string', multiple: true, description: 'User store by name or ID (repeatable, or comma-separated)' },
    'identifies-user': { type: 'boolean', description: 'Turn on Identifies User (the default for new methods)' },
    'no-identifies-user': { type: 'boolean', description: 'Turn off Identifies User' },
};
const CONTRACT_OPTIONS: Record<string, OptionSpec> = {
    name: { type: 'string', description: 'Display name' },
    uri: { type: 'string', description: 'Contract URI, e.g. /passkey/login' },
    methods: { type: 'string', multiple: true, description: 'Methods in order, by name or ID (repeatable, or comma-separated)' },
    'card-id': { type: 'string', description: 'Authentication card ID, as in main.jsp?id= (default: the name)' },
    'card-text': { type: 'string', description: 'Card text (default: the name)' },
    image: { type: 'string', description: 'Card image (default AAFIDOU2F)' },
    timeout: { type: 'string', description: 'Activity timeout in minutes (default 60)' },
    'trust-level': { type: 'string', description: 'Trust level' },
};

export const COMMANDS: Command[] = [
    {
        name: 'describe', summary: 'Everything this CLI can do, as JSON: commands, options, settings and exit codes', offline: true,
        plain: true,
        run: async () => describe(),
    },
    {
        name: 'ping', summary: 'Check the URL and credentials; lists the Identity Server clusters',
        run: async c => {
            const nam = c.nam();
            return { ok: true, url: nam.client.baseUrl, user: nam.client.user, idpClusters: await nam.idpClusters() };
        },
    },
    { name: 'clusters', summary: 'List Identity Server clusters', run: async c => c.nam().idpClusters() },
    {
        name: 'status', summary: 'Update and health status of the cluster\'s servers, and what an Update would apply',
        run: async c => c.nam().clusterStatus(),
    },
    {
        name: 'update', summary: 'Apply saved changes to the Identity Servers (the console\'s Update); may interrupt service',
        writes: true, confirm: true,
        options: {
            type: { type: 'string', multiple: true, description: `What to update: ${UPDATE_TYPES.join(', ')} (default all)` },
            wait: { type: 'boolean', description: 'Wait until every server reports CURRENT' },
            timeout: { type: 'string', description: 'Seconds to wait with --wait (default 600)' },
            ...YES, ...DRY,
        },
        run: async c => {
            needYes(c, 'Updating the Identity Servers');
            const types = list(c, 'type');
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'update', types: types.length ? types : ['all'], status: await c.nam().clusterStatus() };
            }
            return runUpdate(c.nam(), { types: types.length ? types : ['all'], wait: flag(c, 'wait'), timeoutSec: int(c, 'timeout') ?? 600, quiet: c.quiet });
        },
    },
    ...crud('class', CLASS_OPTIONS, CLASS_OPTIONS),
    ...crud('method', METHOD_OPTIONS, METHOD_OPTIONS),
    ...crud('contract', CONTRACT_OPTIONS, CONTRACT_OPTIONS),
    { name: 'userstore list', summary: 'List user stores', run: async c => summaries('userstore', c.nam()) },
    { name: 'userstore get', summary: 'Show one user store', args: '<name|id>', run: async c => {
        const ref = one(c, 'user store');
        return c.nam().getRaw('userstore', ref);
    } },
    { name: 'afc list', summary: 'Files the Advanced File Configurator keeps for the cluster, and whether each reached the servers', run: async c => afc.listFiles(c.nam()) },
    {
        name: 'afc upload', summary: 'Upload a file to the Advanced File Configurator (saved in the console; afc send copies it to the servers)', args: '<local-file>',
        writes: true,
        options: {
            dir: { type: 'string', description: 'Folder on the servers, e.g. /opt/novell/nids/lib/webapp/jsp' },
            name: { type: 'string', description: 'File name on the servers (default: the local name)' },
            description: { type: 'string', description: 'Description shown in the console' },
            type: { type: 'string', multiple: true, description: 'Modification type shown in the console, e.g. Localization (repeatable)' },
            restart: { type: 'boolean', description: 'Mark the file as needing a server restart' },
            send: { type: 'boolean', description: 'Then send it to the servers (needs --yes)' },
            wait: { type: 'boolean', description: 'With --send, wait until every server has it' },
            update: { type: 'boolean', description: 'With --send, then run the Update that applies AFC files, restarting the servers for files that need it, and wait for it' },
            ...YES, ...DRY,
        },
        run: async c => {
            const local = one(c, 'local file');
            const dir = str(c, 'dir');
            if (!dir) {
                throw usage('afc upload needs --dir, the folder on the servers');
            }
            if (flag(c, 'send')) {
                needYes(c, 'Sending files to the Identity Servers');
            }
            const nam = c.nam();
            const details = await afc.uploadDetails(nam, local, { dir, name: str(c, 'name'), description: str(c, 'description'), types: list(c, 'type'), restart: flag(c, 'restart') || undefined });
            const replaces = (await afc.listFiles(nam)).some(file => file.fullName === `${details.path}${details.name}`);
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: replaces ? 'replace' : 'upload', fileDetails: details, send: flag(c, 'send') };
            }
            const uploaded = await afc.upload(nam, local, details);
            if (!flag(c, 'send')) {
                return { action: replaces ? 'replaced' : 'uploaded', file: uploaded, next: `Run amcli afc send ${uploaded.fullName} --yes to copy it to the servers` };
            }
            const [sent] = await afc.send(nam, [uploaded.fullName], { restart: false, wait: flag(c, 'wait') || flag(c, 'update'), timeoutSec: 300, quiet: c.quiet });
            return afterSend(c, { action: replaces ? 'replaced and sent' : 'uploaded and sent', file: sent });
        },
    },
    {
        name: 'afc send', summary: 'Send Advanced File Configurator files to the cluster\'s servers', args: '<path>...',
        writes: true, confirm: true,
        options: {
            restart: { type: 'boolean', description: 'The console\'s "restart straight away"; the restart itself still comes with the Update (see --update)' },
            wait: { type: 'boolean', description: 'Wait until every server has the files' },
            update: { type: 'boolean', description: 'Then run the Update that applies AFC files, restarting the servers for files that need it, and wait for it' },
            timeout: { type: 'string', description: 'Seconds to wait with --wait (default 300) or --update (default 600)' },
            ...YES, ...DRY,
        },
        run: async c => {
            if (!c.positionals.length) {
                throw usage('Give the files to send, by full path on the servers');
            }
            needYes(c, 'Sending files to the Identity Servers');
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'send', files: c.positionals, restart: flag(c, 'restart') };
            }
            const files = await afc.send(c.nam(), c.positionals, { restart: flag(c, 'restart'), wait: flag(c, 'wait') || flag(c, 'update'), timeoutSec: int(c, 'timeout') ?? 300, quiet: c.quiet });
            return afterSend(c, { action: 'sent', files });
        },
    },
    {
        name: 'afc get', summary: 'Download a file the Advanced File Configurator keeps', args: '<path>',
        options: { output: { type: 'string', short: 'o', description: 'Where to save it (default: print it, if it\'s text)' } },
        run: async c => {
            const name = one(c, 'file');
            const { file, content } = await afc.download(c.nam(), name);
            const output = str(c, 'output');
            if (output) {
                fs.writeFileSync(output, content);
                return { saved: output, bytes: content.length, file: file.fullName };
            }
            if (content.includes(0)) {
                throw usage(`${file.fullName} is binary; save it with --output`);
            }
            return { file: file.fullName, bytes: content.length, content: content.toString('utf8') };
        },
    },
    {
        name: 'afc fetch', summary: 'Fetch a file straight from a server, any file, tracked or not, to edit and post back with afc upload', args: '<path>',
        options: {
            output: { type: 'string', short: 'o', description: 'Where to save it (default: print it, if it\'s text)' },
            version: { type: 'string', description: 'current (default), or first or last: the copy kept before AFC first or last changed it' },
            server: { type: 'string', description: 'Which server, by IP or device ID (default: the cluster\'s first)' },
        },
        run: async c => {
            const name = one(c, 'file');
            const { server, content } = await afc.fetchFromServer(c.nam(), name, { version: str(c, 'version') ?? 'current', server: str(c, 'server') });
            const output = str(c, 'output');
            if (output) {
                fs.writeFileSync(output, content);
                return { saved: output, bytes: content.length, file: name, server, next: `After editing: amcli afc upload ${output} --dir ${name.slice(0, name.lastIndexOf('/'))}${output.endsWith(name.slice(name.lastIndexOf('/') + 1)) ? '' : ` --name ${name.slice(name.lastIndexOf('/') + 1)}`} --send --yes` };
            }
            if (content.includes(0)) {
                throw usage(`${name} is binary; save it with --output`);
            }
            return { file: name, server, bytes: content.length, content: content.toString('utf8') };
        },
    },
    {
        name: 'afc remove', summary: 'Remove files from the servers too: custom files are deleted, product files go back to their original version (the console\'s Remove Configuration)', args: '<path>...',
        writes: true, confirm: true,
        options: {
            restart: { type: 'boolean', description: 'Restart the servers straight away if a file needs it' },
            wait: { type: 'boolean', description: 'Wait until the console has removed them' },
            timeout: { type: 'string', description: 'Seconds to wait with --wait (default 300)' },
            ...YES, ...DRY,
        },
        run: async c => {
            if (!c.positionals.length) {
                throw usage('Give the files to remove, by full path on the servers');
            }
            needYes(c, `Removing ${c.positionals.join(', ')} from the servers`);
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'remove', files: c.positionals };
            }
            const removed = await afc.remove(c.nam(), c.positionals, { restart: flag(c, 'restart'), wait: flag(c, 'wait'), timeoutSec: int(c, 'timeout') ?? 300, quiet: c.quiet });
            return { action: 'removed', files: removed.map(file => file.fullName) };
        },
    },
    {
        name: 'afc untrack', summary: 'Stop managing files in the Advanced File Configurator; the servers keep their copies (the console\'s Untrack Configurations)', args: '<path>...',
        writes: true, confirm: true, options: { ...YES, ...DRY },
        run: async c => {
            if (!c.positionals.length) {
                throw usage('Give the files to untrack, by full path on the servers');
            }
            needYes(c, `Untracking ${c.positionals.join(', ')}`);
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'untrack', files: c.positionals };
            }
            return { action: 'untracked', files: (await afc.untrack(c.nam(), c.positionals)).map(file => file.fullName), note: 'The servers still have these files' };
        },
    },
    {
        name: 'apply', summary: 'Create or update the classes, methods and contracts in a JSON file, and delete the ones under "remove"; --delete removes everything it lists',
        writes: true,
        options: {
            file: { type: 'string', short: 'f', description: 'The JSON file, or - for stdin' },
            delete: { type: 'boolean', description: 'Delete what the file lists instead (contracts, then methods, then classes)' },
            backup: { type: 'string', description: 'Write an apply file that undoes this one (old values back, created objects removed); it may hold secrets and is written 0600' },
            ...YES, ...DRY,
        },
        run: async c => {
            const path = str(c, 'file');
            if (!path) {
                throw usage('apply needs --file');
            }
            const file = readApplyFile(path);
            const backupFile = str(c, 'backup');
            if (backupFile && fs.existsSync(backupFile) && !flag(c, 'dry-run')) {
                throw new CliError('REJECTED', `${backupFile} already exists: apply it to undo the earlier run first, or remove it`);
            }
            const nam = c.nam();
            const items = await plan(nam, file, flag(c, 'delete'));
            if (flag(c, 'dry-run')) {
                return { dryRun: true, plan: items };
            }
            if (items.some(item => item.action === 'delete')) {
                needYes(c, `Deleting ${items.filter(item => item.action === 'delete').map(item => `${item.kind} ${item.name}`).join(', ')}`);
            }
            const backup = backupFile ? new Backup() : undefined;
            let done: Awaited<ReturnType<typeof execute>>;
            try {
                done = await execute(nam, file, items, backup);
            } finally {
                // Even after a failure part-way, keep what's needed to undo the part that was done
                backup?.write(backupFile!);
            }
            const changed = done.some(item => item.action !== 'unchanged' && item.action !== 'absent');
            return { applied: done, backup: backupFile, next: changed ? 'Run amcli update --yes to apply it to the Identity Servers' : undefined };
        },
    },
    {
        name: 'export', summary: 'Save every configuration read the console\'s APIs offer into a folder, for backup and reference',
        options: {
            out: { type: 'string', short: 'o', description: 'A new or empty folder to write into' },
            api: { type: 'string', multiple: true, description: 'Which APIs: nps (the current one), amsvc (the older one, which adds Access Gateway, policies and SAML), or both (default)' },
            runtime: { type: 'boolean', description: 'Also save runtime state: health, alerts, statistics, command logs' },
            'afc-files': { type: 'boolean', description: 'Also save the files the Advanced File Configurator keeps' },
        },
        run: async c => {
            const out = str(c, 'out');
            if (!out) {
                throw usage('export needs --out, a new or empty folder');
            }
            const apis = list(c, 'api');
            for (const api of apis) {
                if (api !== 'nps' && api !== 'amsvc') {
                    throw usage(`--api is nps or amsvc, not ${api}`);
                }
            }
            return runExport(c.nam(), {
                out,
                apis: (apis.length ? apis : ['nps', 'amsvc']) as ('nps' | 'amsvc')[],
                runtime: flag(c, 'runtime'),
                afcFiles: flag(c, 'afc-files'),
                revealSecrets: flag(c, 'reveal-secrets'),
                quiet: c.quiet,
            });
        },
    },
    {
        name: 'backup', summary: 'For a schedule: export into a new dated folder, compare with the last backup, check certificates, and keep the newest --keep', args: '<folder>',
        options: {
            keep: { type: 'string', description: 'How many backups to keep, newest first (default 30)' },
            expiring: { type: 'string', description: 'Report certificates expiring within this many days, expired ones included (default 30)' },
            'ignore-cert': { type: 'string', multiple: true, description: 'A certificate not to report, such as an expired one nothing uses (repeatable)' },
            api: { type: 'string', multiple: true, description: 'Which APIs: nps, amsvc, or both (default)' },
            'afc-files': { type: 'boolean', description: 'Also save the files the Advanced File Configurator keeps' },
            'exit-code': { type: 'boolean', description: 'Exit with 9 if the configuration changed since the last backup or a certificate is expiring, as for alerts' },
        },
        run: async c => {
            const [root, ...rest] = c.positionals;
            if (!root || rest.length) {
                throw usage('backup takes one folder, which holds the dated backups');
            }
            const keep = int(c, 'keep') ?? 30;
            const expiringDays = int(c, 'expiring') ?? 30;
            if (keep < 1 || expiringDays < 0) {
                throw usage('--keep must be at least 1 and --expiring at least 0');
            }
            const apis = list(c, 'api');
            for (const api of apis) {
                if (api !== 'nps' && api !== 'amsvc') {
                    throw usage(`--api is nps or amsvc, not ${api}`);
                }
            }
            const { result, alert } = await runBackup(c.nam(), {
                root, keep, expiringDays,
                ignoreCerts: list(c, 'ignore-cert'),
                apis: (apis.length ? apis : ['nps', 'amsvc']) as ('nps' | 'amsvc')[],
                afcFiles: flag(c, 'afc-files'),
                revealSecrets: flag(c, 'reveal-secrets'),
                quiet: c.quiet,
            });
            if (flag(c, 'exit-code') && alert) {
                process.exitCode = EXIT.DIFFERENT;
            }
            return result;
        },
    },
    {
        name: 'diff', summary: 'Compare two exports, or an export with the console as it is now (--live)', args: '<export> [<export>]',
        options: {
            live: { type: 'boolean', description: 'Compare the export with a fresh export of the console' },
            save: { type: 'string', description: 'With --live, keep the fresh export in this new folder (default: delete it)' },
            only: { type: 'string', multiple: true, description: 'Only files under this path in the exports, e.g. apply or nps/api/v1/clusters (repeatable)' },
            ignore: { type: 'string', multiple: true, description: 'A key whose changes don\'t count, e.g. modified (repeatable)' },
            summary: { type: 'boolean', description: 'Only the counts and the lists of files, without each change' },
            'include-status': { type: 'boolean', description: 'Also count status changes: pending Updates, health' },
            'exit-code': { type: 'boolean', description: 'Exit with 9 when they differ, as for monitoring' },
        },
        run: async c => {
            const [a, b, ...rest] = c.positionals;
            if (!a || rest.length || (flag(c, 'live') ? b : !b)) {
                throw usage('diff takes two export folders, or one with --live');
            }
            let other = b;
            let temporary: string | undefined;
            if (flag(c, 'live')) {
                other = str(c, 'save') ?? fs.mkdtempSync(`${os.tmpdir()}/amcli-live-`);
                temporary = str(c, 'save') ? undefined : other;
                if (temporary) {
                    fs.rmSync(temporary, { recursive: true, force: true });
                }
                progress(`Exporting the console as it is now, to compare with ${a}`, c.quiet);
                await runExport(c.nam(), { out: other, apis: exportedApis(a), runtime: false, afcFiles: fs.existsSync(`${a}/afc`), revealSecrets: false, quiet: true });
            }
            try {
                const result = diffExports(a, other!, { only: list(c, 'only'), ignore: list(c, 'ignore'), includeStatus: flag(c, 'include-status') });
                if (flag(c, 'exit-code') && !result.summary.same) {
                    process.exitCode = EXIT.DIFFERENT;
                }
                const shown = { ...result, b: temporary ? 'the console now' : result.b };
                return flag(c, 'summary') ? { a: shown.a, b: shown.b, summary: shown.summary, onlyInA: shown.onlyInA, onlyInB: shown.onlyInB, changedFiles: shown.changed.map(f => f.file) } : shown;
            } finally {
                if (temporary) {
                    fs.rmSync(temporary, { recursive: true, force: true });
                }
            }
        },
    },
    {
        name: 'certs list', summary: 'The console\'s certificates and trusted roots, soonest to expire first, with the days each has left',
        options: {
            expired: { type: 'boolean', description: 'Only expired ones' },
            expiring: { type: 'string', description: 'Only ones expiring within this many days (expired ones included)' },
            'trusted-roots': { type: 'boolean', description: 'Only trusted roots' },
            fail: { type: 'boolean', description: 'Exit with 9 if any are listed, as for monitoring' },
        },
        run: async c => {
            const within = int(c, 'expiring');
            let certs = await listCerts(c.nam().client);
            if (flag(c, 'expired')) {
                certs = certs.filter(cert => cert.expired);
            }
            if (within !== undefined) {
                certs = certs.filter(cert => cert.daysLeft !== undefined && cert.daysLeft <= within);
            }
            if (flag(c, 'trusted-roots')) {
                certs = certs.filter(cert => cert.trustedRoot);
            }
            if (flag(c, 'fail') && certs.length) {
                process.exitCode = EXIT.DIFFERENT;
            }
            return certs;
        },
    },
    {
        name: 'certs get', summary: 'One certificate; a trusted root comes with its PEM', args: '<name>',
        options: { output: { type: 'string', short: 'o', description: 'Save a trusted root\'s PEM to this file' } },
        run: async c => {
            const name = one(c, 'certificate');
            const cert = await getCert(c.nam().client, name);
            const output = str(c, 'output');
            if (output) {
                if (!cert.pem) {
                    throw usage(`${cert.name} isn't a trusted root; the API only returns trusted roots' PEM`);
                }
                fs.writeFileSync(output, cert.pem);
                return { ...cert, pem: undefined, saved: output };
            }
            return cert;
        },
    },
    { name: 'saml list', summary: 'SAML 2 service providers and identity providers the cluster trusts', run: async c => saml.listProviders(c.nam()) },
    {
        name: 'saml get', summary: 'One SAML provider\'s settings, with the contracts it uses by name', args: '<name|id|entityID>',
        options: { type: { type: 'string', description: 'sp or idp, when a name is used by both' }, ...RAW },
        run: async c => {
            const ref = one(c, 'SAML provider');
            const type = str(c, 'type') as saml.ProviderType | undefined;
            const nam = c.nam();
            const { provider, detail } = await saml.getProvider(nam, ref, type);
            if (flag(c, 'raw')) {
                return detail;
            }
            const contracts = await nam.names('contract', saml.contractRefs(detail));
            const { nidsTrustedProviderMetadata: _metadata, ...settings } = detail;
            return { ...provider, contracts, settings, metadata: 'amcli saml metadata ' + JSON.stringify(provider.name) };
        },
    },
    {
        name: 'saml metadata', summary: 'A SAML provider\'s metadata, as XML', args: '<name|id|entityID>',
        options: { type: { type: 'string', description: 'sp or idp, when a name is used by both' }, output: { type: 'string', short: 'o', description: 'Save it to this file' } },
        run: async c => {
            const ref = one(c, 'SAML provider');
            const { provider, detail } = await saml.getProvider(c.nam(), ref, str(c, 'type') as saml.ProviderType | undefined);
            const xml = saml.metadataOf(detail);
            if (!xml) {
                throw new CliError('NOT_FOUND', `${provider.name} has no stored metadata`);
            }
            const output = str(c, 'output');
            if (output) {
                fs.writeFileSync(output, xml);
                return { provider: provider.name, entityId: provider.entityId, saved: output, bytes: Buffer.byteLength(xml) };
            }
            return { provider: provider.name, entityId: provider.entityId, metadata: xml };
        },
    },
    {
        name: 'saml create-sp', summary: 'Trust a new SAML service provider, from its metadata', writes: true,
        options: {
            name: { type: 'string', description: 'Display name' },
            metadata: { type: 'string', description: 'Its metadata, as a file' },
            'metadata-url': { type: 'string', description: 'Or the URL the console reads it from' },
            ...DRY,
        },
        run: async c => {
            const name = str(c, 'name');
            if (!name) {
                throw usage('saml create-sp needs --name');
            }
            const source = { file: str(c, 'metadata'), url: str(c, 'metadata-url') };
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'create', kind: 'SAML service provider', name, metadata: source.file ?? source.url };
            }
            const provider = await saml.createServiceProvider(c.nam(), name, source);
            return { action: 'created', provider, next: 'Run amcli update --yes to apply it to the Identity Servers' };
        },
    },
    {
        name: 'saml delete', summary: 'Stop trusting SAML providers', args: '<name|id|entityID>...',
        writes: true, confirm: true, options: { type: { type: 'string', description: 'sp or idp, when a name is used by both' }, ...YES, ...DRY },
        run: async c => {
            if (!c.positionals.length) {
                throw usage('Give the SAML providers to delete');
            }
            needYes(c, `Deleting ${c.positionals.join(', ')}`);
            const nam = c.nam();
            const providers = [];
            for (const ref of c.positionals) {
                providers.push(await saml.findProvider(nam, ref, str(c, 'type') as saml.ProviderType | undefined));
            }
            if (flag(c, 'dry-run')) {
                return { dryRun: true, action: 'delete', providers };
            }
            await saml.deleteProviders(nam, providers);
            return { action: 'deleted', providers, next: 'Run amcli update --yes to apply it to the Identity Servers' };
        },
    },
    { name: 'saml attribute-maps', summary: 'The shared SAML attribute maps', run: async c => saml.attributeMaps(c.nam()) },
    {
        name: 'report', summary: 'What uses what: contracts, methods, classes, user stores, SAML providers and Access Gateway resources, and what nothing refers to', args: '[<export>]',
        options: {
            ag: { type: 'boolean', description: 'Include Access Gateway protected resources, from a Code Promotion export the console makes and amcli deletes again' },
            markdown: { type: 'string', description: 'Also write the report as Markdown tables to this file' },
        },
        run: async c => {
            const [given, ...rest] = c.positionals;
            if (rest.length) {
                throw usage('report takes at most one export folder');
            }
            let folder = given;
            let temporary: string | undefined;
            if (!folder) {
                temporary = fs.mkdtempSync(`${os.tmpdir()}/amcli-report-`);
                fs.rmSync(temporary, { recursive: true, force: true });
                folder = temporary;
                progress('Exporting the console to report on it', c.quiet);
                await runExport(c.nam(), { out: folder, apis: ['nps', 'amsvc'], runtime: false, afcFiles: false, revealSecrets: false, quiet: true });
            }
            try {
                let ag: Map<string, string> | undefined;
                if (flag(c, 'ag')) {
                    progress('Reading the Access Gateway configuration through Code Promotion', c.quiet);
                    ag = await accessGatewayConfigs(c.nam().client);
                }
                const report = buildReport(folder, ag);
                const shown = temporary ? { ...report, source: 'the console now' } : report;
                const markdown = str(c, 'markdown');
                if (markdown) {
                    fs.writeFileSync(markdown, toMarkdown(shown));
                }
                return markdown ? { ...shown, markdown } : shown;
            } finally {
                if (temporary) {
                    fs.rmSync(temporary, { recursive: true, force: true });
                }
            }
        },
    },
    {
        name: 'mcp', summary: 'Run as a Model Context Protocol server on stdio, with every command as a tool, for AI agents', stdio: true,
        options: {
            'read-only': { type: 'boolean', description: 'Only offer the tools that don\'t change the console' },
        },
        run: async c => {
            const { serve } = await import('./mcp.ts');
            await serve({ readOnly: flag(c, 'read-only'), revealSecrets: flag(c, 'reveal-secrets'), config: c.config ?? {} });
            return undefined;
        },
    },
    {
        name: 'api ops', summary: 'List the console API\'s operations from its OpenAPI description',
        options: {
            tag: { type: 'string', description: 'Only operations with this tag (group)' },
            search: { type: 'string', description: 'Only operations whose path or summary contains this text' },
        },
        run: async c => apiOps(c),
    },
    {
        name: 'api', summary: 'Call any console API operation; output is redacted like the rest', args: '<METHOD> <path>',
        writes: true,
        options: {
            data: { type: 'string', description: 'JSON request body, or @file' },
            ...YES, ...DRY,
        },
        run: async c => {
            const [method, path, ...rest] = c.positionals;
            if (!method || !path || rest.length) {
                throw usage('api takes <METHOD> <path>, e.g. amcli api GET /api/v1/clusters/list');
            }
            const verb = method.toUpperCase() as Method;
            if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(verb)) {
                throw usage(`Unknown method ${method}`);
            }
            const data = str(c, 'data');
            const body = data === undefined ? undefined : JSON.parse(data.startsWith('@') ? fs.readFileSync(data.slice(1), 'utf8') : data);
            if (verb !== 'GET') {
                needYes(c, `${verb} ${path}`);
                if (flag(c, 'dry-run')) {
                    return { dryRun: true, method: verb, path, body };
                }
            }
            return c.nam().client.request(verb, path.startsWith('/api') || path.startsWith('/v3') ? path : `/api/v1/${path.replace(/^\//, '')}`, body);
        },
    },
];

async function apiOps(context: Context): Promise<unknown> {
    const spec = (await context.nam().client.get('/v3/api-docs')) as { paths: Record<string, Record<string, { tags?: string[]; summary?: string; operationId?: string }>> };
    const tag = str(context, 'tag')?.toLowerCase();
    const search = str(context, 'search')?.toLowerCase();
    const out: unknown[] = [];
    for (const [path, operations] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
            const tags = operation.tags ?? [];
            const summary = operation.summary ?? operation.operationId ?? '';
            if (tag && !tags.some(t => t.toLowerCase() === tag)) {
                continue;
            }
            if (search && !`${path} ${summary}`.toLowerCase().includes(search)) {
                continue;
            }
            out.push({ method: method.toUpperCase(), path, tag: tags[0], summary });
        }
    }
    return out;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
    settings: { type: 'string', description: 'Load settings from this env file (or set AMCLI_ENV_FILE)' },
    'env-file': { type: 'string', description: 'Same as --settings. Prefer --settings: Node.js reads --env-file itself and exits with code 9 if the file is missing' },
    url: { type: 'string', description: 'Administration Console URL (or AMCLI_URL)' },
    user: { type: 'string', description: 'Console administrator (or AMCLI_USER; default admin)' },
    cluster: { type: 'string', description: 'Identity Server cluster by name or ID (or AMCLI_CLUSTER)' },
    insecure: { type: 'boolean', description: 'Skip certificate checks (or AMCLI_INSECURE=1); test systems only' },
    'password-stdin': { type: 'boolean', description: 'Read the password from stdin' },
    'reveal-secrets': { type: 'boolean', description: 'Show secret values instead of <redacted>' },
    compact: { type: 'boolean', description: 'One-line JSON output' },
    quiet: { type: 'boolean', short: 'q', description: 'No progress messages on stderr' },
    help: { type: 'boolean', short: 'h', description: 'Help for the command' },
};

export const VERSION = '0.7.0';

export function describe(): unknown {
    return {
        name: 'amcli',
        version: VERSION,
        description: 'Command-line client for the OpenText Access Manager Admin Console API',
        output: 'Results are one JSON document on stdout. Errors are {"error": {"code", "message", ...}} on stderr, with the exit code below. Progress goes to stderr.',
        safety: 'Secret values are shown as <redacted> unless --reveal-secrets. Deletes, updates and raw non-GET calls need --yes; every write takes --dry-run. Changes reach the Identity Servers only after `amcli update --yes`.',
        settings: {
            AMCLI_URL: 'Administration Console URL, e.g. https://ac.example.com:8443',
            AMCLI_USER: 'Console administrator (default admin)',
            AMCLI_LEGACY_USER: 'Its DN, for the older /amsvc/v1 API that export reads (default: AMCLI_USER if a DN, else cn=<AMCLI_USER>,o=novell)',
            AMCLI_PASSWORD: 'Its password (never accepted as a flag)',
            AMCLI_PASSWORD_FILE: 'File holding the password',
            AMCLI_CA_FILE: 'PEM CA for the console certificate',
            AMCLI_TLS_SERVERNAME: 'Name to check the certificate against, when AMCLI_URL uses an address',
            AMCLI_INSECURE: '1 to skip certificate checks (test systems only)',
            AMCLI_CLUSTER: 'Default Identity Server cluster',
            AMCLI_TIMEOUT_MS: 'Per-request timeout (default 60000)',
            AMCLI_ENV_FILE: 'Env file to load these from',
        },
        exitCodes: { 0: 'ok', 1: 'error', 2: 'usage', 3: 'not found', 4: 'authentication', 5: 'rejected by the console', 6: 'connection', 7: 'timeout', 8: 'needs --yes', 9: 'not an error: something was found (diff --exit-code, certs list --fail, backup --exit-code)' },
        globalOptions: GLOBAL_OPTIONS,
        commands: COMMANDS.map(command => ({
            command: command.name,
            summary: command.summary,
            args: command.args,
            writes: command.writes ?? false,
            needsYes: command.confirm ?? false,
            options: command.options ?? {},
        })),
    };
}
