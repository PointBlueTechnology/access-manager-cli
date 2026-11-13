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
    async send(method: Method, path: string, body?: unknown, accept = 'application/json'): Promise<ApiResponse> {
        const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const response = await this.exchange(method, path, payload, 'application/json', accept);
        return { status: response.status, body: parse(response.data.toString('utf8')) };
    }

    /** Uploads a multipart form, as the Advanced File Configurator page does. */
    async upload(path: string, fields: Record<string, string>, file: { field: string; name: string; type: string; content: Buffer }): Promise<unknown> {
        const boundary = `----amcli${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const parts: Buffer[] = [];
        for (const [name, value] of Object.entries(fields)) {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        }
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name.replace(/"/g, '')}"\r\nContent-Type: ${file.type}\r\n\r\n`));
        parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
        const response = await this.exchange('POST', path, Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
        const body = parse(response.data.toString('utf8'));
        if (response.status >= 200 && response.status < 300) {
            return body;
        }
        throw failure('POST', path, { status: response.status, body });
    }

    /** A request whose answer is a file: returns its bytes. */
    async download(method: Method, path: string, body?: unknown): Promise<Buffer> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const response = await this.exchange(method, path, payload, 'application/json', '*/*');
        if (response.status >= 200 && response.status < 300) {
            return response.data;
        }
        throw failure(method, path, { status: response.status, body: parse(response.data.toString('utf8')) });
    }

    /**
     * Paths under /roma/ and /amsvc/ go to the console's older REST APIs, next to /nps, with the
     * same password. Everything else is relative to /nps.
     */
    private url(path: string): string {
        const relative = path.startsWith('/') ? path : `/${path}`;
        return relative.startsWith('/roma/') || relative.startsWith('/amsvc/')
            ? new URL(this.config.baseUrl).origin + relative
            : this.config.baseUrl + relative;
    }

    private exchange(method: Method, path: string, payload: Buffer | undefined, contentType: string, accept = 'application/json'): Promise<{ status: number; data: Buffer }> {
        const url = this.url(path);
        // The older /amsvc/v1 API signs in with the administrator's DN rather than their short name
        const user = path.startsWith('/amsvc/') ? this.config.legacyUser : this.config.user;
        const auth = Buffer.from(`${user}:${this.config.password}`).toString('base64');
        const headers: Record<string, string> = { Accept: accept, Authorization: `Basic ${auth}` };
        if (payload !== undefined) {
            headers['Content-Type'] = contentType;
            headers['Content-Length'] = String(payload.length);
        }
        return new Promise((resolve, reject) => {
            const request = https.request(url, { method, headers, agent: this.agent, timeout: this.config.timeoutMs, servername: this.config.tlsServerName }, response => {
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => resolve({ status: response.statusCode ?? 0, data: Buffer.concat(chunks) }));
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
    const hint = tls ? ' Set AMCLI_CA_FILE to the console certificate\'s CA (and AMCLI_TLS_SERVERNAME to its name if you connect by address), or AMCLI_INSECURE=1 on a test system.' : '';
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
