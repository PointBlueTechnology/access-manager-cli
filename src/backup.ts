import fs from 'node:fs';
import path from 'node:path';
import { listCerts } from './certs.ts';
import type { Cert } from './certs.ts';
import { diffExports } from './diff.ts';
import type { DiffResult } from './diff.ts';
import { usage } from './errors.ts';
import { runExport } from './export.ts';
import { progress } from './output.ts';
import { buildReport, toMarkdown } from './report.ts';
import type { Nam } from './nam.ts';

/**
 * A backup run for a schedule: export the console into a new dated folder, compare it with the
 * previous backup, check certificate expiry, and remove the oldest backups beyond --keep. Each
 * backup is an ordinary export; what the run worked out is saved beside it in _backup/, which
 * diff leaves out.
 */
export interface BackupOptions {
    root: string;
    keep: number;
    expiringDays: number;
    /** Certificates not to report, such as expired ones nothing uses any more */
    ignoreCerts?: string[];
    apis: ('nps' | 'amsvc')[];
    afcFiles: boolean;
    revealSecrets: boolean;
    quiet: boolean;
    now?: Date;
}

/** 2026-11-16T03-00-00Z: sorts in time order and is a valid folder name everywhere */
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export function backupName(date: Date): string {
    return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/** The finished backups in a folder, oldest first */
export function listBackups(root: string): string[] {
    if (!fs.existsSync(root)) {
        return [];
    }
    return fs.readdirSync(root)
        .filter(name => NAME.test(name) && fs.existsSync(path.join(root, name, 'manifest.json')))
        .sort();
}

/** The backups to remove so that `keep` remain, oldest first; never the newest */
export function toPrune(names: string[], keep: number): string[] {
    return names.slice(0, Math.max(0, names.length - Math.max(1, keep)));
}

function summarize(diff: DiffResult) {
    return {
        same: diff.summary.same,
        changes: diff.summary.changes,
        changedFiles: diff.changed.map(f => f.file),
        addedFiles: diff.onlyInB,
        removedFiles: diff.onlyInA,
    };
}

function certSummary(cert: Cert) {
    return { name: cert.name, daysLeft: cert.daysLeft, validTo: cert.validTo, trustedRoot: cert.trustedRoot };
}

export async function runBackup(nam: Nam, options: BackupOptions) {
    const root = path.resolve(options.root);
    if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
        throw usage(`${options.root} isn't a folder`);
    }
    // Backups describe the whole setup even with secrets blanked, so the folder is yours alone
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const previous = listBackups(root).at(-1);
    const name = backupName(options.now ?? new Date());
    const target = path.join(root, name);
    if (fs.existsSync(target)) {
        throw usage(`${target} already exists; run again in a second`);
    }
    // Written under a temporary name and renamed when complete, so a failed run never counts as a backup
    const partial = `${target}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });

    progress(`Backing up the console to ${target}`, options.quiet);
    let exported: Record<string, unknown>;
    try {
        exported = await runExport(nam, {
            out: partial, apis: options.apis, runtime: false, afcFiles: options.afcFiles, revealSecrets: options.revealSecrets, quiet: true,
        });
    } catch (error) {
        fs.rmSync(partial, { recursive: true, force: true });
        throw error;
    }
    const meta = path.join(partial, '_backup');
    fs.mkdirSync(meta, { mode: options.revealSecrets ? 0o700 : 0o755 });
    const write = (file: string, text: string) => fs.writeFileSync(path.join(meta, file), text, { mode: options.revealSecrets ? 0o600 : 0o644 });

    // What uses what, for reference; a backup is still worth keeping if this can't be worked out
    let report: string;
    try {
        write('report.md', toMarkdown({ ...buildReport(partial, undefined), source: `the backup ${name}` }));
        report = '_backup/report.md';
    } catch (error) {
        report = `not written: ${(error as Error).message}`;
    }

    // Certificates expiring soon, from the console now
    let certs: { checked: number; expiring: ReturnType<typeof certSummary>[] } | { error: string };
    try {
        const all = await listCerts(nam.client, options.now);
        const ignored = new Set((options.ignoreCerts ?? []).map(n => n.toLowerCase()));
        certs = {
            checked: all.length,
            expiring: all.filter(c => c.daysLeft !== undefined && c.daysLeft <= options.expiringDays && !ignored.has(c.name.toLowerCase())).map(certSummary),
        };
    } catch (error) {
        certs = { error: (error as Error).message };
    }
    write('certs.json', JSON.stringify(certs, null, 2) + '\n');

    fs.renameSync(partial, target);

    // Compared after the rename, so the paths in the result are the backups' real ones
    let changes: ReturnType<typeof summarize> | undefined;
    if (previous) {
        const diff = diffExports(path.join(root, previous), target);
        fs.writeFileSync(path.join(target, '_backup', 'changes.json'), JSON.stringify(diff, null, 2) + '\n', { mode: options.revealSecrets ? 0o600 : 0o644 });
        changes = summarize(diff);
    }

    const removed = toPrune(listBackups(root), options.keep);
    for (const old of removed) {
        fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }

    const failed = Object.values(exported).reduce<number>((n, v) => n + (((v as { failed?: number } | undefined)?.failed) ?? 0), 0);
    const expiring = 'expiring' in certs ? certs.expiring.length : 0;
    const result = {
        backup: target,
        previous: previous ? path.join(root, previous) : undefined,
        changed: changes ? !changes.same : undefined,
        changes: changes ?? 'no earlier backup to compare with',
        certificates: certs,
        failedReads: failed,
        report,
        removed,
        kept: listBackups(root).length,
        redaction: exported.redaction,
    };
    fs.writeFileSync(path.join(target, '_backup', 'backup.json'), JSON.stringify(result, null, 2) + '\n', { mode: options.revealSecrets ? 0o600 : 0o644 });
    return { result, alert: Boolean(changes && !changes.same) || expiring > 0 || 'error' in certs };
}
