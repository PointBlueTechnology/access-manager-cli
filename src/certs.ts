import { CliError } from './errors.ts';
import type { Client } from './client.ts';

/**
 * The console's certificates: its keystore certificates and trusted roots, with how long each has
 * left. Read from the older /amsvc/v1 API, which says which are trusted roots, gives dates with a
 * time zone and returns a trusted root's PEM; the current API's list is the fallback. Neither API
 * can list keystores or create a trusted root, so this is read-only.
 */
type Raw = Record<string, unknown>;

export interface Cert {
    name: string;
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    daysLeft?: number;
    expired?: boolean;
    trustedRoot?: boolean;
    keySize?: string;
    algorithm?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** "Monday, July 21, 2025 at 6:14:57 PM GMT" (old API) or "April 20, 2027, 18:55:45" (current API) */
export function parseDate(text: unknown): Date | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const time = Date.parse(text.replace(' at ', ' '));
    return Number.isNaN(time) ? undefined : new Date(time);
}

function withDates(cert: Cert, from: unknown, to: unknown, now: Date): Cert {
    const start = parseDate(from);
    const end = parseDate(to);
    return {
        ...cert,
        validFrom: start?.toISOString() ?? (from as string | undefined),
        validTo: end?.toISOString() ?? (to as string | undefined),
        daysLeft: end ? Math.floor((end.getTime() - now.getTime()) / DAY) : undefined,
        expired: end ? end.getTime() < now.getTime() : undefined,
    };
}

export async function listCerts(client: Client, now = new Date()): Promise<Cert[]> {
    let certs: Cert[];
    const legacy = await client.send('GET', '/amsvc/v1/security/certificates?limit=1000');
    if (legacy.status === 200) {
        const list = ((legacy.body as Raw)?.certList as Raw | undefined)?.certificate as Raw[] | undefined ?? [];
        certs = list.map(item => withDates({
            name: String(item.certName ?? item.instanceId),
            subject: item.subject as string | undefined,
            issuer: item.issuer as string | undefined,
            trustedRoot: item.isTrustedRoot === true,
            keySize: item.keySize !== undefined ? String(item.keySize) : undefined,
            algorithm: item.algorithm as string | undefined,
        }, item.validFrom, item.validTo, now));
    } else {
        // The current API lists the same certificates, with less detail and dates without a time zone
        const list = (await client.get('/api/v1/certificates/list')) as Raw[];
        certs = list.map(item => withDates({ name: String(item.certName), subject: item.subject as string | undefined }, item.validFrom, item.validTo, now));
    }
    return certs.sort((a, b) => (a.validTo ?? '').localeCompare(b.validTo ?? ''));
}

/** A PEM block as the console stores it (one long line) laid out in 64-character lines */
export function formatPem(text: string): string {
    const match = text.match(/-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----/);
    if (!match) {
        return text;
    }
    const body = match[2].replace(/\s+/g, '');
    return `-----BEGIN ${match[1]}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${match[1]}-----\n`;
}

export async function getCert(client: Client, name: string): Promise<Cert & { pem?: string }> {
    const certs = await listCerts(client);
    const cert = certs.find(c => c.name === name) ?? certs.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!cert) {
        throw new CliError('NOT_FOUND', `No certificate "${name}"`, { details: { available: certs.map(c => c.name) } });
    }
    if (!cert.trustedRoot) {
        return cert;
    }
    const root = (await client.get(`/amsvc/v1/security/trustedroots/${encodeURIComponent(cert.name)}`)) as Raw;
    const text = (root?.trustedRoot as Raw | undefined)?.cert;
    return { ...cert, pem: typeof text === 'string' ? formatPem(text) : undefined };
}
