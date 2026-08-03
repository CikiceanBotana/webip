/**
 * Durable, incremental output.
 *
 * The consolidated findings.json is assembled at the very end of a run. For a
 * 17-minute pilot that is fine; for the full 6,800-page sweep it is
 * all-or-nothing -- a crash in hour eleven loses eleven hours of work, and the
 * browser lane is exactly the kind of long, memory-hungry job that gets killed.
 *
 * So every finding is also appended to a JSONL file the moment it is produced.
 * One JSON value per line, so a truncated final line costs one record rather
 * than the file. If a run dies, `npm run analyze -- out/<dir>/stream.jsonl`
 * still reports everything up to the moment it died.
 *
 * This is a write-ahead log, not a second output format: the JSON remains the
 * deliverable.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Finding, PageCoverage } from './types.js';

export const STREAM_FILE = 'stream.jsonl';

/** One line of the log. Tagged so a reader can route without guessing. */
export type StreamRecord =
  | { type: 'finding'; finding: Finding }
  | { type: 'coverage'; coverage: PageCoverage }
  | { type: 'error'; message: string }
  | { type: 'meta'; startedAt: string; config: unknown };

export class RunStream {
  private constructor(
    private readonly out: WriteStream,
    readonly file: string,
  ) {}

  /** Opens (and truncates) the log for a fresh run. */
  static async open(outDir: string): Promise<RunStream> {
    await mkdir(outDir, { recursive: true });
    const file = path.join(outDir, STREAM_FILE);
    const out = createWriteStream(file, { flags: 'w' });
    // A stream error must never take down a scan: the log is insurance, not
    // the product. Losing it is bad; losing the run because of it is worse.
    out.on('error', () => undefined);
    return new RunStream(out, file);
  }

  write(record: StreamRecord): void {
    if (this.out.destroyed) return;
    this.out.write(`${JSON.stringify(record)}\n`);
  }

  findings(findings: readonly Finding[]): void {
    for (const finding of findings) this.write({ type: 'finding', finding });
  }

  coverage(entries: readonly PageCoverage[]): void {
    for (const coverage of entries) this.write({ type: 'coverage', coverage });
  }

  errors(messages: readonly string[]): void {
    for (const message of messages) this.write({ type: 'error', message });
  }

  /** Flushes and closes. Safe to call twice. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.out.destroyed) {
        resolve();
        return;
      }
      this.out.end(resolve);
    });
  }
}

/** Reads a stream log back into findings, for recovering a killed run. */
export function parseStream(text: string): {
  findings: Finding[];
  coverage: PageCoverage[];
  errors: string[];
} {
  const findings: Finding[] = [];
  const coverage: PageCoverage[] = [];
  const errors: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record: StreamRecord;
    try {
      record = JSON.parse(trimmed) as StreamRecord;
    } catch {
      // A killed process leaves a half-written final line. Skipping it is the
      // whole point of one-value-per-line.
      continue;
    }
    if (record.type === 'finding') findings.push(record.finding);
    else if (record.type === 'coverage') coverage.push(record.coverage);
    else if (record.type === 'error') errors.push(record.message);
  }

  return { findings, coverage, errors };
}
