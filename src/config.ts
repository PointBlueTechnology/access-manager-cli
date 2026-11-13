import fs from 'node:fs';
import { CliError, usage } from './errors.ts';

/**
 * Connection settings. They come from environment variables, optionally loaded from an env file
 * (--env-file or AMCLI_ENV_FILE). The password is never taken from the command line, where it
 * would show in process lists and shell history.
 *
 *   AMCLI_URL            the Administration Console, e.g. https://ac.example.com:8443 (/nps is added)
 *   AMCLI_USER           console administrator (default: admin)
 *   AMCLI_LEGACY_USER    its DN, for the older /amsvc/v1 API (default: AMCLI_USER if it's a DN,
 *                        else cn=<AMCLI_USER>,o=novell)
 *   AMCLI_PASSWORD       its password, or
 *   AMCLI_PASSWORD_FILE  a file holding it
 *   AMCLI_CA_FILE        PEM file of the CA that signed the console's certificate
 *   AMCLI_TLS_SERVERNAME check the certificate against this name, when AMCLI_URL uses an address
 *   AMCLI_INSECURE=1     skip certificate checks (test systems only)
 *   AMCLI_CLUSTER        default cluster, by name or ID
 *   AMCLI_TIMEOUT_MS     per-request timeout (default 60000)
 */
export interface Config {
    baseUrl: string;
    user: string;
    /** The administrator's DN, which the older /amsvc/v1 API wants */
    legacyUser: string;
    password: string;
    ca?: string;
    tlsServerName?: string;
    insecure: boolean;
    cluster?: string;
    timeoutMs: number;
}

export interface ConfigFlags {
    envFile?: string;
    url?: string;
    user?: string;
    cluster?: string;
    insecure?: boolean;
    passwordStdin?: boolean;
}

export function loadEnvFile(path: string | undefined): void {
    const file = path ?? process.env.AMCLI_ENV_FILE;
    if (!file) {
        return;
    }
    if (!fs.existsSync(file)) {
        throw usage(`Env file not found: ${file}`);
    }
    process.loadEnvFile(file);
}

export function normalizeBaseUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw usage(`AMCLI_URL is not a URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
        throw usage('AMCLI_URL must use https');
    }
    const path = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = path.endsWith('/nps') ? path : `${path}/nps`;
    return parsed.toString().replace(/\/+$/, '');
}

function readStdin(): string {
    return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

export function resolveConfig(flags: ConfigFlags): Config {
    loadEnvFile(flags.envFile);
    const env = process.env;
    const url = flags.url ?? env.AMCLI_URL;
    if (!url) {
        throw usage('Set AMCLI_URL (or --url) to the Administration Console, e.g. https://ac.example.com:8443');
    }
    let password = env.AMCLI_PASSWORD;
    if (flags.passwordStdin) {
        password = readStdin();
    } else if (!password && env.AMCLI_PASSWORD_FILE) {
        password = fs.readFileSync(env.AMCLI_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
    }
    if (!password) {
        throw new CliError('AUTH', 'Set AMCLI_PASSWORD or AMCLI_PASSWORD_FILE, or pass --password-stdin');
    }
    const timeout = Number(env.AMCLI_TIMEOUT_MS ?? 60000);
    const user = flags.user ?? env.AMCLI_USER ?? 'admin';
    return {
        baseUrl: normalizeBaseUrl(url),
        user,
        legacyUser: env.AMCLI_LEGACY_USER || (user.includes('=') ? user : `cn=${user},o=novell`),
        password,
        ca: env.AMCLI_CA_FILE ? fs.readFileSync(env.AMCLI_CA_FILE, 'utf8') : undefined,
        tlsServerName: env.AMCLI_TLS_SERVERNAME || undefined,
        insecure: flags.insecure ?? /^(1|true|yes)$/i.test(env.AMCLI_INSECURE ?? ''),
        cluster: flags.cluster ?? env.AMCLI_CLUSTER,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60000,
    };
}
