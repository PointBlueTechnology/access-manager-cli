import https from 'node:https';
import { CliError } from './errors.ts';
import type { Config } from './config.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ApiResponse {
    status: number;
    body: unknown;
}

/** A thin HTTPS client for the console API, with HTTP Basic authentication. */
export class Client {
    private readonly config: Config;
    private readonly agent: https.Agent;

    constructor(config: Config) {
        this.config = config;
        this.agent = new https.Agent({
            keepAlive: true,
            ca: config.ca,
            rejectUnauthorized: !config.insecure,
        });
    }

    get baseUrl(): string {
        return this.config.baseUrl;
    }

    get user(): string {
        return this.config.user;
    }

    /** Sends a request; returns the parsed body, or throws a CliError for anything but 2xx. */
    async request(method: Method, path: string, body?: unknown): Promise<unknown> {
        const response = await this.send(method, path, body);
        if (response.status >= 200 && response.status < 300) {
            return response.body;
        }
        throw failure(method, path, response);
    }

    get(path: string): Promise<unknown> {
        return this.request('GET', path);
    }

    /** Sends a request and returns the status and body whatever the status. */
    send(method: Method, path: string, body?: unknown): Promise<ApiResponse> {
        const url = this.config.baseUrl + (path.startsWith('/') ? path : `/${path}`);
        const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        const auth = Buffer.from(`${this.config.user}:${this.config.password}`).toString('base64');
        const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Basic ${auth}` };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        return new Promise((resolve, reject) => {
            const request = https.request(url, { method, headers, agent: this.agent, timeout: this.config.timeoutMs }, response => {
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({ status: response.statusCode ?? 0, body: parse(text) });
                });
            });
            request.on('timeout', () => {
                request.destroy(new CliError('TIMEOUT', `No answer from ${url} within ${this.config.timeoutMs} ms`));
            });
            request.on('error', error => {
                reject(error instanceof CliError ? error : connectionError(url, error));
            });
            if (payload !== undefined) {
                request.write(payload);
            }
            request.end();
        });
    }

    close(): void {
        this.agent.destroy();
    }
}

function parse(text: string): unknown {
    if (text === '') {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function connectionError(url: string, error: Error & { code?: string }): CliError {
    const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(error.code ?? '');
    const hint = tls ? ' Set AMCLI_CA_FILE to the console certificate\'s CA, or AMCLI_INSECURE=1 on a test system.' : '';
    return new CliError('CONNECTION', `Can't reach ${url}: ${error.message}.${hint}`);
}

function failure(method: Method, path: string, response: ApiResponse): CliError {
    const message = messageOf(response.body);
    const what = `${method} ${path} returned ${response.status}${message ? `: ${message}` : ''}`;
    switch (response.status) {
        case 401:
        case 403:
            return new CliError('AUTH', `${what}. Check AMCLI_USER and AMCLI_PASSWORD.`, { status: response.status });
        case 404:
            return new CliError('NOT_FOUND', what, { status: response.status, details: response.body });
        case 400:
        case 409:
        case 422:
            return new CliError('REJECTED', what, { status: response.status, details: response.body });
        default:
            return new CliError('ERROR', what, { status: response.status, details: response.body });
    }
}

function messageOf(body: unknown): string {
    if (typeof body === 'string') {
        return body.slice(0, 300);
    }
    if (body && typeof body === 'object') {
        const object = body as Record<string, unknown>;
        for (const key of ['errorMessage', 'message', 'error', 'detail']) {
            if (typeof object[key] === 'string') {
                return object[key] as string;
            }
        }
    }
    return '';
}
