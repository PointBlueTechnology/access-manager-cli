import fs from 'node:fs';
import path from 'node:path';
import { CliError, usage } from './errors.ts';
import { changes, classBody, classView, contractBody, contractView, methodBody, methodView } from './model.ts';
import type { ClassSpec, ContractSpec, MethodSpec, Properties, PropertyChange } from './model.ts';
import type { Kind, Nam } from './nam.ts';

/**
 * A configuration file: the classes, methods and contracts that should exist, by display name, and
 * optionally ones that should not (`remove`). `apply` creates what's missing, updates what differs
 * and deletes what's listed under `remove`; with --delete it deletes everything the file lists.
 *
 * Properties are merged into what's there, unless replaceProperties is true (for the file or one
 * object); unsetProperties removes named ones. In any string, ${env:NAME} or ${env:NAME:-default}
 * is read from the environment and ${file:path} from a file (relative to the apply file), so
 * secrets and long values such as certificates stay out of it.
 */
export interface Removals {
    contracts?: string[];
    methods?: string[];
    classes?: string[];
}

export interface ApplyFile {
    cluster?: string;
    replaceProperties?: boolean;
    classes?: ClassSpec[];
    methods?: MethodSpec[];
    contracts?: ContractSpec[];
    remove?: Removals;
}

export interface PlanItem {
    action: 'create' | 'update' | 'unchanged' | 'delete' | 'absent';
    kind: Kind;
    name: string;
    id?: string;
    changes?: Record<string, unknown>;
}

type Raw = Record<string, unknown>;
type AnySpec = ClassSpec | MethodSpec | ContractSpec;

const PLURAL: Record<Kind, keyof Removals> = { contract: 'contracts', method: 'methods', class: 'classes', userstore: 'classes' };

export function readApplyFile(file: string): ApplyFile {
    let text: string;
    try {
        text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
        throw usage(`Can't read ${file}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw usage(`${file} isn't valid JSON: ${(error as Error).message}`);
    }
    return validate(substitute(parsed, file === '-' ? process.cwd() : path.dirname(path.resolve(file))) as ApplyFile, file);
}

/** Fills in ${env:NAME}, ${env:NAME:-default} and ${file:path} (relative to baseDir). */
export function substitute(value: unknown, baseDir = process.cwd()): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{(env|file):([^}]*)\}/g, (_, source: string, ref: string) => {
            if (source === 'file') {
                const target = path.resolve(baseDir, ref);
                try {
                    return fs.readFileSync(target, 'utf8').replace(/\r?\n$/, '');
                } catch {
                    throw usage(`The file refers to \${file:${ref}}, which can't be read (${target})`);
                }
            }
            const match = ref.match(/^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s);
            if (!match) {
                throw usage(`\${env:${ref}} isn't a variable reference`);
            }
            const found = process.env[match[1]];
            if (found !== undefined && found !== '') {
                return found;
            }
            if (match[2] !== undefined) {
                return match[2];
            }
            throw usage(`The file refers to \${env:${match[1]}}, which isn't set`);
        });
    }
    if (Array.isArray(value)) {
        return value.map(inner => substitute(inner, baseDir));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, substitute(inner, baseDir)]));
    }
    return value;
}

/** @deprecated kept for callers of 0.1/0.2: same as substitute() */
export const substituteEnv = (value: unknown): unknown => substitute(value);

function validate(file: ApplyFile, name: string): ApplyFile {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw usage(`${name} must hold a JSON object`);
    }
    const check = (list: unknown, kind: string) => {
        if (list === undefined) {
            return;
        }
        if (!Array.isArray(list)) {
            throw usage(`${name}: "${kind}" must be a list`);
        }
        list.forEach((item, index) => {
            if (!item || typeof item.name !== 'string' || item.name === '') {
                throw usage(`${name}: ${kind}[${index}] needs "name"`);
            }
            if (item.unsetProperties !== undefined && !Array.isArray(item.unsetProperties)) {
                throw usage(`${name}: ${kind}[${index}].unsetProperties must be a list of names`);
            }
        });
    };
    check(file.classes, 'classes');
    check(file.methods, 'methods');
    check(file.contracts, 'contracts');
    for (const [key, list] of Object.entries(file.remove ?? {})) {
        if (!['contracts', 'methods', 'classes'].includes(key) || !Array.isArray(list) || list.some(n => typeof n !== 'string')) {
            throw usage(`${name}: "remove" takes contracts, methods and classes, each a list of names`);
        }
    }
    return file;
}

