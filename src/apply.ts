import fs from 'node:fs';
import { CliError, usage } from './errors.ts';
import { changes, classBody, contractBody, methodBody } from './model.ts';
import type { ClassSpec, ContractSpec, MethodSpec, PropertyChange } from './model.ts';
import type { Kind, Nam } from './nam.ts';

/**
 * A configuration file: the classes, methods and contracts that should exist, by display name.
 * `apply` creates what's missing and updates what differs; with --delete it removes them instead,
 * contracts first. Properties are merged into what's there unless replaceProperties is true.
 * A value of the form ${env:NAME} is read from the environment, so secrets stay out of the file.
 */
export interface ApplyFile {
    cluster?: string;
    replaceProperties?: boolean;
    classes?: ClassSpec[];
    methods?: MethodSpec[];
    contracts?: ContractSpec[];
}

export interface PlanItem {
    action: 'create' | 'update' | 'unchanged' | 'delete' | 'absent';
    kind: Kind;
    name: string;
    id?: string;
    changes?: Record<string, unknown>;
}

type Raw = Record<string, unknown>;

export function readApplyFile(path: string): ApplyFile {
    let text: string;
    try {
        text = fs.readFileSync(path === '-' ? 0 : path, 'utf8');
    } catch (error) {
        throw usage(`Can't read ${path}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw usage(`${path} isn't valid JSON: ${(error as Error).message}`);
    }
    return validate(substituteEnv(parsed) as ApplyFile, path);
}

export function substituteEnv(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
            const found = process.env[name];
            if (found === undefined) {
                throw usage(`The file refers to \${env:${name}}, which isn't set`);
            }
            return found;
        });
    }
    if (Array.isArray(value)) {
        return value.map(substituteEnv);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, substituteEnv(inner)]));
    }
    return value;
}

function validate(file: ApplyFile, path: string): ApplyFile {
    if (!file || typeof file !== 'object') {
        throw usage(`${path} must hold a JSON object`);
    }
    const check = (list: unknown, kind: string, required: string[]) => {
        if (list === undefined) {
            return;
        }
        if (!Array.isArray(list)) {
            throw usage(`${path}: "${kind}" must be a list`);
        }
        list.forEach((item, index) => {
            for (const field of required) {
                if (!item || item[field] === undefined || item[field] === '') {
                    throw usage(`${path}: ${kind}[${index}] needs "${field}"`);
                }
            }
        });
    };
    check(file.classes, 'classes', ['name']);
    check(file.methods, 'methods', ['name']);
    check(file.contracts, 'contracts', ['name']);
    return file;
}

/** Works out what apply would do, without changing anything. */
export async function plan(nam: Nam, file: ApplyFile, remove: boolean): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    if (remove) {
        for (const [kind, list] of [['contract', file.contracts], ['method', file.methods], ['class', file.classes]] as const) {
            for (const spec of list ?? []) {
                const found = await nam.find(kind, spec.name);
                items.push(found ? { action: 'delete', kind, name: spec.name, id: found.id } : { action: 'absent', kind, name: spec.name });
            }
        }
        return items;
    }
    const change: PropertyChange = { replace: file.replaceProperties };
    const creating = new Set<string>();
    for (const spec of file.classes ?? []) {
        items.push(await planOne(nam, 'class', spec.name, existing => Promise.resolve(classBody(spec, existing, change)), creating));
    }
    for (const spec of file.methods ?? []) {
        items.push(await planOne(nam, 'method', spec.name, existing => methodBody(spec, existing, change, nam), creating, spec));
    }
    for (const spec of file.contracts ?? []) {
        items.push(await planOne(nam, 'contract', spec.name, existing => contractBody(spec, existing, change, nam), creating, spec));
    }
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

/** Carries out a plan: classes, then methods, then contracts; deletions in the plan's own order. */
export async function execute(nam: Nam, file: ApplyFile, items: PlanItem[]): Promise<PlanItem[]> {
    const change: PropertyChange = { replace: file.replaceProperties };
    const done: PlanItem[] = [];
    for (const item of items) {
        if (item.action === 'unchanged' || item.action === 'absent') {
            done.push(item);
            continue;
        }
        if (item.action === 'delete') {
            await nam.remove(item.kind, [item.id!]);
            done.push(item);
            continue;
        }
        const existing = item.id ? await nam.getRaw(item.kind, item.id) : undefined;
        let body: Raw;
        if (item.kind === 'class') {
            body = classBody(file.classes!.find(s => s.name === item.name)!, existing, change);
        } else if (item.kind === 'method') {
            body = await methodBody(file.methods!.find(s => s.name === item.name)!, existing, change, nam);
        } else {
            body = await contractBody(file.contracts!.find(s => s.name === item.name)!, existing, change, nam);
        }
        if (item.id) {
            await nam.update(item.kind, item.id, body);
            done.push(item);
        } else {
            const created = await nam.create(item.kind, body);
            done.push({ ...item, id: created.id });
        }
    }
    return done;
}
