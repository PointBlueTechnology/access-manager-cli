import fs from 'node:fs';
import path from 'node:path';
import * as afc from './afc.ts';
import { propertiesOf, specOf } from './apply.ts';
import { usage } from './errors.ts';
import { Nam } from './nam.ts';
import type { Kind } from './nam.ts';
import { progress } from './output.ts';
import { harmless, isSecretName, redact } from './redact.ts';
import type { Client } from './client.ts';

/**
 * Reads as much of the Administration Console's configuration as its APIs allow, for backup and
 * reference. Both APIs describe themselves (the /nps OpenAPI document and the older /amsvc/v1
 * Swagger document), so every read operation is found from those, and the IDs an operation needs
 * come from the matching list: each class from the class list, each protected resource from its
 * proxy service, and so on. Reads that change something, reach outside the console, return
 * personal data or are binary are never made; runtime state (health, alerts, statistics) only
 * with --runtime.
 */
type Raw = Record<string, unknown>;

interface Param {
    name: string;
    in: string;
    required?: boolean;
    enum?: unknown[];
    schema?: { enum?: unknown[]; $ref?: string };
}

interface Operation {
    summary?: string;
    operationId?: string;
    tags?: string[];
    parameters?: Param[];
}

interface Spec {
    paths: Record<string, Record<string, Operation>>;
    components?: { schemas?: Record<string, { enum?: unknown[] }> };
}

interface ApiDef {
    name: 'nps' | 'amsvc';
    /** What the client puts in front of the spec's paths */
    prefix: string;
    specPath: string;
}

const APIS: ApiDef[] = [
    { name: 'nps', prefix: '', specPath: '/v3/api-docs' },
    { name: 'amsvc', prefix: '/amsvc/v1', specPath: '/amsvc/v1/swagger.json' },
];

