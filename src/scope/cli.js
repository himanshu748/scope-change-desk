#!/usr/bin/env node
import { writeScopeRevision } from './files.js';

const HELP = `Scope-change Desk: local website quote revision

Usage:
  node src/scope/cli.js revise --quote FILE --changes FILE --out FILE
  node src/scope/cli.js --help

Read an explicitly selected baseline quote and MANUALLY STRUCTURED client
changes, then write a new Markdown draft for review. Runs offline, without
AI inference, message interpretation, proposal sending, or client approval.

Inputs: UTF-8 JSON files, at most 1 MiB each.
Amounts: safe integer minor currency units; currency and decimal digits explicit.
Changes: add, remove, or set_quantity; one change per item.
Unknown added rates require a pricingQuestion and leave full totals unresolved.
Provided rate approval references are required for every explicit rate.
Output: new file only; existing files are never overwritten.
Exit codes: 0 = draft created/help shown; 1 = refused or failed.

See outputs/scope-README.md and work/scope/demo-2026-09-12 for the JSON schema
and a clearly labeled synthetic example: three website pages become five,
and checkout is added with an unknown rate.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) process.stdout.write(HELP);
  else {
    if (args[0] !== 'revise') throw new Error('Expected revise. Use --help for usage.');
    const options = {};
    for (let index = 1; index < args.length; index += 2) {
      const key = args[index];
      if (!['--quote', '--changes', '--out'].includes(key)) throw new Error(`Unknown option: ${key}`);
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${key}`);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key] = value;
    }
    for (const key of ['--quote', '--changes', '--out']) if (!options[key]) throw new Error(`Missing required option: ${key}`);
    const receipt = await writeScopeRevision({ quotePath: options['--quote'], changesPath: options['--changes'], outputPath: options['--out'] });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`Scope-change Desk: ${error.message}\n`);
  process.exitCode = 1;
}
