import readline from 'node:readline';
import { Client } from './client.ts';
import { COMMANDS, VERSION } from './commands.ts';
import type { Command, Context, OptionSpec } from './commands.ts';
import { resolveConfig } from './config.ts';
import type { ConfigFlags } from './config.ts';
import { CliError, usage } from './errors.ts';
import { Nam } from './nam.ts';
import { redact } from './redact.ts';

/**
 * amcli as a Model Context Protocol server on stdio, with no dependencies: JSON-RPC 2.0, one
 * message per line. Every command becomes a tool, built from the same table as `amcli help` and
 * `amcli describe`, so the tools always match the CLI. The CLI's safety carries over: secrets are
 * redacted, deletes and Updates need `yes`, and every write takes `dry-run`. --read-only offers
 * only the tools that don't change the console.
 */
type Raw = Record<string, unknown>;

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Commands that make no sense as tools: the server itself, and the CLI's own description */
const NOT_TOOLS = new Set(['mcp', 'describe']);
/** Options for exit codes, which a tool result has no use for */
const NOT_INPUTS = new Set(['exit-code', 'fail', 'help']);
/** Options that write files on this computer */
const FILE_OUTPUTS = new Set(['out', 'output', 'save', 'markdown', 'backup']);

export interface ServeOptions {
    readOnly: boolean;
    revealSecrets: boolean;
    config: ConfigFlags;
    /** For tests: the console to use instead of connecting with the settings */
    nam?: (cluster?: string) => Nam;
}

interface Positional {
    name: string;
    description: string;
    required: boolean;
    many: boolean;
}

/** '<name|id|entityID>...' → names; '<export> [<export>]' → export, export2 */
export function positionalsOf(args: string | undefined): Positional[] {
    const out: Positional[] = [];
    for (const token of (args ?? '').split(/\s+/).filter(Boolean)) {
        const match = token.match(/^(\[)?<([^>]+)>(\.\.\.)?\]?$/);
        if (!match) {
            continue;
        }
        const [, optional, inner, many] = match;
        let name = inner.split('|')[0].toLowerCase() + (many ? 's' : '');
        if (out.some(p => p.name === name)) {
            name = `${name}${out.filter(p => p.name.startsWith(name)).length + 1}`;
        }
        out.push({ name, description: inner.split('|').join(' or '), required: !optional, many: Boolean(many) });
    }
    return out;
}

export function toolName(command: Command): string {
    return command.name.replace(/[\s-]+/g, '_');
}

function optionSchema(spec: OptionSpec): Raw {
    if (spec.type === 'boolean') {
        return { type: 'boolean', description: spec.description };
    }
    return spec.multiple
        ? { type: 'array', items: { type: 'string' }, description: spec.description }
        : { type: 'string', description: spec.description };
}

function writesFiles(command: Command): boolean {
    return command.name === 'export' || command.name === 'backup' || Object.keys(command.options ?? {}).some(o => FILE_OUTPUTS.has(o));
}

export function toolsFor(readOnly: boolean): { command: Command; tool: Raw }[] {
    return COMMANDS
        .filter(command => !NOT_TOOLS.has(command.name) && !(readOnly && command.writes))
        .map(command => {
            const properties: Raw = {};
            const required: string[] = [];
            for (const p of positionalsOf(command.args)) {
                properties[p.name] = p.many
                    ? { type: 'array', items: { type: 'string' }, minItems: p.required ? 1 : 0, description: p.description }
                    : { type: 'string', description: p.description };
                if (p.required) {
                    required.push(p.name);
                }
            }
            for (const [name, spec] of Object.entries(command.options ?? {})) {
                if (!NOT_INPUTS.has(name)) {
                    properties[name] = optionSchema(spec);
                }
            }
            properties.cluster = { type: 'string', description: 'Identity Server cluster by name or ID, when there is more than one' };
            const notes = [
                command.writes ? 'Changes the console; dry-run shows what it would do.' : undefined,
                command.confirm ? 'Needs yes: true, because it deletes something or interrupts service. Ask the user first.' : undefined,
            ].filter(Boolean);
            return {
                command,
                tool: {
                    name: toolName(command),
                    title: `amcli ${command.name}`,
                    description: [command.summary, ...notes].join(' '),
                    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
                    annotations: {
                        title: `amcli ${command.name}`,
                        readOnlyHint: !command.writes && !writesFiles(command),
                        destructiveHint: Boolean(command.confirm),
                        openWorldHint: false,
                    },
                },
            };
        });
}

