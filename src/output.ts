import { CliError } from './errors.ts';
import { redact } from './redact.ts';

/** Results go to stdout as JSON; errors go to stderr as JSON. Nothing else is written to either. */
export interface OutputOptions {
    revealSecrets: boolean;
    compact: boolean;
}

export function print(result: unknown, options: OutputOptions): void {
    const value = options.revealSecrets ? result : redact(result);
    process.stdout.write(JSON.stringify(value, null, options.compact ? 0 : 2) + '\n');
}

export function printError(error: unknown, compact = false): number {
    const failure = error instanceof CliError
        ? error
        : new CliError('ERROR', error instanceof Error ? error.message : String(error));
    const body: Record<string, unknown> = { code: failure.code, message: failure.message };
    if (failure.status !== undefined) {
        body.status = failure.status;
    }
    if (failure.details !== undefined) {
        body.details = redact(failure.details);
    }
    process.stderr.write(JSON.stringify({ error: body }, null, compact ? 0 : 2) + '\n');
    return failure.exitCode;
}

/** Progress for long operations, on stderr so stdout stays one JSON document. */
export function progress(message: string, quiet: boolean): void {
    if (!quiet) {
        process.stderr.write(`${message}\n`);
    }
}
