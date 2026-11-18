import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { usage } from './errors.ts';

/**
 * Compares two exports (amcli export folders): which files appear in only one, and within the
 * JSON files that differ, which values changed. Lists are paired by ID or name rather than by
 * position, so a reordered list isn't a change, and each console's own address is replaced with
 * <console>, so exports of different consoles compare.
 */
export type ChangeKind = 'added' | 'removed' | 'changed';

export interface Change {
    path: string;
    kind: ChangeKind;
    from?: unknown;
    to?: unknown;
}

export interface FileDiff {
    file: string;
    changes: Change[];
}

export interface DiffResult {
    a: string;
    b: string;
    summary: { filesOnlyInA: number; filesOnlyInB: number; filesChanged: number; changes: number; same: boolean };
    onlyInA: string[];
    onlyInB: string[];
    changed: FileDiff[];
}

export interface DiffOptions {
    /** Only files under these paths in the export, e.g. apply or nps/api/v1/clusters */
    only?: string[];
    /** Keys whose values never count as a change */
    ignore?: string[];
    /** Count changes in status too (pending Updates, health) */
    includeStatus?: boolean;
}

/** Values that change on every export without anything being configured differently */
const ALWAYS_IGNORED = ['timestamp', 'exported'];
/** Status rather than configuration: whether an Update is pending, how healthy a server is */
const STATUS_KEYS = ['updateStatus', 'healthStatus', 'clusterHealth', 'overallClusterHealth', 'idpClusterHealth', 'agClusterHealth', 'update', 'pending'];
const IDENTITY_KEYS = ['id', 'instanceID', 'instanceId', 'uniqueID', 'clusterId', 'clusterID', 'deviceId', 'deviceID', 'serverId', 'name', 'certName', 'displayName', 'fullName', 'uri'];

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The key that identifies every item of both lists, uniquely, if there is one */
function identityKey(a: unknown[], b: unknown[]): string | undefined {
    const items = [...a, ...b];
    if (!items.length || !items.every(isObject)) {
        return undefined;
    }
    return IDENTITY_KEYS.find(key => {
        const unique = (list: unknown[]) => {
            const values = list.map(item => (item as Raw)[key]);
            return values.every(v => typeof v === 'string' || typeof v === 'number') && new Set(values).size === values.length;
        };
        return unique(a) && unique(b);
    });
}

/**
 * Signed SAML metadata gets a new document ID, digests and signature every time the console makes
 * it, though nothing in it changed; those parts are left out of the comparison
 */
export function normalizeText(value: string): string {
    if (!/EntityDescriptor|EntitiesDescriptor/.test(value)) {
        return value;
    }
    return value
        // Every ID attribute in metadata is generated when it's made
        .replace(/(<[\w:]+\b[^>]*?)\sID="[^"]*"/g, '$1')
        .replace(/<([\w]+:)?(SignatureValue|DigestValue)>[^<]*<\/([\w]+:)?(SignatureValue|DigestValue)>/g, '<$2/>')
        .replace(/(<([\w]+:)?Reference\b[^>]*?)\sURI="[^"]*"/g, '$1');
}

/** For long text, the stretch around the first difference rather than all of it */
function excerpt(a: string, b: string): { from: string; to: string } {
    let i = 0;
    while (i < a.length && a[i] === b[i]) {
        i++;
    }
    const start = Math.max(0, i - 60);
    const cut = (text: string) => `${start ? '…' : ''}${text.slice(start, i + 120)}${i + 120 < text.length ? '…' : ''}`;
    return { from: cut(a), to: cut(b) };
}