/** A tool call's arguments as the CLI's parsed values and positionals */
export function toInvocation(command: Command, args: Raw): { values: Context['values']; positionals: string[] } {
    const known = new Set([...positionalsOf(command.args).map(p => p.name), ...Object.keys(command.options ?? {}).filter(o => !NOT_INPUTS.has(o)), 'cluster']);
    const unknown = Object.keys(args).filter(k => !known.has(k));
    if (unknown.length) {
        throw usage(`${toolName(command)} has no input ${unknown.join(', ')}`);
    }
    const positionals: string[] = [];
    for (const p of positionalsOf(command.args)) {
        const value = args[p.name];
        if (value === undefined) {
            if (p.required) {
                throw usage(`${toolName(command)} needs ${p.name}`);
            }
            continue;
        }
        const items = Array.isArray(value) ? value : [value];
        if (!p.many && items.length !== 1) {
            throw usage(`${p.name} is one value`);
        }
        positionals.push(...items.map(String));
    }
    const values: Context['values'] = {};
    for (const [name, spec] of Object.entries(command.options ?? {})) {
        const value = args[name];
        if (value === undefined || NOT_INPUTS.has(name)) {
            continue;
        }
        if (spec.type === 'boolean') {
            if (typeof value !== 'boolean') {
                throw usage(`${name} is true or false`);
            }
            values[name] = value;
        } else if (spec.multiple) {
            values[name] = (Array.isArray(value) ? value : [value]).map(String);
        } else {
            if (typeof value === 'object') {
                throw usage(`${name} is a string`);
            }
            values[name] = String(value);
        }
    }
    return { values, positionals };
}

/**
 * The CLI's messages name its commands and flags; a tool caller knows tools and inputs.
 * "Run amcli update --yes" becomes "Run the update tool with yes: true".
 */
export function toolTerms(text: string): string {
    const names = new Set(COMMANDS.map(c => c.name));
    return text
        .replace(/\b([Rr]un) amcli ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g, (whole, run: string, first: string, second?: string) => {
            const name = second && names.has(`${first} ${second}`) ? `${first} ${second}` : first;
            const rest = name === first && second ? ` ${second}` : '';
            return names.has(name) ? `${run} the ${name.replace(/[\s-]+/g, '_')} tool${rest}` : whole;
        })
        .replace(/ tool --(yes|dry-run)\b/g, ' tool with $1: true')
        .replace(/--(yes|dry-run)\b/g, '$1: true');
}

export class McpServer {
    private client?: Client;
    private defaultCluster?: string;
    private readonly tools: Map<string, { command: Command; tool: Raw }>;
    private readonly options: ServeOptions;

    constructor(options: ServeOptions) {
        this.options = options;
        this.tools = new Map(toolsFor(options.readOnly).map(t => [t.tool.name as string, t]));
    }

    /** Settings are read on the first call, so a client can list the tools before they're set */
    private nam(cluster?: string): Nam {
        if (this.options.nam) {
            return this.options.nam(cluster);
        }
        if (!this.client) {
            const config = resolveConfig(this.options.config);
            this.client = new Client(config);
            this.defaultCluster = config.cluster;
        }
        return new Nam(this.client, cluster ?? this.defaultCluster);
    }

