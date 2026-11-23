# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one written
contract (SPEC.md in the kit's starter):

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines an edit names at the first of three matching tiers
(exact, trailing whitespace ignored, indentation ignored), and changes every
file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file; absent or `-` reads standard input.
- `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`,
  `json`); `auto`, the default, detects it.
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 lists every edit that failed and ends with
`failed: <k> of <n> edits`; nothing is written. Exit 2 reports a usage,
missing-patch, format, or parse error.

Node 22 (or later) and its standard library alone; no install step.

## Files

- `main.ts`: the CLI.
- `runner.ts`: the kit's runner, kept as it is; in a trial it reads the
  checks from the env and runs `main.ts` on each one.

## Practice

The kit's practice set: **100 of 100 passed, practice score 1000**
(`node check.ts ../program/generator/practice.json`, run from a scratch
directory beside this repository).
