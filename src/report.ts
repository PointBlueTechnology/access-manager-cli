import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { usage } from './errors.ts';
import { contractRefs } from './saml.ts';
import { findAll, findFirst, parseXml } from './xml.ts';
import type { XmlElement } from './xml.ts';
import { readZip } from './zip.ts';
import type { Client } from './client.ts';

/**
 * What uses what: for each Identity Server cluster, which contracts use which methods, which
 * methods use which class and user stores, and which SAML providers and Access Gateway protected
 * resources use which contracts; and what nothing refers to. Built from an amcli export folder,
 * plus, for the Access Gateway, the console's own Code Promotion export, which is the only place
 * the APIs give a protected resource's contract and policies.
 */
type Raw = Record<string, unknown>;

export interface AgResource {
    agCluster: string;
    reverseProxy?: string;
    proxyService?: string;
    dnsName?: string;
    resource: string;
    enabled: boolean;
    urlPaths: string[];
    authProcedure?: string;
    contractUri?: string;
    contract?: string;
    policies: string[];
}

export interface ClusterReport {
    cluster: string;
    contracts: { name: string; uri?: string; cardId?: string; methods: string[]; usedBy: { samlServiceProviders: string[]; samlIdentityProviders: string[]; identityProviderCards: string[]; protectedResources: string[] } }[];
    methods: { name: string; class?: string; userStores: string[]; contracts: string[] }[];
    classes: { name: string; javaClass?: string; methods: string[] }[];
    samlServiceProviders: { name: string; entityId?: string; enabled?: boolean; contracts: string[] }[];
    samlIdentityProviders: { name: string; entityId?: string; enabled?: boolean; offeredIn: string[]; contracts: string[] }[];
    unused: { classes: string[]; methods: string[]; contracts: string[] };
}

export interface Report {
    source: string;
    accessGateway: 'included' | 'not included (use --ag)';
    clusters: ClusterReport[];
    protectedResources: AgResource[];
}

function readJson(file: string): Raw | Raw[] | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

function readDir(dir: string): Raw[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f)) as Raw).filter(Boolean);
}

function protectedResources(agCluster: string, xml: string): AgResource[] {
    const root = parseXml(xml);
    const procedures = new Map<string, { name?: string; contractUri?: string }>();
    for (const procedure of findAll(root, 'AuthenticationProcedure')) {
        const contract = findFirst(procedure, 'NIDPAuthentication')?.attrs.ContractName;
        procedures.set(procedure.attrs.AuthProcedureID, { name: procedure.attrs.Name, contractUri: contract ? decodeURIComponent(contract) : undefined });
    }
    const out: AgResource[] = [];
    const visit = (element: XmlElement, proxy?: XmlElement, service?: XmlElement) => {
        for (const child of element.children) {
            if (child.tag === 'HTTP_Reverse') {
                visit(child, child, undefined);
            } else if (child.tag === 'HTTP_HostSubservice') {
                visit(child, proxy, child);
            } else if (child.tag === 'ProtectedResource') {
                const ref = findFirst(child, 'AuthenticationProcedureRef')?.attrs.AuthProcedureIDRef;
                const procedure = ref ? procedures.get(ref) : undefined;
                const enforcement = findFirst(child, 'PolicyEnforcementList');
                out.push({
                    agCluster,
                    reverseProxy: proxy?.attrs.Name,
                    proxyService: service?.attrs.Name,
                    dnsName: service?.attrs.DNSName,
                    resource: child.attrs.Name,
                    enabled: child.attrs.Enable !== '0',
                    urlPaths: findAll(child, 'URLPath').map(p => p.attrs.URLPath ?? p.attrs.Path ?? Object.values(p.attrs)[0]).filter(Boolean),
                    authProcedure: procedure?.name ?? ref,
                    contractUri: procedure?.contractUri,
                    policies: (enforcement?.children ?? []).map(p => p.attrs.PolicyIDRef ?? p.attrs.PolicyID ?? p.attrs.Name ?? Object.values(p.attrs)[0]).filter(Boolean),
                });
            } else {
                visit(child, proxy, service);
            }
        }
    };
    visit(root);
    return out;
}