/** Reads with side effects, that reach outside the console, or that return binaries */
const NEVER: RegExp[] = [
    /\/health\/update$/, /^\/(login|logout|renew)$/, /^\/api\/v1\/ua\//, /^\/api\/v1\/analytics$/,
    /^\/api\/v1\/codepromotion\/\{/, /^\/api\/v1\/afc\/customfiles\/(files|isDefault)$/, /^\/api\/v1\/icons\//,
    /^\/customizations\//, /\/refresh$/, /^\/apim\/ping$/, /\/connectivity$/, /\/server-tls$/, /^\/icons\/\{iconID\}\.\{iconFormat\}$/,
];
/** Personal data rather than configuration */
const PERSONAL: RegExp[] = [/\/sessions$/, /\/mobileusers$/, /\/ldapgroups\//];
/** Answers that mean a feature isn't set up or licensed on this console, rather than a failure */
const NOT_IN_USE = /SAPIM|licen[cs]e|Account ?Management|not enabled/i;

/** Lookups of what may be put in a policy, rather than configuration */
const REFERENCE: RegExp[] = [/^\/retrievepolicyoptions\//];
/** Runtime state rather than configuration: only with --runtime */
const RUNTIME: RegExp[] = [/\/health$/, /\/alerts$/, /\/statistics$/, /\/commandLogs/, /\/updateStatusEvents$/, /\/auditdata$/, /\/pendingrequests?(\/|$)/];

/** Where an ID comes from when it isn't the list just before it in the path */
interface Source {
    list: string;
    keys: string[];
    where?: (item: Raw) => boolean;
}
const SOURCES: Record<string, Record<string, Source>> = {
    nps: {
        // The Identity Server clusters: /api/v1/clusters on its own lists Access Gateway ones
        clusterId: { list: '/api/v1/clusters/list?servertype=IDP', keys: ['id'] },
        serverId: { list: '/api/v1/clusters', keys: ['deviceId'] },
        // The trusted-provider lists mix protocols; SAML 2 providers are the ST... ones (LT... are Liberty)
        '/api/v1/clusters/{clusterId}/saml2/idp/{providerId}': { list: '/api/v1/clusters/{clusterId}/trustedproviders/idp', keys: ['providerId', 'id'], where: item => String(item.id ?? item.providerId).startsWith('ST') },
        '/api/v1/clusters/{clusterId}/saml2/sp/{providerId}': { list: '/api/v1/clusters/{clusterId}/trustedproviders/sp', keys: ['providerId', 'id'], where: item => String(item.id ?? item.providerId).startsWith('ST') },
        '/api/v1/usermatchingexpr/{usermatchingexprId}': { list: '/api/v1/usermatchingexprs', keys: ['id'] },
    },
    amsvc: {
        trustedRootID: { list: '/security/certificates', keys: ['certName'], where: item => item.isTrustedRoot === true },
    },
};

/** Path values the descriptions only name in prose */
const PATH_VALUES: Record<string, string[]> = {
    metadataType: ['liberty', 'saml1', 'saml2', 'wsfed'],
};

export interface ExportOptions {
    out: string;
    apis: ('nps' | 'amsvc')[];
    runtime: boolean;
    afcFiles: boolean;
    revealSecrets: boolean;
    quiet: boolean;
    concurrency?: number;
}

export interface ManifestEntry {
    api: string;
    template: string;
    summary?: string;
    path?: string;
    file?: string;
    status?: number;
    skipped?: string;
    error?: string;
}

function enumOf(param: Param, spec: Spec): unknown[] | undefined {
    if (param.enum) {
        return param.enum;
    }
    if (param.schema?.enum) {
        return param.schema.enum;
    }
    const ref = param.schema?.$ref?.split('/').pop();
    return ref ? spec.components?.schemas?.[ref]?.enum : undefined;
}

/** The objects in a response's lists, shallowest first, that carry one of the keys */
export function idsFrom(data: unknown, keys: string[], listUrl?: string, where?: (item: Raw) => boolean): string[] {
    let level: unknown[] = [data];
    for (let depth = 0; depth < 6 && level.length; depth++) {
        const found: string[] = [];
        const next: unknown[] = [];
        for (const value of level) {
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item && typeof item === 'object' && !Array.isArray(item)) {
                        const object = item as Raw;
                        if (where && !where(object)) {
                            next.push(item);
                            continue;
                        }
                        const key = keys.find(k => typeof object[k] === 'string' || typeof object[k] === 'number');
                        if (key) {
                            found.push(String(object[key]));
                        } else if (listUrl && typeof object.uri === 'string' && object.uri.includes(`${listUrl}/`)) {
                            found.push(decodeURIComponent(object.uri.split('/').pop()!));
                        }
                    }
                    next.push(item);
                }
            } else if (value && typeof value === 'object') {
                next.push(...Object.values(value));
            }
        }
        if (found.length) {
            return [...new Set(found)];
        }
        level = next;
    }
    return [];
}

function keysFor(param: string): string[] {
    const base = param.replace(/(Id|ID|Cn|Name)$/, '');
    return [param, `${base}Id`, `${base}ID`, 'id', 'instanceID', 'instanceId', 'uniqueID', `${base}Name`, 'name'];
}

function safeSegment(segment: string): string {
    return segment.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
}

/** Blanks secrets unless they're wanted; the files are the only place they'd go */
function protect(value: unknown, reveal: boolean): unknown {
    return reveal ? value : redact(value);
}

class Walker {
    private readonly cache = new Map<string, Promise<{ status: number; body: unknown }>>();
    readonly manifest: ManifestEntry[] = [];
    private readonly client: Client;
    private readonly options: ExportOptions;

    constructor(client: Client, options: ExportOptions) {
        this.client = client;
        this.options = options;
    }

    fetch(path: string): Promise<{ status: number; body: unknown }> {
        let found = this.cache.get(path);
        if (!found) {
            found = this.client.send('GET', path)
                // Some reads answer only in XML, and refuse a request that asks for JSON
                .then(response => (response.status === 406 ? this.client.send('GET', path, undefined, '*/*') : response))
                .catch(error => ({ status: 0, body: { error: (error as Error).message } }));
            this.cache.set(path, found);
        }
        return found;
    }

