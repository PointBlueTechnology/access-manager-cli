import fs from 'node:fs';
import { CliError, usage } from './errors.ts';
import { pick } from './nam.ts';
import type { Nam, Ref } from './nam.ts';

/**
 * SAML 2 trusted providers of an Identity Server cluster: the service providers it signs users in
 * to, and the identity providers it accepts sign-ins from. Read through the current API, which has
 * every setting; created from metadata through the older /amsvc/v1 API, which takes a metadata
 * document or URL directly.
 */
type Raw = Record<string, unknown>;

export type ProviderType = 'sp' | 'idp';

export interface Provider extends Ref {
    type: ProviderType;
    entityId?: string;
    enabled?: boolean;
}

async function base(nam: Nam): Promise<string> {
    return `/api/v1/clusters/${await nam.clusterId()}`;
}

export async function listProviders(nam: Nam): Promise<Provider[]> {
    const lists = (await nam.client.get(`${await base(nam)}/saml2providers`)) as Raw;
    const read = (key: string, type: ProviderType) => ((lists[key] as Raw[] | undefined) ?? []).map(item => ({
        id: String(item.id),
        name: String(item.nidsDisplayName ?? item.id),
        type,
        entityId: item.nidsProviderID as string | undefined,
        enabled: item.nidsEnabled as boolean | undefined,
    }));
    return [...read('trustedSPList', 'sp'), ...read('trustedIDPList', 'idp')];
}

/** By ID, display name or entity ID */
export async function findProvider(nam: Nam, ref: string, type?: ProviderType): Promise<Provider> {
    const all = (await listProviders(nam)).filter(p => !type || p.type === type);
    const byEntity = all.find(p => p.entityId === ref);
    return byEntity ?? pick(all, ref, type === 'sp' ? 'SAML service provider' : type === 'idp' ? 'SAML identity provider' : 'SAML provider');
}

export async function getProvider(nam: Nam, ref: string, type?: ProviderType): Promise<{ provider: Provider; detail: Raw }> {
    const provider = await findProvider(nam, ref, type);
    const detail = (await nam.client.get(`${await base(nam)}/saml2/${provider.type}/${encodeURIComponent(provider.id)}`)) as Raw;
    return { provider, detail };
}

/** Contract IDs anywhere in a provider's settings, under keys (or parent keys) that mention contracts */
export function contractRefs(detail: unknown): string[] {
    const found = new Set<string>();
    const walk = (value: unknown, inContract: boolean) => {
        if (Array.isArray(value)) {
            value.forEach(item => walk(item, inContract));
        } else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                walk(v, inContract || /contract/i.test(k));
            }
        } else if (typeof value === 'string' && inContract && /^ALC/.test(value)) {
            found.add(value);
        }
    };
    walk(detail, false);
    return [...found];
}

/** The provider's metadata as XML: stored in its settings, base64 or plain */
export function metadataOf(detail: Raw): string | undefined {
    const value = detail.nidsTrustedProviderMetadata ?? detail.metadata;
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    if (value.trimStart().startsWith('<')) {
        return value;
    }
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.trimStart().startsWith('<') ? decoded : value;
}

/** Creates a service provider from a metadata file or URL, through the older API */
export async function createServiceProvider(nam: Nam, name: string, metadata: { file?: string; url?: string }): Promise<Provider> {
    if (!!metadata.file === !!metadata.url) {
        throw usage('Give the metadata as --metadata <file> or --metadata-url <url>');
    }
    if ((await listProviders(nam)).some(p => p.type === 'sp' && p.name === name)) {
        throw new CliError('REJECTED', `A SAML service provider called "${name}" already exists`);
    }
    const text = metadata.file ? fs.readFileSync(metadata.file, 'utf8') : metadata.url!;
    if (metadata.file && !/EntityDescriptor/.test(text)) {
        throw usage(`${metadata.file} doesn't look like SAML metadata (no EntityDescriptor)`);
    }
    const body = {
        displayName: name,
        protocol: 'saml2',
        metadataImportType: metadata.file ? '1' : '0',
        metadata: text,
    };
    await nam.client.request('POST', `/amsvc/v1/idpclusters/${encodeURIComponent(await nam.clusterId())}/serviceproviders`, body);
    return findProvider(nam, name, 'sp');
}

export async function deleteProviders(nam: Nam, providers: Provider[]): Promise<void> {
    for (const type of ['sp', 'idp'] as const) {
        const ids = providers.filter(p => p.type === type).map(p => p.id);
        if (ids.length) {
            await nam.client.request('DELETE', `${await base(nam)}/saml2/${type}?providerIds=${ids.map(encodeURIComponent).join(',')}`);
        }
    }
}

export async function attributeMaps(nam: Nam): Promise<Raw[]> {
    const page = (await nam.client.get('/amsvc/v1/samlattributemaps?limit=1000')) as Raw;
    const list = ((page.samlAttributeMapList as Raw | undefined)?.samlAttributeMap ?? []) as Raw[];
    return list;
}
