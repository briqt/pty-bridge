"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RawOutputBuffer = void 0;
exports.renderedCursor = renderedCursor;
const protocol_1 = require("./protocol");
/** A raw cursor is an absolute UTF-8 byte offset, including evicted bytes. */
class RawOutputBuffer {
    capacity;
    data = Buffer.alloc(0);
    base = 0;
    next = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    get end() { return this.base + this.data.length; }
    append(text) {
        this.data = Buffer.concat([this.data, Buffer.from(text, 'utf8')]);
        let drop = Math.max(0, this.data.length - this.capacity);
        // Never retain the trailing bytes of a partially evicted character.
        while (drop < this.data.length && (this.data[drop] & 0xc0) === 0x80)
            drop++;
        if (drop) {
            this.data = this.data.subarray(drop);
            this.base += drop;
        }
    }
    read(options = {}) {
        const requested = options.since ?? (options.last != null ? Math.max(0, this.end - options.last) : this.next);
        let start = Math.min(this.end, Math.max(this.base, requested));
        let offset = start - this.base;
        while (offset < this.data.length && (this.data[offset] & 0xc0) === 0x80) {
            offset++;
            start++;
        }
        const chunk = (0, protocol_1.truncateUtf8)(this.data.subarray(offset).toString('utf8'), options.maxBytes ?? 0);
        const cursor = start + chunk.returnedBytes;
        if (options.advance)
            this.next = cursor;
        return { ...chunk, startCursor: start, cursor, lostBytes: Math.max(0, this.base - requested) };
    }
}
exports.RawOutputBuffer = RawOutputBuffer;
/** Rendered cursors retain a byte column when a payload stops within a line. */
function renderedCursor(line, output, column = 0) {
    const pieces = output.split('\n');
    const nextLine = line + pieces.length - 1;
    const nextColumn = (pieces.length === 1 ? column : 0) + Buffer.byteLength(pieces[pieces.length - 1], 'utf8');
    return nextColumn ? `${nextLine}:${nextColumn}` : nextLine;
}
