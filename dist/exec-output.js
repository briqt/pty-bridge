"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.locateEchoEnd = locateEchoEnd;
exports.findSentinel = findSentinel;
exports.extractExecOutput = extractExecOutput;
exports.echoSearchRows = echoSearchRows;
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Locate the end of the shell's echo of submitted input. Rows are searched as one
 * whitespace-free string, so soft wraps, forced line-editor wraps and trimmed
 * trailing spaces do not hide the echo. Returns the index of the first row after
 * the echo, or -1 when the echo is not visible within `maxRows`.
 */
function locateEchoEnd(rows, tail, maxRows = rows.length) {
    const needle = tail.replace(/\s+/g, '');
    if (!needle)
        return -1;
    let text = '';
    const rowAt = [];
    const limit = Math.min(rows.length, maxRows);
    for (let r = 0; r < limit; r++) {
        for (const ch of rows[r].text) {
            if (/\s/.test(ch))
                continue;
            text += ch;
            for (let k = 0; k < ch.length; k++)
                rowAt.push(r);
        }
    }
    const index = text.indexOf(needle);
    return index < 0 ? -1 : rowAt[index + needle.length - 1] + 1;
}
/**
 * Find the printed sentinel `${marker}<exit code>` at or after `fromRow`. Soft-wrapped
 * rows are joined first, so a sentinel split by the terminal width still matches.
 */
function findSentinel(rows, fromRow, marker) {
    let text = '';
    const rowAt = [];
    const colAt = [];
    const start = Math.max(0, fromRow);
    for (let r = start; r < rows.length; r++) {
        if (r > start && !rows[r].wrapped) {
            text += '\n';
            rowAt.push(r);
            colAt.push(-1);
        }
        const t = rows[r].text;
        for (let i = 0; i < t.length; i++) {
            rowAt.push(r);
            colAt.push(i);
        }
        text += t;
    }
    const match = new RegExp(`${escapeRegExp(marker)}(\\d+)`).exec(text);
    if (!match)
        return null;
    return {
        row: rowAt[match.index],
        col: colAt[match.index],
        exitCode: parseInt(match[1], 10),
        atEnd: match.index + match[0].length >= text.length,
    };
}
/**
 * Return only what a command printed: drop the echoed input (which may span
 * several wrapped rows) and, when a sentinel is present, the sentinel itself and
 * the prompt redrawn after it. Text printed before the sentinel on its own row
 * (output without a trailing newline) is kept.
 *
 * `defaultBodyRow` is used when the echo cannot be located.
 */
function extractExecOutput(rows, defaultBodyRow, echo) {
    let bodyRow = Math.min(Math.max(0, defaultBodyRow), rows.length);
    if (echo?.tail) {
        const end = locateEchoEnd(rows, echo.tail, echo.rows ?? rows.length);
        if (end >= 0)
            bodyRow = end;
    }
    let stop = rows.length;
    let partial = '';
    let matched = false;
    let exitCode;
    if (echo?.marker) {
        const found = findSentinel(rows, bodyRow, echo.marker);
        if (found) {
            matched = true;
            exitCode = found.exitCode;
            stop = found.row;
            partial = rows[found.row].text.slice(0, Math.max(0, found.col));
        }
    }
    const lines = rows.slice(bodyRow, stop).map(r => r.text);
    if (partial)
        lines.push(partial);
    return { output: lines.join('\n'), bodyRow, matched, exitCode };
}
/** Rows that may hold the echo of `command` typed after a prompt at `cols` columns. */
function echoSearchRows(command, cols) {
    const width = Math.max(1, cols);
    // Wide characters take two cells; over-estimating only widens the search window.
    return 2 + command.split('\n').reduce((n, line) => n + 1 + Math.floor((line.length * 2) / width), 0);
}
