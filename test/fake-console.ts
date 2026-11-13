import { CliError } from '../src/errors.ts';
import type { Method } from '../src/client.ts';

/** An in-memory stand-in for the console API: one IDP cluster, its classes, methods, contracts and user stores. */
type Raw = Record<string, unknown>;

export class FakeConsole {
    readonly baseUrl = 'https://fake/nps';
    readonly user = 'admin';
    readonly calls: { method: Method; path: string; body?: unknown }[] = [];
    readonly store: Record<string, Raw[]> = {
        classes: [{ id: 'AC1', nidsDisplayName: 'Passkey1', nidsAuthJavaClassName: 'com.example.Passkey', nidsAuthTypeID: 0, nidsAuthClassProperties: { RP_ID: 'idp.example.com', RECOVERY_PEPPER: 'pepper-value' } }],
        methods: [],
        contracts: [],
        userstores: [{ id: 'US1', nidsDisplayName: 'eDirectory' }],
    };
    private next = 100;

    async get(path: string): Promise<unknown> {
        return this.request('GET', path);
    }

    async request(method: Method, path: string, body?: unknown): Promise<unknown> {
        this.calls.push({ method, path, body });
        const url = new URL(`https://fake${path}`);
        if (url.pathname === '/api/v1/clusters/list') {
            return { clusterList: [{ id: 'C1', nidsDisplayName: 'IDP-Cluster' }] };
        }
        const match = url.pathname.match(/^\/api\/v1\/clusters\/C1\/(classes|methods|contracts|userstores)(?:\/([^/]+))?$/);
        if (!match) {
            throw new CliError('NOT_FOUND', `${method} ${path}`);
        }
        const [, collection, id] = match;
        const items = this.store[collection];
        if (method === 'GET' && !id) {
            return { content: items, pageable: {} };
        }
        if (method === 'GET') {
            const found = items.find(item => item.id === id);
            if (!found) {
                throw new CliError('NOT_FOUND', `${method} ${path}`);
            }
            return structuredClone(found);
        }
        if (method === 'POST') {
            items.push({ ...(body as Raw), id: `${collection.slice(0, 2).toUpperCase()}${this.next++}` });
            return 'created';
        }
        if (method === 'PUT') {
            const index = items.findIndex(item => item.id === id);
            items[index] = { ...(body as Raw), id };
            return 'updated';
        }
        if (method === 'DELETE') {
            const ids = [...url.searchParams.values()].join(',').split(',');
            this.store[collection] = items.filter(item => !ids.includes(String(item.id)));
            return 'deleted';
        }
        throw new CliError('ERROR', `${method} ${path}`);
    }

    close(): void {}
}
