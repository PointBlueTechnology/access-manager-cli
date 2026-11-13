/**
 * Blanks secret values before anything is printed: authentication class properties such as a
 * recovery pepper, user store proxy passwords, keys and tokens. Names are matched loosely, so a
 * new secret property is hidden by default; plain flags ("true", "false") and numbers are shown,
 * so settings like SIGNAL_PASSWORD_MANAGERS stay readable.
 */
const SECRET_NAME = /pepper|passw|pwd|secret|token|credential|private.?key|api.?key|client.?key|salt|\bkey$/i;

export const REDACTED = '<redacted>';

function harmless(value: unknown): boolean {
    if (typeof value === 'boolean' || typeof value === 'number' || value === null || value === undefined) {
        return true;
    }
    return typeof value === 'string' && (value === '' || /^(true|false|-?\d+)$/i.test(value));
}

export function isSecretName(name: string): boolean {
    return SECRET_NAME.test(name);
}

export function redact<T>(value: T): T {
    return walk(value) as T;
}

function walk(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(walk);
    }
    if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        // {name, value} pairs, as contract properties and cluster options use
        if (typeof object.name === 'string' && 'value' in object && isSecretName(object.name) && !harmless(object.value)) {
            return { ...object, value: REDACTED };
        }
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(object)) {
            out[key] = isSecretName(key) && !harmless(inner) && typeof inner !== 'object' ? REDACTED : walk(inner);
        }
        return out;
    }
    return value;
}