function propertyChange(file: ApplyFile, spec: AnySpec): PropertyChange {
    return { replace: spec.replaceProperties ?? file.replaceProperties, unset: spec.unsetProperties };
}

/** Works out what apply would do, without changing anything. */
export async function plan(nam: Nam, file: ApplyFile, deleteAll: boolean): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    const deletions = async (removals: Removals) => {
        for (const kind of ['contract', 'method', 'class'] as const) {
            for (const name of removals[PLURAL[kind]] ?? []) {
                const found = await nam.find(kind, name);
                items.push(found ? { action: 'delete', kind, name, id: found.id } : { action: 'absent', kind, name });
            }
        }
    };
    if (deleteAll) {
        await deletions({
            contracts: (file.contracts ?? []).map(s => s.name),
            methods: (file.methods ?? []).map(s => s.name),
            classes: (file.classes ?? []).map(s => s.name),
        });
        return items;
    }
    const creating = new Set<string>();
    for (const spec of file.classes ?? []) {
        items.push(await planOne(nam, 'class', spec.name, existing => Promise.resolve(classBody(spec, existing, propertyChange(file, spec))), creating));
    }
    for (const spec of file.methods ?? []) {
        items.push(await planOne(nam, 'method', spec.name, existing => methodBody(spec, existing, propertyChange(file, spec), nam), creating, spec));
    }
    for (const spec of file.contracts ?? []) {
        items.push(await planOne(nam, 'contract', spec.name, existing => contractBody(spec, existing, propertyChange(file, spec), nam), creating, spec));
    }
    await deletions(file.remove ?? {});
    return items;
}

async function planOne(
    nam: Nam,
    kind: Kind,
    name: string,
    build: (existing: Raw | undefined) => Promise<Raw>,
    creating: Set<string>,
    spec?: unknown,
): Promise<PlanItem> {
    const found = await nam.find(kind, name);
    const existing = found ? await nam.getRaw(kind, found.id) : undefined;
    let body: Raw;
    try {
        body = await build(existing);
    } catch (error) {
        // It refers to something this same file creates first: show the file's own terms
        if (error instanceof CliError && error.code === 'NOT_FOUND' && [...creating].some(n => error.message.includes(`"${n.split(':')[1]}"`))) {
            creating.add(`${kind}:${name}`);
            return { action: found ? 'update' : 'create', kind, name, id: found?.id, changes: spec as Record<string, unknown> };
        }
        throw error;
    }
    const diff = changes(existing, body);
    if (!found) {
        creating.add(`${kind}:${name}`);
        return { action: 'create', kind, name, changes: diff };
    }
    return Object.keys(diff).length ? { action: 'update', kind, name, id: found.id, changes: diff } : { action: 'unchanged', kind, name, id: found.id };
}

/**
 * Carries out a plan: classes, then methods, then contracts, then deletions. With a backup, it
 * also builds an apply file that undoes exactly what was done: settings it changed go back to their
 * old values, settings it added are unset, objects it created are removed, objects it deleted come
 * back.
 */
export async function execute(nam: Nam, file: ApplyFile, items: PlanItem[], backup?: Backup): Promise<PlanItem[]> {
    const done: PlanItem[] = [];
    for (const item of items) {
        if (item.action === 'unchanged' || item.action === 'absent') {
            done.push(item);
            continue;
        }
        if (item.action === 'delete') {
            if (backup) {
                await backup.recordDeleted(nam, item.kind, item.id!);
            }
            await nam.remove(item.kind, [item.id!]);
            done.push(item);
            continue;
        }
        const spec = specFor(file, item);
        const existing = item.id ? await nam.getRaw(item.kind, item.id) : undefined;
        const change = propertyChange(file, spec);
        let body: Raw;
        if (item.kind === 'class') {
            body = classBody(spec as ClassSpec, existing, change);
        } else if (item.kind === 'method') {
            body = await methodBody(spec as MethodSpec, existing, change, nam);
        } else {
            body = await contractBody(spec as ContractSpec, existing, change, nam);
        }
        if (item.id) {
            if (backup) {
                await backup.recordUpdated(nam, item.kind, existing!, spec, change);
            }
            await nam.update(item.kind, item.id, body);
            done.push(item);
        } else {
            const created = await nam.create(item.kind, body);
            backup?.recordCreated(item.kind, item.name);
            done.push({ ...item, id: created.id });
        }
    }
    return done;
}

