import zlib from 'node:zlib';
import { CliError } from './errors.ts';

/**
 * Reads a zip file in memory, including entries protected with a password using traditional
 * PKWARE encryption ("ZipCrypto"), which is what the console's Code Promotion export uses. Stored
 * and deflated entries only; enough for the console's files, with no dependencies.
 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crcByte(crc: number, byte: number): number {
    return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

class ZipCrypto {
    private k0 = 0x12345678;
    private k1 = 0x23456789;
    private k2 = 0x34567890;

    constructor(password: string) {
        for (const byte of Buffer.from(password, 'utf8')) {
            this.update(byte);
        }
    }

    private update(byte: number): void {
        this.k0 = crcByte(this.k0, byte);
        this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
        this.k2 = crcByte(this.k2, this.k1 >>> 24);
    }

    decrypt(data: Buffer): Buffer {
        const out = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) {
            const temp = (this.k2 | 2) & 0xffff;
            const byte = data[i] ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
            this.update(byte);
            out[i] = byte;
        }
        return out;
    }
}

export function readZip(zip: Buffer, password?: string): Map<string, Buffer> {
    // The end of central directory record: the last "PK\x05\x06"
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) {
        throw new CliError('ERROR', 'Not a zip file');
    }
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const entries = new Map<string, Buffer>();
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new CliError('ERROR', 'Damaged zip file');
        }
        const flags = zip.readUInt16LE(offset + 8);
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const local = zip.readUInt32LE(offset + 42);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        offset += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) {
            continue;
        }
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        let data = zip.subarray(dataStart, dataStart + compressedSize);
        if (flags & 1) {
            if (!password) {
                throw new CliError('ERROR', `${name} in the zip needs a password`);
            }
            // The first 12 bytes are the encryption header
            data = new ZipCrypto(password).decrypt(data).subarray(12);
        }
        if (method === 8) {
            data = zlib.inflateRawSync(data);
        } else if (method !== 0) {
            throw new CliError('ERROR', `${name} in the zip uses compression method ${method}, which amcli can't read`);
        }
        entries.set(name, Buffer.from(data));
    }
    return entries;
}
