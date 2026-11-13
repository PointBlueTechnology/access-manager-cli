import { usage } from './errors.ts';
import type { Nam } from './nam.ts';

/**
 * The CLI's own shapes for classes, methods and contracts: display names instead of console IDs,
 * and short field names. `apply` files use the same shapes.
 */
type Raw = Record<string, unknown>;
export type Properties = Record<string, string>;

export interface ClassSpec {
    name: string;
    javaClass: string;
    typeId?: number;
    properties?: Properties;
}

export interface MethodSpec {
    name: string;
    class: string;
    userStores?: string[];
    identifiesUser?: boolean;
    overwriteRealUser?: boolean;
    overwriteTempUser?: boolean;
    properties?: Properties;
}

export interface ContractSpec {
    name: string;
    uri: string;
    methods: string[];
    cardId?: string;
    cardText?: string;
    image?: string;
    timeout?: number;
    trustLevel?: number;
    allowProxying?: boolean;
    properties?: Properties;
}

/** How properties combine with what's already there. */
export interface PropertyChange {
    replace?: boolean;
    unset?: string[];
}

export function mergeProperties(existing: unknown, wanted: Properties | undefined, change: PropertyChange = {}): Properties {
    const base: Properties = change.replace ? {} : { ...((existing as Properties | undefined) ?? {}) };
    for (const [key, value] of Object.entries(wanted ?? {})) {
        base[key] = String(value);
    }
    for (const key of change.unset ?? []) {
        delete base[key];
    }
    return base;
}

function contractProperties(raw: unknown): Properties {
    const out: Properties = {};
    for (const item of Array.isArray(raw) ? raw : []) {
        if (item && typeof item === 'object' && 'name' in item) {
            out[String(item.name)] = String((item as Raw).value ?? '');
        }
    }
    return out;
}

function toOptionList(properties: Properties): Raw[] {
    return Object.entries(properties).map(([name, value]) => ({ name, value, type: 'string' }));
}

// ---- views ------------------------------------------------------------------------------------

export function classView(raw: Raw): Raw {
    return {
        id: raw.id,
        name: raw.nidsDisplayName,
        javaClass: raw.nidsAuthJavaClassName,
        typeId: raw.nidsAuthTypeID,
        properties: raw.nidsAuthClassProperties ?? {},
    };
}

export async function methodView(raw: Raw, nam: Nam): Promise<Raw> {
    const [cls] = await nam.names('class', [raw.nidsAuthClassCN]);
    return {
        id: raw.id,
        name: raw.nidsDisplayName,
        class: cls,
        userStores: await nam.names('userstore', raw.nidsAuthUserStoreCNList),
        identifiesUser: raw.nidsUseForIdentity,
        overwriteRealUser: raw.nidsOverWriteRealUser,
        overwriteTempUser: raw.nidsOverWriteTempUser,
        properties: raw.nidsAuthClassProperties ?? {},
    };
}

export async function contractView(raw: Raw, nam: Nam): Promise<Raw> {
    return {
        id: raw.id,
        name: raw.nidsDisplayName,
        uri: raw.nidsBaseURL,
        cardId: raw.nidsCardID,
        cardText: raw.nidsCardText,
        image: raw.nidsImageReference,
        timeout: raw.nidsACTimeout,
        trustLevel: raw.nidsTrustLevel,
        allowProxying: raw.nidsAuthAllowProxying,
        methods: await nam.names('method', raw.nidsAuthMethodCNList),
        properties: contractProperties(raw.nidsAuthContractProperties),
    };
}

// ---- request bodies -------------------------------------------------------------------------

export function classBody(spec: ClassSpec, existing: Raw | undefined, change: PropertyChange): Raw {
    if (!spec.javaClass && !existing) {
        throw usage(`Class "${spec.name}" needs its Java class (javaClass, --java-class)`);
    }
    return {
        ...(existing ?? {}),
        nidsDisplayName: spec.name,
        nidsAuthJavaClassName: spec.javaClass || existing?.nidsAuthJavaClassName,
        nidsAuthTypeID: spec.typeId ?? existing?.nidsAuthTypeID ?? 0,
        nidsAuthClassProperties: mergeProperties(existing?.nidsAuthClassProperties, spec.properties, change),
    };
}

export async function methodBody(spec: MethodSpec, existing: Raw | undefined, change: PropertyChange, nam: Nam): Promise<Raw> {
    if (!spec.class && !existing) {
        throw usage(`Method "${spec.name}" needs its class (class, --class)`);
    }
    const classId = spec.class ? (await nam.resolve('class', spec.class)).id : existing!.nidsAuthClassCN;
    const stores = spec.userStores ? await nam.ids('userstore', spec.userStores) : existing?.nidsAuthUserStoreCNList ?? [];
    return {
        ...(existing ?? {}),
        nidsDisplayName: spec.name,
        nidsAuthClassCN: classId,
        nidsAuthUserStoreCNList: stores,
        nidsUseForIdentity: spec.identifiesUser ?? existing?.nidsUseForIdentity ?? true,
        nidsOverWriteRealUser: spec.overwriteRealUser ?? existing?.nidsOverWriteRealUser ?? false,
        nidsOverWriteTempUser: spec.overwriteTempUser ?? existing?.nidsOverWriteTempUser ?? false,
        nidsAuthClassProperties: mergeProperties(existing?.nidsAuthClassProperties, spec.properties, change),
    };
}

export async function contractBody(spec: ContractSpec, existing: Raw | undefined, change: PropertyChange, nam: Nam): Promise<Raw> {
    if (!existing && (!spec.uri || !spec.methods?.length)) {
        throw usage(`Contract "${spec.name}" needs a URI (uri, --uri) and at least one method (methods, --methods)`);
    }
    const methods = spec.methods?.length ? await nam.ids('method', spec.methods) : existing!.nidsAuthMethodCNList;
    const properties = mergeProperties(contractProperties(existing?.nidsAuthContractProperties), spec.properties, change);
    return {
        nidsCardPassiveAuth: false,
        nidsCheckTrustLevels: false,
        nidsShowLoginRedirectUI: false,
        nidsShowPWDExpUI: false,
        nidsRequestedContext: 0,
        nidsAdvOnLoginDlg: true,
        nidsAllowableClassesList: [],
        ...(existing ?? {}),
        nidsDisplayName: spec.name,
        nidsBaseURL: spec.uri || existing?.nidsBaseURL,
        nidsAuthMethodCNList: methods,
        nidsCardID: spec.cardId ?? existing?.nidsCardID ?? spec.name,
        nidsCardText: spec.cardText ?? existing?.nidsCardText ?? spec.name,
        nidsImageReference: spec.image ?? existing?.nidsImageReference ?? 'AAFIDOU2F',
        nidsACTimeout: spec.timeout ?? existing?.nidsACTimeout ?? 60,
        nidsTrustLevel: spec.trustLevel ?? existing?.nidsTrustLevel ?? 0,
        nidsAuthAllowProxying: spec.allowProxying ?? existing?.nidsAuthAllowProxying ?? false,
        nidsAuthContractProperties: toOptionList(properties),
    };
}

/** The fields that differ between what's there and what would be sent, for plans and dry runs. */
export function changes(existing: Raw | undefined, body: Raw): Raw {
    const out: Raw = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'id') {
            continue;
        }
        if (JSON.stringify(normalize(existing?.[key])) !== JSON.stringify(normalize(value))) {
            out[key] = existing === undefined ? value : { from: existing[key], to: value };
        }
    }
    return out;
}

function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
    }
    return value;
}