function specFor(file: ApplyFile, item: PlanItem): AnySpec {
    const list = item.kind === 'class' ? file.classes : item.kind === 'method' ? file.methods : file.contracts;
    return list!.find(s => s.name === item.name)!;
}

// Which CLI fields each kind has, besides name and properties
const FIELDS: Record<'class' | 'method' | 'contract', string[]> = {
    class: ['javaClass', 'typeId'],
    method: ['class', 'userStores', 'identifiesUser', 'overwriteRealUser', 'overwriteTempUser'],
    contract: ['uri', 'methods', 'cardId', 'cardText', 'image', 'timeout', 'trustLevel', 'allowProxying'],
};

/** The CLI's shape of an existing object, with names instead of IDs, as an apply file holds it. */
async function specOf(nam: Nam, kind: Kind, raw: Raw): Promise<Raw> {
    const view = kind === 'class' ? classView(raw) : kind === 'method' ? await methodView(raw, nam) : await contractView(raw, nam);
    const named = (value: unknown): unknown =>
        Array.isArray(value) ? value.map(named) : value && typeof value === 'object' && 'name' in value ? (value as Raw).name : value;
    const out: Raw = { name: view.name };
    for (const field of FIELDS[kind as 'class' | 'method' | 'contract']) {
        if (view[field] !== undefined) {
            out[field] = named(view[field]);
        }
    }
    return out;
}

/** Collects the apply file that undoes an apply. It can hold secrets, so it's written as 0600. */
export class Backup {
    readonly restore: ApplyFile & { classes: ClassSpec[]; methods: MethodSpec[]; contracts: ContractSpec[]; remove: Required<Removals> } = {
        classes: [],
        methods: [],
        contracts: [],
        remove: { contracts: [], methods: [], classes: [] },
    };

    private list(kind: Kind): AnySpec[] {
        return kind === 'class' ? this.restore.classes : kind === 'method' ? this.restore.methods : this.restore.contracts;
    }

    recordCreated(kind: Kind, name: string): void {
        this.restore.remove[PLURAL[kind]]!.push(name);
    }

    async recordUpdated(nam: Nam, kind: Kind, before: Raw, spec: AnySpec, change: PropertyChange): Promise<void> {
        const full = await specOf(nam, kind, before);
        const restore: Raw = { name: full.name };
        for (const field of FIELDS[kind as 'class' | 'method' | 'contract']) {
            if ((spec as unknown as Raw)[field] !== undefined && full[field] !== undefined) {
                restore[field] = full[field];
            }
        }
        const old = propertiesOf(kind, before);
        if (change.replace) {
            restore.properties = old;
            restore.replaceProperties = true;
        } else {
            const touched = [...Object.keys(spec.properties ?? {}), ...(change.unset ?? [])];
            const properties: Properties = {};
            const unset: string[] = [];
            for (const key of new Set(touched)) {
                if (key in old) {
                    properties[key] = old[key];
                } else {
                    unset.push(key);
                }
            }
            if (Object.keys(properties).length) {
                restore.properties = properties;
            }
            if (unset.length) {
                restore.unsetProperties = unset;
            }
        }
        this.list(kind).push(restore as unknown as AnySpec);
    }

    async recordDeleted(nam: Nam, kind: Kind, id: string): Promise<void> {
        const raw = await nam.getRaw(kind, id);
        const spec = await specOf(nam, kind, raw);
        this.list(kind).push({ ...spec, properties: propertiesOf(kind, raw), replaceProperties: true } as unknown as AnySpec);
    }

    write(target: string): void {
        fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(this.restore, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
}

function propertiesOf(kind: Kind, raw: Raw): Properties {
    if (kind === 'contract') {
        const out: Properties = {};
        for (const item of (raw.nidsAuthContractProperties as Raw[] | undefined) ?? []) {
            out[String(item.name)] = String(item.value ?? '');
        }
        return out;
    }
    return { ...((raw.nidsAuthClassProperties as Properties | undefined) ?? {}) };
}
