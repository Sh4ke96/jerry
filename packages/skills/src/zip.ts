import zlib from 'node:zlib';
import { invalid } from './errors.js';

/**
 * A small, strict ZIP reader for skill archives (a .zip or .skill file, or a GitHub archive). It
 * reads the central directory, marks what a skill never needs (encryption, ZIP64, symlinks, odd
 * compression) and every unsafe name (absolute paths, "..", drive letters, alternate data streams),
 * and inflates an entry only when asked, never past its declared size. Nothing is written here.
 */

export interface ZipEntry {
  /** Forward slashes, as stored ("dir/" for directories). */
  name: string;
  directory: boolean;
  size: number;
  compressedSize: number;
  /**
   * Why the entry cannot be unpacked (unsafe name, link, encryption, unknown compression); null when
   * it can. The caller refuses it when the entry is part of the skill: an archive of a whole
   * repository may hold odd files elsewhere.
   */
  problem: string | null;
  /** The entry's bytes, checked against its size and CRC-32. */
  read(): Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNIX_HOST = 3;
/** Entries a repository archive may have at most. */
export const MAX_ZIP_ENTRIES = 50_000;

/** True when a stored name is safe to write below a directory. */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.replace(/\/$/, '').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes(':') && !/[<>"|?*\u0000-\u001f]/.test(segment) && !/[. ]$/.test(segment));
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw invalid('ZIP64 archives are not supported; a skill is small, pack it as a plain zip.');
  if (count > MAX_ZIP_ENTRIES) throw invalid(`The archive has ${count} entries; at most ${MAX_ZIP_ENTRIES} are read.`);
  if (centralOffset + centralSize > eocd) throw invalid('The archive is damaged (central directory out of range).');

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw invalid('The archive is damaged (bad central directory entry).');
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    // Bit 11: UTF-8 names; older tools write CP437, read here as Latin-1 (the name is checked either way).
    const name = (flags & 0x0800) !== 0 ? rawName.toString('utf8') : rawName.toString('latin1');
    offset += 46 + nameLength + extraLength + commentLength;

    const directory = name.endsWith('/');
    let problem: string | null = null;
    if (!isSafeEntryName(name)) problem = `The archive contains an unsafe path "${name.slice(0, 120)}" (absolute, "..", or characters Windows cannot store); nothing was unpacked.`;
    else if ((flags & 0x0001) !== 0) problem = `"${name}" in the archive is encrypted; encrypted archives are not supported.`;
    else if (madeBy >> 8 === UNIX_HOST && ((external >>> 16) & S_IFMT) === S_IFLNK) problem = `"${name}" in the archive is a symbolic link; skills may not contain links.`;
    else if (!directory && method !== 0 && method !== 8) problem = `"${name}" in the archive uses compression method ${method}; only stored and deflated files are supported.`;
    else if (compressedSize === 0xffffffff || size === 0xffffffff) problem = 'ZIP64 archives are not supported; a skill is small, pack it as a plain zip.';

    const location = { name, problem, method, crc, compressedSize, size, localOffset };
    entries.push({ name, directory, size, compressedSize, problem, read: () => readEntry(buffer, location) });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw invalid('This is not a zip file (no end of central directory).');
}

interface EntryLocation {
  name: string;
  problem: string | null;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function readEntry(buffer: Buffer, entry: EntryLocation): Buffer {
  const { name, localOffset } = entry;
  if (entry.problem !== null) throw invalid(entry.problem);
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw invalid(`The archive is damaged ("${name}": bad local header).`);
  const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw invalid(`The archive is damaged ("${name}" runs past its end).`);
  const raw = buffer.subarray(start, end);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else {
    try {
      // Never inflate past the declared size: a zip bomb stops here.
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch (error) {
      throw invalid(`"${name}" in the archive does not unpack (${(error as Error).message}).`);
    }
  }
  if (data.length !== entry.size) throw invalid(`"${name}" in the archive is ${data.length} bytes, not the ${entry.size} it declares.`);
  if (zlib.crc32(data) >>> 0 !== entry.crc >>> 0) throw invalid(`"${name}" in the archive fails its CRC check.`);
  return data;
}
