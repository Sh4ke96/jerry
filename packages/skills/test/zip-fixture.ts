import zlib from 'node:zlib';

/** One entry of a test archive; names are written as given (unsafe ones included, on purpose). */
export interface FixtureEntry {
  name: string;
  data?: string | Buffer;
  /** A Unix symbolic link (its data is the target). */
  symlink?: boolean;
  /** Store instead of deflate. */
  stored?: boolean;
}

/** A minimal ZIP writer for tests: deflated or stored entries, UTF-8 names, optional Unix symlinks. */
export function makeZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const directory = entry.name.endsWith('/');
    const method = directory || entry.stored === true ? 0 : 8;
    const packed = method === 0 ? content : zlib.deflateRawSync(content);
    const crc = zlib.crc32(content) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.symlink === true ? 0o120777 : directory ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export const skillMd = (name: string | null, description = 'Turns PDFs into text.', body = '# Use\nRead the PDF and summarise it.\n'): string =>
  ['---', ...(name === null ? [] : [`name: ${name}`]), `description: ${description}`, '---', body].join('\n');
