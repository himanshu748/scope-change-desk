import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createRevision, renderRevision } from './core.js';

const MAX_JSON_BYTES = 1024 * 1024;

async function readJson(filePath, name) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`${name} must be a regular JSON file of at most 1 MiB.`);
    const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_JSON_BYTES) throw new Error(`${name} exceeds 1 MiB.`);
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${name} must contain valid UTF-8 JSON.`);
  }
}

export async function writeScopeRevision({ quotePath, changesPath, outputPath }) {
  if (![quotePath, changesPath, outputPath].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Explicit quote, changes, and output paths are required.');
  }
  const quote = await readJson(quotePath, 'Quote input');
  const changes = await readJson(changesPath, 'Changes input');
  const revision = createRevision(quote, changes);
  const artifact = renderRevision(revision, { quoteSource: path.resolve(quotePath), changeSource: path.resolve(changesPath) });
  const destination = path.resolve(outputPath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
    throw error;
  }
  try {
    await handle.writeFile(artifact, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    status: 'draft_created', outputPath: destination,
    currency: revision.currency, minorUnitDigits: revision.minorUnitDigits,
    originalTotalMinor: revision.originalTotalMinor,
    knownSubtotalMinor: revision.knownSubtotalMinor, knownDeltaMinor: revision.knownDeltaMinor,
    totalMinor: revision.totalMinor, deltaMinor: revision.deltaMinor,
    pricingResolved: revision.pricingResolved,
    unresolvedPricingCount: revision.pricingQuestions.length,
    scheduleStatus: revision.scheduleStatus, clientApproval: revision.clientApproval,
  };
}
