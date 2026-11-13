import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CliError, usage } from './errors.ts';
import { progress } from './output.ts';
import type { Nam } from './nam.ts';

/**
 * The Advanced File Configurator: files the console keeps and sends to the Identity Servers, such
 * as a custom authentication class's jar and JSPs. Uploading saves a file in the console; sending
 * copies it to the cluster's servers. Only Identity Server clusters for now.
 */
type Raw = Record<string, unknown>;

const BASE = '/api/v1/afc/customfiles';
const DEVICE = 'idp';

export interface AfcFile {
    fullName: string;
    path: string;
    name: string;
    cluster: string;
    clusterId: string;
    description?: string;
    modificationType?: unknown;
    serverRestart?: boolean;
    defaultFile?: boolean;
    modified?: string;
    status?: string;
    servers: { ip?: string; status?: string; error?: string }[];
}

export async function listFiles(nam: Nam): Promise<AfcFile[]> {
    const clusterId = await nam.clusterId();
    const config = (await nam.client.get(`${BASE}/config`)) as Raw;
    const idp = ((config.configfiles as Raw | undefined)?.idp ?? {}) as Raw;
    const clusters = (idp.clusterFilesMap ?? {}) as Record<string, { configFilesMap?: Record<string, Raw> }>;
    const files = clusters[clusterId]?.configFilesMap ?? {};
    return Object.entries(files).map(([fullName, raw]) => {
        const status = (raw.uploadStatus ?? {}) as Raw;
        const servers = (((status.uploadStatusList as Raw | undefined)?.servers ?? []) as Raw[]).map(server => ({
            ip: server.deviceIP as string | undefined,
            status: server.pushStatus as string | undefined,
            error: (server.errMessage as string | undefined) || undefined,
        }));
        return {
            fullName,
            path: String(raw.path),
            name: String(raw.name),
            cluster: String(raw.clusterName),
            clusterId: String(raw.clusterID),
            description: (raw.description as string | undefined) || undefined,
            modificationType: raw.modificationType ?? undefined,
            serverRestart: raw.serverRestart as boolean | undefined,
            defaultFile: raw.defaultFile as boolean | undefined,
            modified: raw.modified as string | undefined,
            status: status.overallPushStatus as string | undefined,
            servers,
        };
    });
}

async function findFile(nam: Nam, fullName: string): Promise<AfcFile> {
    const files = await listFiles(nam);
    const found = files.find(file => file.fullName === fullName) ?? files.filter(file => file.name === fullName).at(0);
    if (!found) {
        throw new CliError('NOT_FOUND', `The Advanced File Configurator has no file ${fullName}`, { details: { available: files.map(file => file.fullName) } });
    }
    if (files.filter(file => file.name === fullName).length > 1 && found.fullName !== fullName) {
        throw usage(`More than one file is called ${fullName}; give the full path`);
    }
    return found;
}

export interface UploadOptions {
    dir: string;
    name?: string;
    description?: string;
    types?: string[];
    restart?: boolean;
    contentType?: string;
}

