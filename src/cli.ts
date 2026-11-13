#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Client } from './client.ts';
import { COMMANDS, GLOBAL_OPTIONS, VERSION } from './commands.ts';
import type { Command, OptionSpec } from './commands.ts';
import { resolveConfig } from './config.ts';
import { CliError, usage } from './errors.ts';
import { Nam } from './nam.ts';
import { print, printError } from './output.ts';

/** Global options may come before the command too: amcli --env-file x class list */
function leadingGlobals(argv: string[]): number {
    let index = 0;
    while (index < argv.length && argv[index].startsWith('-')) {
        const token = argv[index];
        const name = token.replace(/^--?/, '').split('=')[0];
        const spec = GLOBAL_OPTIONS[name] ?? Object.values(GLOBAL_OPTIONS).find(o => o.short === name);
        if (!spec) {
            break;
        }
        index += spec.type === 'string' && !token.includes('=') ? 2 : 1;
    }
    return index;
}

function findCommand(argv: string[]): { command?: Command; rest: string[] } {
    const skip = leadingGlobals(argv);
    const words = [];
    for (const token of argv.slice(skip)) {
        if (token.startsWith('-')) {
            break;
        }
        words.push(token);
        if (words.length === 2) {
            break;
        }
    }
    for (let n = words.length; n > 0; n--) {
        const name = words.slice(0, n).join(' ');
        const command = COMMANDS.find(c => c.name === name);
        if (command) {
            return { command, rest: [...argv.slice(0, skip), ...argv.slice(skip + n)] };
        }
    }
    return { rest: argv };
}

function optionHelp(options: Record<string, OptionSpec>): string {
    return Object.entries(options)
        .map(([name, spec]) => {
            const short = spec.short ? `-${spec.short}, ` : '    ';
            const value = spec.type === 'string' ? ' <value>' : '';
            return `  ${short}--${name}${value}`.padEnd(36) + spec.description;
        })
        .join('\n');
}

function help(command?: Command): string {
    if (command) {
        return [
            `amcli ${command.name}${command.args ? ` ${command.args}` : ''}`,
            '',
            command.summary,
            '',
            command.options ? `Options:\n${optionHelp(command.options)}\n` : '',
            `Global options:\n${optionHelp(GLOBAL_OPTIONS)}`,
        ].join('\n');
    }
    const width = Math.max(...COMMANDS.map(c => `${c.name}${c.args ? ` ${c.args}` : ''}`.length)) + 4;
    return [
        `amcli ${VERSION}: OpenText Access Manager Admin Console from the command line`,
        '',
        'Usage: amcli <command> [options]. Output is JSON; run `amcli describe` for the machine-readable version of this help.',
        '',
        'Commands:',
        ...COMMANDS.map(c => `  ${`${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(width)}${c.summary}`),
        '',
        `Global options:\n${optionHelp(GLOBAL_OPTIONS)}`,
        '',
        'Settings: AMCLI_URL, AMCLI_USER, AMCLI_PASSWORD or AMCLI_PASSWORD_FILE, AMCLI_CA_FILE, AMCLI_CLUSTER (see `amcli describe`).',
    ].join('\n');
}

async function main(argv: string[]): Promise<number> {
    if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
        const { command } = findCommand(argv.slice(argv[0] === 'help' ? 1 : 0));
        process.stdout.write(help(command) + '\n');
        return 0;
    }
    if (argv[0] === '--version' || argv[0] === 'version') {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }
    const { command, rest } = findCommand(argv);
    if (!command) {
        throw usage(`Unknown command "${argv.filter(a => !a.startsWith('-')).slice(0, 2).join(' ')}"; run amcli help`);
    }
    let parsed;
    try {
        parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) }, allowPositionals: true, strict: true });
    } catch (error) {
        throw usage(`${(error as Error).message}. Run amcli help ${command.name}`);
    }
    const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
    if (values.help) {
        process.stdout.write(help(command) + '\n');
        return 0;
    }
    const output = { revealSecrets: values['reveal-secrets'] === true, compact: values.compact === true };
    let nam: Nam | undefined;
    try {
        const result = await command.run({
            nam: () => {
                if (!nam) {
                    const config = resolveConfig({
                        envFile: values['env-file'] as string | undefined,
                        url: values.url as string | undefined,
                        user: values.user as string | undefined,
                        cluster: values.cluster as string | undefined,
                        insecure: values.insecure === true ? true : undefined,
                        passwordStdin: values['password-stdin'] === true,
                    });
                    nam = new Nam(new Client(config), config.cluster);
                }
                return nam;
            },
            values,
            positionals: parsed.positionals,
            quiet: values.quiet === true,
        });
        print(result, { ...output, revealSecrets: output.revealSecrets || command.plain === true });
        return 0;
    } finally {
        nam?.client.close();
    }
}

main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    error => {
        process.exitCode = printError(error instanceof CliError || error instanceof Error ? error : new Error(String(error)));
    },
);