    async callTool(name: string, args: Raw): Promise<Raw> {
        const entry = this.tools.get(name);
        if (!entry) {
            throw new RpcError(-32602, `No tool ${name}${this.options.readOnly ? ' (the server is read-only)' : ''}`);
        }
        const { command } = entry;
        try {
            const { values, positionals } = toInvocation(command, args);
            if (this.options.revealSecrets) {
                values['reveal-secrets'] = true;
            }
            let nam: Nam | undefined;
            const result = await command.run({
                nam: () => (nam ??= this.nam(typeof args.cluster === 'string' ? args.cluster : undefined)),
                values,
                positionals,
                quiet: true,
            });
            let shown = this.options.revealSecrets || command.plain ? result : redact(result);
            if (shown && typeof shown === 'object' && typeof (shown as Raw).next === 'string') {
                shown = { ...(shown as Raw), next: toolTerms((shown as Raw).next as string) };
            }
            return { content: [{ type: 'text', text: JSON.stringify(shown ?? null, null, 2) }] };
        } catch (error) {
            const failure = error instanceof CliError ? error : new CliError('ERROR', error instanceof Error ? error.message : String(error));
            const body: Raw = { code: failure.code, message: toolTerms(failure.message) };
            if (failure.status !== undefined) {
                body.status = failure.status;
            }
            if (failure.details !== undefined) {
                body.details = redact(failure.details);
            }
            return { content: [{ type: 'text', text: JSON.stringify({ error: body }, null, 2) }], isError: true };
        } finally {
            // Commands such as diff set an exit code for the CLI; it means nothing to the server
            process.exitCode = undefined;
        }
    }

    async handle(message: Raw): Promise<Raw | undefined> {
        const id = message.id as string | number | undefined;
        const isRequest = id !== undefined && id !== null;
        try {
            const result = await this.dispatch(String(message.method ?? ''), (message.params ?? {}) as Raw);
            return isRequest ? { jsonrpc: '2.0', id, result } : undefined;
        } catch (error) {
            if (!isRequest) {
                return undefined;
            }
            const rpc = error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error));
            return { jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message } };
        }
    }

    private async dispatch(method: string, params: Raw): Promise<Raw> {
        switch (method) {
            case 'initialize': {
                const asked = String(params.protocolVersion ?? '');
                return {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'amcli', title: 'OpenText Access Manager (amcli)', version: VERSION },
                    instructions: [
                        'Tools for the OpenText Access Manager Administration Console. Results are JSON.',
                        'Secrets show as <redacted>. Changes to classes, methods, contracts and SAML providers reach the Identity Servers only after the update tool with yes: true, which can interrupt service: ask the user first.',
                        'Tools that delete or interrupt service need yes: true; every tool that changes the console takes dry-run: true to show what it would do.',
                        'Before changing or deleting a contract, method or class, the report tool shows what uses it.',
                        this.options.readOnly ? 'This server is read-only: tools that change the console are not offered.' : '',
                    ].filter(Boolean).join(' '),
                };
            }
            case 'ping':
                return {};
            case 'tools/list':
                return { tools: [...this.tools.values()].map(t => t.tool) };
            case 'tools/call':
                if (typeof params.name !== 'string') {
                    throw new RpcError(-32602, 'tools/call needs a tool name');
                }
                return this.callTool(params.name, (params.arguments ?? {}) as Raw);
            default:
                if (method.startsWith('notifications/')) {
                    return {};
                }
                throw new RpcError(-32601, `Method not found: ${method}`);
        }
    }

    close(): void {
        this.client?.close();
    }
}

class RpcError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

/** Serves until stdin closes. Calls run one at a time, in order, as the console expects. */
export async function serve(options: ServeOptions): Promise<void> {
    if (options.config.passwordStdin) {
        throw usage('amcli mcp uses stdin for the protocol; set AMCLI_PASSWORD_FILE instead of --password-stdin');
    }
    const server = new McpServer(options);
    const send = (message: Raw) => process.stdout.write(JSON.stringify(message) + '\n');
    let queue = Promise.resolve();
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    process.stderr.write(`amcli ${VERSION} MCP server on stdio${options.readOnly ? ' (read-only)' : ''}\n`);
    for await (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        let message: Raw;
        try {
            message = JSON.parse(line) as Raw;
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            continue;
        }
        queue = queue.then(async () => {
            const reply = await server.handle(message);
            if (reply) {
                send(reply);
            }
        });
    }
    await queue;
    server.close();
}