export function buildReport(exportDir: string, agConfigs: Map<string, string> | undefined): Report {
    const nps = path.join(exportDir, 'nps/api/v1/clusters');
    if (!fs.existsSync(path.join(exportDir, 'manifest.json')) || !fs.existsSync(nps)) {
        throw usage(`${exportDir} isn't an amcli export folder with the current API (nps) in it`);
    }
    const clusterNames = new Map<string, string>();
    const listed = readJson(path.join(nps, 'list.json')) as Raw | undefined;
    for (const item of ((listed?.clusterList as Raw[] | undefined) ?? [])) {
        clusterNames.set(String(item.id), String(item.nidsDisplayName ?? item.id));
    }
    const resources: AgResource[] = [];
    for (const [agCluster, xml] of agConfigs ?? []) {
        resources.push(...protectedResources(agCluster, xml));
    }

    const clusters: ClusterReport[] = [];
    for (const id of fs.readdirSync(nps).filter(d => fs.existsSync(path.join(nps, d, 'contracts')))) {
        const dir = path.join(nps, id);
        const contracts = readDir(path.join(dir, 'contracts'));
        const methods = readDir(path.join(dir, 'methods'));
        const classes = readDir(path.join(dir, 'classes'));
        const stores = readDir(path.join(dir, 'userstores'));
        const name = (list: Raw[], ref: unknown) => String(list.find(item => item.id === ref)?.nidsDisplayName ?? ref);

        const providers = (readJson(path.join(dir, 'saml2providers.json')) ?? {}) as Raw;
        const sps = ((providers.trustedSPList as Raw[] | undefined) ?? []).map(sp => {
            const detail = readJson(path.join(dir, 'saml2/sp', `${sp.id}.json`)) ?? {};
            const legacy = readJson(path.join(exportDir, 'amsvc/idpclusters', id, 'serviceproviders', `${sp.id}.json`)) ?? {};
            return { sp, refs: new Set([...contractRefs(detail), ...contractRefs(legacy)]) };
        });
        const idps = ((providers.trustedIDPList as Raw[] | undefined) ?? []).map(idp => {
            const detail = (readJson(path.join(dir, 'saml2/idp', `${idp.id}.json`)) ?? {}) as Raw;
            const offered = ((detail.authCardConfig as Raw | undefined)?.authContracts as string[] | undefined) ?? [];
            return { idp, offered, refs: contractRefs(detail).filter(ref => !offered.includes(ref)) };
        });

        const contractsReport = contracts.map(contract => {
            const uri = contract.nidsBaseURL as string | undefined;
            return {
                name: String(contract.nidsDisplayName),
                uri,
                cardId: contract.nidsCardID as string | undefined,
                methods: ((contract.nidsAuthMethodCNList as string[] | undefined) ?? []).map(ref => name(methods, ref)),
                usedBy: {
                    samlServiceProviders: sps.filter(s => s.refs.has(String(contract.id))).map(s => String(s.sp.nidsDisplayName)),
                    samlIdentityProviders: idps.filter(i => i.refs.includes(String(contract.id))).map(i => String(i.idp.nidsDisplayName)),
                    // An identity provider offered as a card in this contract: signing in here goes to it
                    identityProviderCards: idps.filter(i => i.offered.includes(String(contract.id))).map(i => String(i.idp.nidsDisplayName)),
                    protectedResources: resources.filter(r => r.contractUri !== undefined && r.contractUri === uri).map(r => `${r.proxyService ?? r.reverseProxy}/${r.resource}`),
                },
            };
        });
        for (const resource of resources) {
            resource.contract ??= contractsReport.find(c => c.uri === resource.contractUri)?.name;
        }
        const methodsReport = methods.map(method => ({
            name: String(method.nidsDisplayName),
            class: name(classes, method.nidsAuthClassCN),
            userStores: ((method.nidsAuthUserStoreCNList as string[] | undefined) ?? []).map(ref => name(stores, ref)),
            contracts: contracts.filter(c => ((c.nidsAuthMethodCNList as string[] | undefined) ?? []).includes(String(method.id))).map(c => String(c.nidsDisplayName)),
        }));
        const classesReport = classes.map(cls => ({
            name: String(cls.nidsDisplayName),
            javaClass: cls.nidsAuthJavaClassName as string | undefined,
            methods: methods.filter(m => m.nidsAuthClassCN === cls.id).map(m => String(m.nidsDisplayName)),
        }));
        const referenced = (contract: (typeof contractsReport)[number]) =>
            contract.usedBy.samlServiceProviders.length + contract.usedBy.samlIdentityProviders.length
            + contract.usedBy.identityProviderCards.length + contract.usedBy.protectedResources.length > 0;
        clusters.push({
            cluster: clusterNames.get(id) ?? id,
            contracts: contractsReport,
            methods: methodsReport,
            classes: classesReport,
            samlServiceProviders: sps.map(s => ({ name: String(s.sp.nidsDisplayName), entityId: s.sp.nidsProviderID as string | undefined, enabled: s.sp.nidsEnabled as boolean | undefined, contracts: [...s.refs].map(ref => name(contracts, ref)) })),
            samlIdentityProviders: idps.map(i => ({ name: String(i.idp.nidsDisplayName), entityId: i.idp.nidsProviderID as string | undefined, enabled: i.idp.nidsEnabled as boolean | undefined, offeredIn: i.offered.map(ref => name(contracts, ref)), contracts: i.refs.map(ref => name(contracts, ref)) })),
            unused: {
                classes: classesReport.filter(c => !c.methods.length).map(c => c.name),
                methods: methodsReport.filter(m => !m.contracts.length).map(m => m.name),
                contracts: contractsReport.filter(c => !referenced(c)).map(c => c.name),
            },
        });
    }
    return {
        source: path.resolve(exportDir),
        accessGateway: agConfigs ? 'included' : 'not included (use --ag)',
        clusters,
        protectedResources: resources,
    };
}