function label(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export function diffValues(a: unknown, b: unknown, ignore: Set<string>, at = ''): Change[] {
    if (JSON.stringify(a) === JSON.stringify(b)) {
        return [];
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        const key = identityKey(a, b);
        if (key) {
            const before = new Map(a.map(item => [String((item as Raw)[key]), item]));
            const after = new Map(b.map(item => [String((item as Raw)[key]), item]));
            const changes: Change[] = [];
            for (const [id, item] of before) {
                const where = `${at}[${key}=${id}]`;
                changes.push(...(after.has(id) ? diffValues(item, after.get(id), ignore, where) : [{ path: where, kind: 'removed' as const, from: item }]));
            }
            for (const [id, item] of after) {
                if (!before.has(id)) {
                    changes.push({ path: `${at}[${key}=${id}]`, kind: 'added', to: item });
                }
            }
            return changes;
        }
        if ([...a, ...b].every(v => !isObject(v) && !Array.isArray(v))) {
            // Lists of plain values: compared as sets, since the console doesn't keep their order
            const before = new Set(a.map(label));
            const after = new Set(b.map(label));
            return [
                ...[...before].filter(v => !after.has(v)).map(v => ({ path: at, kind: 'removed' as const, from: v })),
                ...[...after].filter(v => !before.has(v)).map(v => ({ path: at, kind: 'added' as const, to: v })),
            ];
        }
        const changes: Change[] = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const where = `${at}[${i}]`;
            if (i >= a.length) {
                changes.push({ path: where, kind: 'added', to: b[i] });
            } else if (i >= b.length) {
                changes.push({ path: where, kind: 'removed', from: a[i] });
            } else {
                changes.push(...diffValues(a[i], b[i], ignore, where));
            }
        }
        return changes;
    }
    if (isObject(a) && isObject(b)) {
        const changes: Change[] = [];
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (ignore.has(key)) {
                continue;
            }
            const where = at ? `${at}.${key}` : key;
            if (!(key in b)) {
                changes.push({ path: where, kind: 'removed', from: a[key] });
            } else if (!(key in a)) {
                changes.push({ path: where, kind: 'added', to: b[key] });
            } else {
                changes.push(...diffValues(a[key], b[key], ignore, where));
            }
        }
        return changes;
    }
    if (typeof a === 'string' && typeof b === 'string') {
        const left = normalizeText(a);
        const right = normalizeText(b);
        if (left === right) {
            return [];
        }
        if (left.length > 300 || right.length > 300) {
            return [{ path: at, kind: 'changed', ...excerpt(left, right) }];
        }
    }
    return [{ path: at, kind: 'changed', from: a, to: b }];
}

function filesIn(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                out.push(path.relative(root, full).split(path.sep).join('/'));
            }
        }
    };
    walk(root);
    return out;
}

function consoleOrigin(root: string): string | undefined {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Raw;
        return typeof manifest.console === 'string' ? new URL(manifest.console).origin : undefined;
    } catch {
        return undefined;
    }
}

function load(root: string, file: string, origin: string | undefined): { json?: unknown; hash: string } {
    const content = fs.readFileSync(path.join(root, file));
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (!file.endsWith('.json')) {
        return { hash };
    }
    let text = content.toString('utf8');
    if (origin) {
        text = text.split(origin).join('<console>');
    }
    try {
        return { json: JSON.parse(text), hash };
    } catch {
        return { hash };
    }
}

function isExport(root: string): boolean {
    return fs.existsSync(path.join(root, 'manifest.json'));
}

export function diffExports(a: string, b: string, options: DiffOptions = {}): DiffResult {
    for (const root of [a, b]) {
        if (!fs.existsSync(root) || !isExport(root)) {
            throw usage(`${root} isn't an amcli export folder (no manifest.json)`);
        }
    }
    const ignore = new Set([...ALWAYS_IGNORED, ...(options.includeStatus ? [] : STATUS_KEYS), ...(options.ignore ?? [])]);
    const wanted = (file: string) =>
        file !== 'manifest.json'
        && !file.startsWith('_backup/')
        && !file.endsWith('/_api-description.json')
        && (!options.only?.length || options.only.some(prefix => file === prefix || file.startsWith(`${prefix.replace(/\/$/, '')}/`)));
    const filesA = new Set(filesIn(a).filter(wanted));
    const filesB = new Set(filesIn(b).filter(wanted));
    const originA = consoleOrigin(a);
    const originB = consoleOrigin(b);
    const changed: FileDiff[] = [];
    for (const file of [...filesA].filter(f => filesB.has(f)).sort()) {
        const left = load(a, file, originA);
        const right = load(b, file, originB);
        if (left.json !== undefined && right.json !== undefined) {
            const changes = diffValues(left.json, right.json, ignore);
            if (changes.length) {
                changed.push({ file, changes });
            }
        } else if (left.hash !== right.hash) {
            changed.push({ file, changes: [{ path: '', kind: 'changed', from: `sha256 ${left.hash}`, to: `sha256 ${right.hash}` }] });
        }
    }
    const onlyInA = [...filesA].filter(f => !filesB.has(f)).sort();
    const onlyInB = [...filesB].filter(f => !filesA.has(f)).sort();
    const count = changed.reduce((n, f) => n + f.changes.length, 0);
    return {
        a: path.resolve(a),
        b: path.resolve(b),
        summary: {
            filesOnlyInA: onlyInA.length,
            filesOnlyInB: onlyInB.length,
            filesChanged: changed.length,
            changes: count,
            same: !onlyInA.length && !onlyInB.length && !count,
        },
        onlyInA,
        onlyInB,
        changed,
    };
}

/** The APIs an export read, from its manifest, so a live export can read the same */
export function exportedApis(root: string): ('nps' | 'amsvc')[] {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Raw;
        const apis = (['nps', 'amsvc'] as const).filter(api => api in manifest);
        return apis.length ? [...apis] : ['nps', 'amsvc'];
    } catch {
        return ['nps', 'amsvc'];
    }
}
