"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitExitInput = waitExitInput;
exports.findBegin = findBegin;
exports.findSentinel = findSentinel;
exports.locateEchoEnd = locateEchoEnd;
exports.extractExecOutput = extractExecOutput;
exports.echoSearchRows = echoSearchRows;
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Shell input for `exec --wait-exit`.
 *
 * The begin marker is assembled by printf at run time, so the echoed input never
 * contains it and output starts exactly on the row after it, however the line
 * editor drew the echo. The command runs inside `{ …\n}` so a trailing comment,
 * `;`, `&` or here-document cannot swallow or break the end sentinel, and `$?`
 * is the command's own exit status.
 */
function waitExitInput(command, token) {
    const marker = `PTYBRIDGE_DONE_${token}:`;
    return {
        input: `printf '%s_%s\\n' PTYBRIDGE_BEGIN ${token}; { ${command}\r}; echo ${marker}$?\r`,
        bounds: { begin: `PTYBRIDGE_BEGIN_${token}`, marker, tail: `${marker}$?` },
    };
}
/** Rows joined into logical lines: soft-wrapped rows are concatenated, hard breaks become '\n'. */
function joinLogical(rows, fromRow) {
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
    return { text, rowAt, colAt };
}
/** Index of the first row after the printed begin marker, or -1 if it has not been printed. */
function findBegin(rows, begin) {
    const { text, rowAt } = joinLogical(rows, 0);
    const index = text.indexOf(begin);
    return index < 0 ? -1 : rowAt[index + begin.length - 1] + 1;
}
/**
 * Find the printed sentinel `${marker}<exit code>` at or after `fromRow`. Soft-wrapped
 * rows are joined first, so a sentinel split by the terminal width still matches.
 */
function findSentinel(rows, fromRow, marker) {
    const { text, rowAt, colAt } = joinLogical(rows, fromRow);
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
 * Locate the end of the echoed input. Rows are searched as one whitespace-free
 * string, so soft wraps, line-editor wraps and trimmed trailing spaces do not hide
 * the echo. Returns the index of the first row after the echo, or -1.
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
    if (index < 0)
        return -1;
    const end = rowAt[index + needle.length - 1] + 1;
    let body = end;
    // Output starts on a fresh row after Enter, never on a soft-wrap continuation.
    while (body < rows.length && rows[body].wrapped)
        body++;
    // An echo that exactly fills its row can leave one erased forced-wrap row (zsh).
    if (body === end && rows[end - 1]?.full && body < rows.length - 1 && rows[body].text === '')
        body++;
    return body;
}
/**
 * Return only what a command printed. With a begin marker the output starts on the
 * row after it; otherwise after the located echo, else at `defaultBodyRow`. With a
 * sentinel, output stops before it; text printed in front of the sentinel on its row
 * (output without a trailing newline) is kept, and the prompt redrawn after it is not.
 */
function extractExecOutput(rows, defaultBodyRow, bounds) {
    let bodyRow = -1;
    if (bounds?.begin)
        bodyRow = findBegin(rows, bounds.begin);
    if (bodyRow < 0 && bounds?.tail)
        bodyRow = locateEchoEnd(rows, bounds.tail, bounds.rows ?? rows.length);
    if (bodyRow < 0)
        bodyRow = Math.min(Math.max(0, defaultBodyRow), rows.length);
    let stop = rows.length;
    let partial = '';
    let matched = false;
    let exitCode;
    if (bounds?.marker) {
        const found = findSentinel(rows, bodyRow, bounds.marker);
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
