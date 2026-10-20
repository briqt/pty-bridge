import { truncateUtf8 } from './protocol';

/** A raw cursor is an absolute UTF-8 byte offset, including evicted bytes. */
export class RawOutputBuffer {
  private data = Buffer.alloc(0);
  private base = 0;
  private next = 0;

  constructor(private readonly capacity: number) {}

  get end(): number { return this.base + this.data.length; }

  append(text: string): void {
    this.data = Buffer.concat([this.data, Buffer.from(text, 'utf8')]);
    let drop = Math.max(0, this.data.length - this.capacity);
    // Never retain the trailing bytes of a partially evicted character.
    while (drop < this.data.length && (this.data[drop] & 0xc0) === 0x80) drop++;
    if (drop) {
      this.data = this.data.subarray(drop);
      this.base += drop;
    }
  }

  read(options: { since?: number; last?: number; advance?: boolean; maxBytes?: number } = {}) {
    const requested = options.since ?? (options.last != null ? Math.max(0, this.end - options.last) : this.next);
    let start = Math.min(this.end, Math.max(this.base, requested));
    let offset = start - this.base;
    while (offset < this.data.length && (this.data[offset] & 0xc0) === 0x80) { offset++; start++; }
    const chunk = truncateUtf8(this.data.subarray(offset).toString('utf8'), options.maxBytes ?? 0);
    const cursor = start + chunk.returnedBytes;
    if (options.advance) this.next = cursor;
    return { ...chunk, startCursor: start, cursor, lostBytes: Math.max(0, this.base - requested) };
  }
}

/** Rendered cursors retain a byte column when a payload stops within a line. */
export function renderedCursor(line: number, output: string, column = 0): number | string {
  const pieces = output.split('\n');
  const nextLine = line + pieces.length - 1;
  const nextColumn = (pieces.length === 1 ? column : 0) + Buffer.byteLength(pieces[pieces.length - 1], 'utf8');
  return nextColumn ? `${nextLine}:${nextColumn}` : nextLine;
}