    write(api: string, path: string, body: unknown): string {
        const [route, query] = path.split('?');
        const segments = route.split('/').filter(Boolean).map(safeSegment);
        const last = segments.pop() ?? 'root';
        const name = `${last}${query ? `__${safeSegment(query)}` : ''}`;
        const json = typeof body !== 'string';
        const relative = path.length ? `${api}/${[...segments, `${name}.${json ? 'json' : 'txt'}`].join('/')}` : `${api}/root.json`;
        const file = `${this.options.out}/${relative}`;
        fs.mkdirSync(`${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true, mode: this.options.revealSecrets ? 0o700 : 0o755 });
        const content = json ? JSON.stringify(protect(body, this.options.revealSecrets), null, 2) + '\n' : String(body);
        fs.writeFileSync(file, content, { mode: this.options.revealSecrets ? 0o600 : 0o644 });
        return relative;
    }

    /** Every concrete path for a template, filling in each ID from its list */
    async expand(api: ApiDef, spec: Spec, template: string, query: string): Promise<{ paths: string[]; problem?: string }> {
        let partials: { done: string; rest: string }[] = [{ done: '', rest: template }];
        const sources = SOURCES[api.name];
        for (;;) {
            const next: { done: string; rest: string }[] = [];
            let pending = false;
            for (const partial of partials) {
                const match = partial.rest.match(/^(.*?)\{([^}]+)\}(.*)$/);
                if (!match) {
                    next.push(partial);
                    continue;
                }
                pending = true;
                const [, before, param, after] = match;
                const prefixTemplate = template.slice(0, template.length - partial.rest.length) + before.replace(/\/$/, '');
                const literal = partial.done + before;
                const enumValues = enumOf(spec.paths[template].get.parameters?.find(p => p.name === param && p.in === 'path') ?? { name: param, in: 'path' }, spec)
                    ?? PATH_VALUES[param];
                let values: string[];
                if (enumValues?.length) {
                    values = enumValues.map(String);
                } else {
                    const source = sources[template] && template.indexOf(`{${param}}`) === template.lastIndexOf('{') ? sources[template] : sources[param];
                    let listPath: string;
                    let keys: string[];
                    let listTemplate: string;
                    if (source) {
                        listPath = this.fill(source.list, partial.done + before, template);
                        keys = source.keys;
                        listTemplate = source.list;
                    } else {
                        // Some lists are only described with a trailing slash
                        listTemplate = spec.paths[prefixTemplate]?.get ? prefixTemplate : `${prefixTemplate}/`;
                        if (!spec.paths[listTemplate]?.get) {
                            return { paths: [], problem: `no list to take {${param}} from` };
                        }
                        listPath = literal.replace(/\/$/, '') + (listTemplate.endsWith('/') ? '/' : '');
                        keys = keysFor(param);
                    }
                    const list = await this.fetch(api.prefix + listPath + this.pageQuery(spec, listTemplate));
                    if (list.status < 200 || list.status >= 300) {
                        const detail = NOT_IN_USE.test(JSON.stringify(list.body ?? '')) ? ', not in use on this console' : '';
                        return { paths: [], problem: `the list for {${param}} failed (${list.status}${detail})` };
                    }
                    values = idsFrom(list.body, keys, `${api.prefix}${listPath.replace(/\/$/, '')}`, source?.where);
                }
                for (const value of values) {
                    next.push({ done: literal + encodeURIComponent(value), rest: after });
                }
            }
            partials = next;
            if (!pending) {
                break;
            }
        }
        return { paths: partials.map(p => p.done + p.rest + query) };
    }

    /** Puts the values already chosen for earlier IDs into another template */
    private fill(listTemplate: string, done: string, template: string): string {
        const names = [...template.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
        const doneParts = done.split('/');
        const templateParts = template.split('/');
        let filled = listTemplate;
        for (const name of names) {
            const index = templateParts.indexOf(`{${name}}`);
            if (index >= 0 && index < doneParts.length && doneParts[index]) {
                filled = filled.replace(`{${name}}`, doneParts[index]);
            }
        }
        return filled;
    }

    pageQuery(spec: Spec, template: string): string {
        const params = spec.paths[template]?.get?.parameters ?? [];
        return params.some(p => p.name === 'pageable') ? '?page=0&size=1000' : '';
    }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            await run(items[next++]);
        }
    }));
}

export async function runExport(nam: Nam, options: ExportOptions): Promise<Record<string, unknown>> {
    const out = path.resolve(options.out);
    if (fs.existsSync(out) && fs.readdirSync(out).length) {
        throw usage(`${options.out} isn't empty; export into a new folder`);
    }
    fs.mkdirSync(out, { recursive: true, mode: options.revealSecrets ? 0o700 : 0o755 });
    options = { ...options, out };
    const walker = new Walker(nam.client, options);
    const summary: Record<string, unknown> = {};

    for (const api of APIS.filter(a => options.apis.includes(a.name))) {
        const specResponse = await walker.fetch(api.specPath);
        if (specResponse.status !== 200 || typeof specResponse.body !== 'object') {
            summary[api.name] = { error: `couldn't read ${api.specPath} (${specResponse.status})` };
            continue;
        }
        const spec = specResponse.body as Spec;
        walker.write(`${api.name}`, '/_api-description', spec);
        const templates = Object.keys(spec.paths).filter(p => spec.paths[p].get).sort();
        let saved = 0;
        let failed = 0;
        let skipped = 0;
        progress(`Reading the ${api.name} API: ${templates.length} read operations`, options.quiet);
        await pool(templates, options.concurrency ?? 4, async template => {
            const operation = spec.paths[template].get;
            const entry: ManifestEntry = { api: api.name, template, summary: operation.summary ?? operation.operationId };
            const why = NEVER.some(r => r.test(template)) ? 'changes something, reaches outside the console, or is binary'
                : PERSONAL.some(r => r.test(template)) ? 'personal data'
                : REFERENCE.some(r => r.test(template)) ? 'a lookup of what a policy may contain, not configuration'
                : !options.runtime && RUNTIME.some(r => r.test(template)) ? 'runtime state (use --runtime)'
                : undefined;
            if (why) {
                walker.manifest.push({ ...entry, skipped: why });
                skipped++;
                return;
            }
            const required = (operation.parameters ?? []).filter(p => p.in === 'query' && p.required && p.name !== 'pageable');
            const queries: string[] = [];
            const booleanValues = (p: Param) => ((p as { type?: string }).type ?? (p.schema as { type?: string } | undefined)?.type) === 'boolean' ? ['true', 'false'] : undefined;
            if (required.length === 1 && (enumOf(required[0], spec)?.length || booleanValues(required[0]))) {
                for (const value of enumOf(required[0], spec) ?? booleanValues(required[0])!) {
                    queries.push(`${required[0].name}=${encodeURIComponent(String(value))}`);
                }
            } else if (required.length) {
                walker.manifest.push({ ...entry, skipped: `needs ${required.map(p => p.name).join(', ')}` });
                skipped++;
                return;
            } else {
                queries.push('');
            }
            const page = walker.pageQuery(spec, template).replace(/^\?/, '');
            for (const query of queries) {
                const joined = [query, page].filter(Boolean).join('&');
                const { paths, problem } = await walker.expand(api, spec, template, joined ? `?${joined}` : '');
                if (problem) {
                    walker.manifest.push({ ...entry, skipped: problem });
                    skipped++;
                    continue;
                }
                for (const concrete of paths) {
                    const response = await walker.fetch(api.prefix + concrete);
                    if (response.status >= 200 && response.status < 300 && /<html[\s>]/i.test(typeof response.body === 'string' ? response.body : JSON.stringify(response.body))) {
                        // A sign-in page instead of data, as when a protocol isn't turned on
                        walker.manifest.push({ ...entry, path: concrete, status: response.status, skipped: 'returned a web page, not data (the feature may be off)' });
                        skipped++;
                    } else if (response.status >= 200 && response.status < 300) {
                        walker.manifest.push({ ...entry, path: concrete, status: response.status, file: walker.write(api.name, concrete, response.body) });
                        saved++;
                    } else {
                        const body = response.body as Raw | string | null;
                        const message = typeof body === 'string' ? body.slice(0, 200)
                            : JSON.stringify((body as Raw)?.response ?? body ?? '').slice(0, 200);
                        if (NOT_IN_USE.test(message)) {
                            walker.manifest.push({ ...entry, path: concrete, status: response.status, skipped: `not in use on this console: ${message}` });
                            skipped++;
                        } else {
                            walker.manifest.push({ ...entry, path: concrete, status: response.status, error: message });
                            failed++;
                        }
                    }
                }
            }
        });
        summary[api.name] = { saved, failed, skipped };
    }

    // The authentication setup of each Identity Server cluster, as files amcli apply takes
    const applyFiles: string[] = [];
    for (const cluster of await nam.idpClusters()) {
        const clusterNam = new Nam(nam.client, cluster.id);
        const file: Raw = { cluster: cluster.name, classes: [], methods: [], contracts: [] };
        for (const [kind, key] of [['class', 'classes'], ['method', 'methods'], ['contract', 'contracts']] as [Kind, string][]) {
            for (const ref of await clusterNam.refs(kind)) {
                const raw = await clusterNam.getRaw(kind, ref.id);
                const spec = await specOf(clusterNam, kind, raw);
                const properties = propertiesOf(kind, raw);
                if (options.revealSecrets) {
                    (file[key] as Raw[]).push({ ...spec, properties, replaceProperties: true });
                } else {
                    // Without the secrets, the file merges, so applying it can't wipe one out
                    const kept = Object.fromEntries(Object.entries(properties).filter(([name, value]) => !isSecretName(name) || harmless(value)));
                    (file[key] as Raw[]).push({ ...spec, properties: kept });
                }
            }
        }
        const relative = `apply/${safeSegment(cluster.name)}.json`;
        fs.mkdirSync(`${out}/apply`, { recursive: true, mode: options.revealSecrets ? 0o700 : 0o755 });
        fs.writeFileSync(`${out}/${relative}`, JSON.stringify(file, null, 2) + '\n', { mode: options.revealSecrets ? 0o600 : 0o644 });
        applyFiles.push(relative);
    }

    // The files the Advanced File Configurator keeps
    let afcSaved = 0;
    if (options.afcFiles) {
        for (const cluster of await nam.idpClusters()) {
            const clusterNam = new Nam(nam.client, cluster.id);
            for (const file of await afc.listFiles(clusterNam)) {
                try {
                    const { content } = await afc.download(clusterNam, file.fullName);
                    const target = `${out}/afc/${safeSegment(cluster.name)}${file.fullName}`;
                    fs.mkdirSync(path.dirname(target), { recursive: true, mode: options.revealSecrets ? 0o700 : 0o755 });
                    fs.writeFileSync(target, content, { mode: options.revealSecrets ? 0o600 : 0o644 });
                    afcSaved++;
                } catch (error) {
                    walker.manifest.push({ api: 'afc', template: file.fullName, error: (error as Error).message });
                }
            }
        }
    }

    const result = {
        out,
        redaction: options.revealSecrets ? 'none: secret values are kept, and the folder is readable by you alone' : 'secret values are blanked',
        ...summary,
        applyFiles,
        afcFiles: options.afcFiles ? afcSaved : undefined,
        manifest: 'manifest.json',
    };
    fs.writeFileSync(`${out}/manifest.json`, JSON.stringify({ exported: new Date().toISOString(), console: nam.client.baseUrl, ...result, entries: walker.manifest.sort((a, b) => `${a.api}${a.template}${a.path}`.localeCompare(`${b.api}${b.template}${b.path}`)) }, null, 2) + '\n', { mode: options.revealSecrets ? 0o600 : 0o644 });
    return result;
}
