/**
 * A small XML reader for the console's own configuration files: elements and their attributes,
 * in order, with text and comments skipped. Not a general XML parser; enough to walk the Access
 * Gateway configuration without a dependency.
 */
export interface XmlElement {
    tag: string;
    attrs: Record<string, string>;
    children: XmlElement[];
}

function decode(value: string): string {
    return value
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

export function parseXml(text: string): XmlElement {
    const root: XmlElement = { tag: '#document', attrs: {}, children: [] };
    const stack: XmlElement[] = [root];
    const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
    const attr = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of text.matchAll(tag)) {
        const [, closing, name, attrText, selfClosing] = match;
        if (!name) {
            continue;
        }
        if (closing) {
            if (stack.length > 1) {
                stack.pop();
            }
            continue;
        }
        const element: XmlElement = { tag: name, attrs: {}, children: [] };
        for (const [, key, double, single] of (attrText ?? '').matchAll(attr)) {
            element.attrs[key] = decode(double ?? single ?? '');
        }
        stack[stack.length - 1].children.push(element);
        if (!selfClosing) {
            stack.push(element);
        }
    }
    return root;
}

/** Every element with this tag, at any depth */
export function findAll(element: XmlElement, tag: string): XmlElement[] {
    const out: XmlElement[] = [];
    const walk = (e: XmlElement) => {
        for (const child of e.children) {
            if (child.tag === tag) {
                out.push(child);
            }
            walk(child);
        }
    };
    walk(element);
    return out;
}

export function findFirst(element: XmlElement, tag: string): XmlElement | undefined {
    return findAll(element, tag)[0];
}