/**
 * The Access Gateway configuration from a Code Promotion export. The console keeps each export,
 * so this one is deleted again once it's read. The password only protects the file in transit.
 */
export async function accessGatewayConfigs(client: Client): Promise<Map<string, string>> {
    const password = crypto.randomBytes(24).toString('base64url');
    const tag = `amcli report ${crypto.randomBytes(6).toString('hex')}, deleted automatically`;
    const zip = await client.download('POST', '/api/v1/codepromotion', { exportIdp: false, exportAg: true, encryptionPassword: password, encryptionComments: tag });
    try {
        const configs = new Map<string, string>();
        for (const [name, content] of readZip(zip, password)) {
            const match = name.match(/agConfig\/(.+)_AgConfig\.xml$/);
            if (match) {
                configs.set(match[1], content.toString('utf8'));
            }
        }
        return configs;
    } finally {
        const page = (await client.get('/api/v1/codepromotion/exports?page=0&size=1000')) as Raw;
        const ours = ((page.content as Raw[] | undefined) ?? []).filter(e => e.comments === tag).map(e => String(e.configurationName));
        if (ours.length) {
            await client.request('DELETE', '/api/v1/codepromotion/delete', { filesToDelete: ours });
        }
    }
}

function cell(values: string[] | string | undefined): string {
    const text = Array.isArray(values) ? values.join(', ') : values ?? '';
    return (text || '—').replace(/\|/g, '\\|');
}

export function toMarkdown(report: Report): string {
    const lines: string[] = ['# Access Manager: what uses what', '', `From ${report.source}. Access Gateway: ${report.accessGateway}.`, ''];
    for (const cluster of report.clusters) {
        lines.push(`## ${cluster.cluster}`, '', '### Contracts', '', '| Contract | URI | Methods, in order | Used by |', '|---|---|---|---|');
        for (const c of cluster.contracts) {
            const used = [...c.usedBy.samlServiceProviders.map(n => `SP ${n}`), ...c.usedBy.samlIdentityProviders.map(n => `IdP ${n}`),
                ...c.usedBy.identityProviderCards.map(n => `IdP ${n} (its card)`), ...c.usedBy.protectedResources.map(n => `AG ${n}`)];
            lines.push(`| ${cell(c.name)} | ${cell(c.uri)} | ${cell(c.methods)} | ${cell(used)} |`);
        }
        lines.push('', '### Methods', '', '| Method | Class | User stores | In contracts |', '|---|---|---|---|');
        for (const m of cluster.methods) {
            lines.push(`| ${cell(m.name)} | ${cell(m.class)} | ${cell(m.userStores)} | ${cell(m.contracts)} |`);
        }
        lines.push('', '### Classes', '', '| Class | Java class | Methods |', '|---|---|---|');
        for (const c of cluster.classes) {
            lines.push(`| ${cell(c.name)} | ${cell(c.javaClass)} | ${cell(c.methods)} |`);
        }
        if (cluster.samlServiceProviders.length) {
            lines.push('', '### SAML service providers', '', '| Service provider | Entity ID | Contracts |', '|---|---|---|');
            for (const sp of cluster.samlServiceProviders) {
                lines.push(`| ${cell(sp.name)}${sp.enabled === false ? ' (disabled)' : ''} | ${cell(sp.entityId)} | ${cell(sp.contracts)} |`);
            }
        }
        if (cluster.samlIdentityProviders.length) {
            lines.push('', '### SAML identity providers', '', '| Identity provider | Entity ID | Offered as a card in | Other contracts |', '|---|---|---|---|');
            for (const idp of cluster.samlIdentityProviders) {
                lines.push(`| ${cell(idp.name)}${idp.enabled === false ? ' (disabled)' : ''} | ${cell(idp.entityId)} | ${cell(idp.offeredIn)} | ${cell(idp.contracts)} |`);
            }
        }
        lines.push('', '### Not referenced', '', `- Classes with no methods: ${cell(cluster.unused.classes)}`, `- Methods in no contract: ${cell(cluster.unused.methods)}`,
            `- Contracts no SAML provider${report.accessGateway === 'included' ? ' or protected resource' : ''} refers to: ${cell(cluster.unused.contracts)}`,
            '', 'Contracts can also be used directly by their URL or card ID, which no report can see.', '');
    }
    if (report.protectedResources.length) {
        lines.push('## Access Gateway protected resources', '', '| Cluster | Proxy service | Resource | URL paths | Contract | Policies |', '|---|---|---|---|---|---|');
        for (const r of report.protectedResources) {
            lines.push(`| ${cell(r.agCluster)} | ${cell(r.proxyService)}${r.dnsName ? ` (${r.dnsName})` : ''} | ${cell(r.resource)}${r.enabled ? '' : ' (disabled)'} | ${cell(r.urlPaths)} | ${cell(r.contract ?? r.contractUri ?? (r.authProcedure ? r.authProcedure : 'none (public)'))} | ${cell(r.policies)} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
