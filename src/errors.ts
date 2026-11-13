/**
 * Errors the CLI reports, each with a stable code and exit status so scripts and agents can act on
 * them without parsing messages.
 */
export const EXIT = {
    OK: 0,
    ERROR: 1,
    USAGE: 2,
    NOT_FOUND: 3,
    AUTH: 4,
    REJECTED: 5,
    CONNECTION: 6,
    TIMEOUT: 7,
    CONFIRM: 8,
    /** diff --exit-code: the two differ (not an error) */
    DIFFERENT: 9,
} as const;

export type ErrorCode = keyof typeof EXIT;

export class CliError extends Error {
    readonly code: ErrorCode;
    readonly status?: number;
    readonly details?: unknown;

    constructor(code: ErrorCode, message: string, options: { status?: number; details?: unknown } = {}) {
        super(message);
        this.code = code;
        this.status = options.status;
        this.details = options.details;
    }

    get exitCode(): number {
        return EXIT[this.code];
    }
}

export function usage(message: string): CliError {
    return new CliError('USAGE', message);
}