function contentTypeFor(name: string): string {
    const extension = path.extname(name).toLowerCase();
    return ({ '.jar': 'application/java-archive', '.jsp': 'text/plain', '.jspf': 'text/plain', '.properties': 'text/plain', '.xml': 'text/xml', '.ldif': 'text/ldif', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

/** The upload's description, as the console's page builds it. */
export async function uploadDetails(nam: Nam, localFile: string, options: UploadOptions): Promise<Raw> {
    if (!options.dir.startsWith('/')) {
        throw usage('--dir must be an absolute path on the servers, e.g. /opt/novell/nids/lib/webapp/jsp');
    }
    const clusterId = await nam.clusterId();
    const cluster = (await nam.idpClusters()).find(c => c.id === clusterId)!;
    const name = options.name ?? path.basename(localFile);
    const dir = options.dir.endsWith('/') ? options.dir : `${options.dir}/`;
    // Replacing a file keeps what the console already says about it, unless told otherwise
    const existing = (await listFiles(nam)).find(file => file.fullName === `${dir}${name}`);
    return {
        clusterID: cluster.id,
        clusterName: cluster.name,
        defaultFile: existing?.defaultFile ?? false,
        description: options.description ?? existing?.description ?? '',
        deviceType: DEVICE,
        fileType: true,
        modificationType: options.types?.length ? options.types : existing?.modificationType ?? [],
        name,
        path: dir,
        retainModificationAfterUpgrade: false,
        serverRestart: options.restart ?? existing?.serverRestart ?? false,
        source: 'LOCAL',
        sourceData: name,
        uploadStatus: {},
    };
}

export async function upload(nam: Nam, localFile: string, details: Raw, contentType?: string): Promise<AfcFile> {
    let content: Buffer;
    try {
        content = fs.readFileSync(localFile);
    } catch (error) {
        throw usage(`Can't read ${localFile}: ${(error as Error).message}`);
    }
    const name = String(details.name);
    await nam.client.upload(`${BASE}/file`, { fileDetails: JSON.stringify(details) }, { field: 'fileContent', name, type: contentType ?? contentTypeFor(name), content });
    return findFile(nam, `${details.path}${name}`);
}

function identifiers(files: AfcFile[]): Raw[] {
    return files.map(file => ({ fullName: file.fullName, clusterName: file.cluster, clusterID: file.clusterId, deviceType: DEVICE }));
}

/** Sends files to the cluster's servers; with wait, until each is PUSHED (or fails). */
export async function send(nam: Nam, names: string[], options: { restart: boolean; wait: boolean; timeoutSec: number; quiet: boolean }): Promise<AfcFile[]> {
    const files: AfcFile[] = [];
    for (const name of names) {
        files.push(await findFile(nam, name));
    }
    await nam.client.request('POST', `/roma/rest/customfiles/files/device?op=push&deviceType=${DEVICE}&immrestart=${options.restart}`, identifiers(files));
    progress(`Sending ${files.map(file => file.fullName).join(', ')}`, options.quiet);
    if (!options.wait) {
        return Promise.all(files.map(file => findFile(nam, file.fullName)));
    }
    const deadline = Date.now() + options.timeoutSec * 1000;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const now = await Promise.all(files.map(file => findFile(nam, file.fullName)));
        const failed = now.filter(file => file.servers.some(server => server.error) || /FAIL|ERROR/i.test(file.status ?? ''));
        if (failed.length) {
            throw new CliError('REJECTED', `Sending failed for ${failed.map(file => file.fullName).join(', ')}`, { details: failed });
        }
        if (now.every(file => file.status === 'PUSHED' && file.servers.every(server => server.status === 'PUSHED'))) {
            return now;
        }
        if (Date.now() > deadline) {
            throw new CliError('TIMEOUT', `Files weren't sent within ${options.timeoutSec} s`, { details: now });
        }
    }
}

/** The console's Untrack Configurations: forgets the files; the servers keep their copies. */
export async function untrack(nam: Nam, names: string[]): Promise<AfcFile[]> {
    const files: AfcFile[] = [];
    for (const name of names) {
        files.push(await findFile(nam, name));
    }
    const body = files.map(file => ({ fullName: file.fullName, fileType: true, clusterName: file.cluster, clusterID: file.clusterId, deviceType: DEVICE, defaultFile: file.defaultFile ?? false }));
    await nam.client.request('POST', `${BASE}/files/selected?op=delete&needClusterBasedDirectory=true`, body);
    return files;
}

/**
 * The console's Remove Configuration: deletes custom files from every server in the cluster, and
 * puts files that came with the product back to their original version.
 */
export async function remove(nam: Nam, names: string[], options: { restart: boolean; wait: boolean; timeoutSec: number; quiet: boolean }): Promise<AfcFile[]> {
    const files: AfcFile[] = [];
    for (const name of names) {
        files.push(await findFile(nam, name));
    }
    await nam.client.request('POST', `/roma/rest/customfiles/files/device?op=delete&deviceType=${DEVICE}&immrestart=${options.restart}`, identifiers(files));
    progress(`Removing ${files.map(file => file.fullName).join(', ')}`, options.quiet);
    if (!options.wait) {
        return files;
    }
    const deadline = Date.now() + options.timeoutSec * 1000;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const now = await listFiles(nam);
        const left = now.filter(file => files.some(f => f.fullName === file.fullName));
        const failed = left.filter(file => file.servers.some(server => server.error) || /FAIL|ERROR/i.test(file.status ?? ''));
        if (failed.length) {
            throw new CliError('REJECTED', `Removing failed for ${failed.map(file => file.fullName).join(', ')}`, { details: failed });
        }
        if (!left.length) {
            return files;
        }
        if (Date.now() > deadline) {
            throw new CliError('TIMEOUT', `Files weren't removed within ${options.timeoutSec} s`, { details: left });
        }
    }
}

export async function download(nam: Nam, name: string): Promise<{ file: AfcFile; content: Buffer }> {
    const file = await findFile(nam, name);
    const query = new URLSearchParams({ fileFullName: file.fullName, deviceType: DEVICE, clusterID: file.clusterId });
    const archive = await nam.client.download('GET', `${BASE}/files?${query}`);
    return { file, content: extract(archive, file.fullName) };
}

/**
 * The console answers with a .tar.gz holding customfiles/<full path> and a filesSucceeded list;
 * this takes the one file out. Anything that isn't gzip is returned as it came.
 */
export function extract(archive: Buffer, fullName: string): Buffer {
    if (archive[0] !== 0x1f || archive[1] !== 0x8b) {
        return archive;
    }
    const entries = readTar(zlib.gunzipSync(archive));
    const found = entries.get(`customfiles${fullName}`);
    if (found) {
        return found;
    }
    const failed = entries.get('customfiles/filesFailed')?.toString('utf8').trim();
    throw new CliError('NOT_FOUND', `The console's download didn't contain ${fullName}`, failed ? { details: { filesFailed: failed.split('\n') } } : {});
}

function readTar(tar: Buffer): Map<string, Buffer> {
    const entries = new Map<string, Buffer>();
    let longName: string | undefined;
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            break;
        }
        const text = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(text(124, 12).trim() || '0', 8);
        const type = text(156, 1);
        const prefix = text(345, 155);
        const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
        const body = tar.subarray(offset + 512, offset + 512 + size);
        longName = undefined;
        if (type === 'L') {
            longName = body.toString('utf8').replace(/\0.*$/s, '');
        } else if (type === '0' || type === '') {
            entries.set(name.replace(/^\.\//, ''), Buffer.from(body));
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
}

export const FETCH_VERSIONS = ['current', 'first', 'last'] as const;

/**
 * A file as one server has it now (current), or the copy kept before AFC first or last changed it
 * (first, last), as the console's Download Configurations to Edit Offline does. Edit it and post it
 * back with afc upload.
 */
export async function fetchFromServer(nam: Nam, fullName: string, options: { version: string; server?: string }): Promise<{ server: string; content: Buffer }> {
    if (!(FETCH_VERSIONS as readonly string[]).includes(options.version)) {
        throw usage(`--version is one of ${FETCH_VERSIONS.join(', ')}`);
    }
    if (!fullName.startsWith('/')) {
        throw usage('Give the file\'s full path on the server');
    }
    const status = await nam.clusterStatus();
    const server = options.server
        ? status.servers.find(s => s.deviceId === options.server || s.ip === options.server)
        : status.servers[0];
    if (!server) {
        throw new CliError('NOT_FOUND', `No server ${options.server} in ${status.name}`, { details: { available: status.servers.map(s => s.ip ?? s.deviceId) } });
    }
    const archive = await nam.client.download('POST', `/roma/rest/customfiles/getfiles/device/${encodeURIComponent(status.id)}/${encodeURIComponent(server.deviceId)}?version=${options.version}`, { files: [fullName] });
    return { server: server.ip ?? server.deviceId, content: extract(archive, fullName) };
}
