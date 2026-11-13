import { CliError, usage } from './errors.ts';
import { progress } from './output.ts';
import type { Nam } from './nam.ts';

/**
 * Applies the console's saved changes to the cluster's Identity Servers, as the console's
 * Update does: a "nidpreconfigure" device command with the chosen parts of the configuration.
 */
export const UPDATE_TYPES = ['all', 'logging', 'policy', 'afc'] as const;

export interface UpdateOptions {
    types: string[];
    wait: boolean;
    timeoutSec: number;
    quiet: boolean;
    pollMs?: number;
}

export async function runUpdate(nam: Nam, options: UpdateOptions): Promise<Record<string, unknown>> {
    for (const type of options.types) {
        if (!(UPDATE_TYPES as readonly string[]).includes(type)) {
            throw usage(`Unknown update type "${type}"; use ${UPDATE_TYPES.join(', ')}`);
        }
    }
    const before = await nam.clusterStatus();
    if (!before.servers.length) {
        throw new CliError('NOT_FOUND', `Cluster ${before.name} has no servers`);
    }
    const command = {
        cmdHandler: 'deviceCommand',
        actionCmd: 'nidpreconfigure',
        serverMap: { [before.id]: before.servers.map(server => server.deviceId) },
        reconfigureType: options.types.join(','),
    };
    const response = await nam.client.request('POST', '/api/v1/servers/action', command);
    progress(`Update sent to ${before.servers.map(s => s.ip ?? s.deviceId).join(', ')}`, options.quiet);
    if (!options.wait) {
        return { cluster: before.name, sent: command.reconfigureType, servers: before.servers.map(s => s.deviceId), response };
    }
    const after = await waitForCurrent(nam, options);
    return { cluster: after.name, sent: command.reconfigureType, updateStatus: after.updateStatus, healthStatus: after.healthStatus, servers: after.servers, pending: after.pending };
}

/** Waits until every server reports CURRENT again after having picked up the command. */
async function waitForCurrent(nam: Nam, options: UpdateOptions) {
    const pollMs = options.pollMs ?? 3000;
    const deadline = Date.now() + options.timeoutSec * 1000;
    const settle = Date.now() + 15000;
    let sawChange = false;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        const status = await nam.clusterStatus();
        const current = status.servers.every(server => server.updateStatus === 'CURRENT') && status.updateStatus !== 'UPDATING';
        if (!current) {
            sawChange = true;
            progress(`Updating: ${status.servers.map(s => `${s.ip ?? s.deviceId} ${s.updateStatus}`).join(', ')}`, options.quiet);
        }
        const nothingPending = !Object.values(status.pending ?? {}).some(Boolean);
        if (current && (sawChange || (Date.now() > settle && nothingPending))) {
            return status;
        }
        if (Date.now() > deadline) {
            throw new CliError('TIMEOUT', `Servers didn't report CURRENT within ${options.timeoutSec} s`, { details: status });
        }
    }
}
