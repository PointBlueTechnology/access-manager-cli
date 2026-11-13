import { CliError, usage } from './errors.ts';
import type { Client } from './client.ts';

/**
 * Identity Server configuration through the console API. Everything is addressed by display name
 * or by the console's ID, and returned in a flat shape with names alongside IDs.
 */
type Raw = Record<string, unknown>;

export type Kind = 'class' | 'method' | 'contract' | 'userstore';

const KINDS: Record<Kind, { path: string; deleteParam?: string; label: string }> = {
    class: { path: 'classes', deleteParam: 'classIds', label: 'authentication class' },
    method: { path: 'methods', deleteParam: 'methodIds', label: 'authentication method' },
    contract: { path: 'contracts', deleteParam: 'localContractIds', label: 'contract' },
    userstore: { path: 'userstores', label: 'user store' },
};

export interface Ref {
    id: string;
    name: string;
}

export interface ClusterInfo extends Ref {
    updateStatus?: string;
    healthStatus?: string;
    servers: { deviceId: string; ip?: string; updateStatus?: string; healthStatus?: string }[];
}

function nameOf(raw: Raw): string {
    return String(raw.nidsDisplayName ?? raw.displayName ?? raw.name ?? raw.id);
}

function contentOf(page: unknown): Raw[] {
    if (Array.isArray(page)) {
        return page as Raw[];
    }
    const object = (page ?? {}) as Raw;
    for (const key of ['content', 'data', 'clusterList']) {
        if (Array.isArray(object[key])) {
            return object[key] as Raw[];
        }
    }
    return [];
}

/** Finds one item by ID, then exact name, then a unique case-insensitive name. */
export function pick<T extends Ref>(items: T[], ref: string, label: string): T {
    const exact = items.find(item => item.id === ref) ?? items.find(item => item.name === ref);
    if (exact) {
        return exact;
    }
    const loose = items.filter(item => item.name.toLowerCase() === ref.toLowerCase());
    if (loose.length === 1) {
        return loose[0];
    }
    if (loose.length > 1) {
        throw usage(`More than one ${label} is called "${ref}"; use its ID: ${loose.map(item => item.id).join(', ')}`);
    }
    throw new CliError('NOT_FOUND', `No ${label} "${ref}"`, { details: { available: items.map(item => item.name) } });
}

export class Nam {
    readonly client: Client;
    private readonly clusterRef?: string;
    private cluster?: Ref;
    private readonly lists = new Map<Kind, Raw[]>();

    constructor(client: Client, clusterRef?: string) {
        this.client = client;
        this.clusterRef = clusterRef;
    }

    async idpClusters(): Promise<Ref[]> {
        const page = await this.client.get('/api/v1/clusters/list?servertype=IDP');
        return contentOf(page).map(raw => ({ id: String(raw.id), name: nameOf(raw) }));
    }

    /** The cluster to work on: --cluster or AMCLI_CLUSTER, or the only Identity Server cluster. */
    async clusterId(): Promise<string> {
        if (!this.cluster) {
            const clusters = await this.idpClusters();
            if (this.clusterRef) {
                this.cluster = pick(clusters, this.clusterRef, 'Identity Server cluster');
            } else if (clusters.length === 1) {
                this.cluster = clusters[0];
            } else {
                throw usage(`Choose a cluster with --cluster or AMCLI_CLUSTER: ${clusters.map(c => c.name).join(', ')}`);
            }
        }
        return this.cluster.id;
    }

    async clusterStatus(): Promise<ClusterInfo & { pending: Record<string, boolean> }> {
        const id = await this.clusterId();
        const all = (await this.client.get('/api/v1/clusters?servertype=IDP')) as Raw;
        const entry = contentOf({ content: all.assigned }).find(raw => raw.clusterId === id);
        if (!entry) {
            throw new CliError('NOT_FOUND', `Cluster ${id} isn't in the console's cluster list`);
        }
        const pending = (await this.client.get(`/api/v1/clusters/${id}/updateStatusEvents`)) as Record<string, boolean>;
        return {
            id,
            name: String(entry.clusterName ?? id),
            updateStatus: entry.updateStatus as string | undefined,
            healthStatus: entry.healthStatus as string | undefined,
            servers: contentOf({ content: entry.servers }).map(server => ({
                deviceId: String(server.deviceId),
                ip: server.deviceIp as string | undefined,
                updateStatus: server.updateStatus as string | undefined,
                healthStatus: server.healthStatus as string | undefined,
            })),
            pending,
        };
    }

    private async base(kind: Kind): Promise<string> {
        return `/api/v1/clusters/${await this.clusterId()}/${KINDS[kind].path}`;
    }

    async listRaw(kind: Kind, fresh = false): Promise<Raw[]> {
        if (fresh || !this.lists.has(kind)) {
            this.lists.set(kind, contentOf(await this.client.get(`${await this.base(kind)}?size=2000`)));
        }
        return this.lists.get(kind)!;
    }

    async refs(kind: Kind): Promise<Ref[]> {
        return (await this.listRaw(kind)).map(raw => ({ id: String(raw.id), name: nameOf(raw) }));
    }

    async resolve(kind: Kind, ref: string): Promise<Ref> {
        return pick(await this.refs(kind), ref, KINDS[kind].label);
    }

    async find(kind: Kind, ref: string): Promise<Ref | undefined> {
        try {
            return await this.resolve(kind, ref);
        } catch (error) {
            if (error instanceof CliError && error.code === 'NOT_FOUND') {
                return undefined;
            }
            throw error;
        }
    }

    async getRaw(kind: Kind, ref: string): Promise<Raw> {
        const { id } = await this.resolve(kind, ref);
        return (await this.client.get(`${await this.base(kind)}/${encodeURIComponent(id)}`)) as Raw;
    }

    async create(kind: Kind, body: Raw): Promise<Ref> {
        await this.client.request('POST', await this.base(kind), body);
        this.lists.delete(kind);
        return this.resolve(kind, String(body.nidsDisplayName));
    }

    async update(kind: Kind, id: string, body: Raw): Promise<void> {
        await this.client.request('PUT', `${await this.base(kind)}/${encodeURIComponent(id)}`, body);
        this.lists.delete(kind);
    }

    async remove(kind: Kind, ids: string[]): Promise<void> {
        const base = await this.base(kind);
        const param = KINDS[kind].deleteParam;
        if (param) {
            await this.client.request('DELETE', `${base}?${param}=${ids.map(encodeURIComponent).join(',')}`);
        } else {
            for (const id of ids) {
                await this.client.request('DELETE', `${base}/${encodeURIComponent(id)}`);
            }
        }
        this.lists.delete(kind);
    }

    /** Names for the IDs a method or contract refers to. */
    async names(kind: Kind, ids: unknown): Promise<Ref[]> {
        const refs = await this.refs(kind);
        return (Array.isArray(ids) ? ids : []).map(id => refs.find(ref => ref.id === id) ?? { id: String(id), name: String(id) });
    }

    async ids(kind: Kind, refs: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const ref of refs) {
            out.push((await this.resolve(kind, ref)).id);
        }
        return out;
    }
}

export function kindLabel(kind: Kind): string {
    return KINDS[kind].label;
}
