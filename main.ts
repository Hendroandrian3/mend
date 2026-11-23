// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. The whole contract is
// SPEC.md in the kit's starter; this file implements it, sections 1 to 10.
//
// Node 22 (and later), the standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** What an edit needs besides the tree: --strict, and the moves it made, for the R lines. */
interface Cx {
  strict: boolean;
  moves: Array<[string, string]>;
}

type Edit = (tree: Tree, cx: Cx) => void;

/* Matching lines (SPEC.md section 5). */

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const normLine = (s: string, tier: number): string => {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

const tiersOf = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** Every 0-based position at which O occurs in lines at tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = O.length;
  for (let i = from; i + n <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (normLine(O[j]!, tier) !== normLine(lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at or after `from`. */
function pickTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tiersOf(strict)) {
    const positions = occurrences(O, lines, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * At tier 2 a new line that is not empty, not only whitespace, and starts
 * with P (the leading spaces/tabs of O's first line) has that P replaced by
 * F (the leading spaces/tabs of the file's first matched line). At tiers 0
 * and 1, and for any other line, it is written as it is.
 */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Build the replacement for a hunk/chunk body: context lines as the file's own, `+` lines re-indented. */
function replacement(body: BodyLine[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const f = leadWs(fileLines[at] ?? '');
  const p = leadWs(oFirst);
  const out: string[] = [];
  let oPos = at;
  for (const e of body) {
    if (e.kind === ' ') {
      out.push(fileLines[oPos]!);
      oPos += 1;
    } else if (e.kind === '-') {
      oPos += 1;
    } else if (e.kind === '+') {
      out.push(reindent(e.text, tier, f, p));
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: its marker, its text after the marker, and whether a `\` line follows it. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the patch line itself was empty (a context line with empty text); trailing ones end a unified body. */
  rawEmpty: boolean;
  backslash: boolean;
}

function bodyLine(kind: ' ' | '-' | '+' | '\\', text: string, rawEmpty: boolean): BodyLine {
  return { kind, text, rawEmpty, backslash: false };
}

/* Detecting the format (section 4). */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* JSON edits (section 9). */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Unified diffs (section 6). */

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: string[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, surrounding spaces removed. */
const dashPath = (line: string): string => line.slice(4).split('\t')[0]!.trim();

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

interface HunkBody {
  body: BodyLine[];
  next: number;
}

/** The hunk body after its header: lines starting with ` `, `-`, `+` or `\`, or empty ones. */
function parseHunkBody(lines: string[], start: number): HunkBody {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push(bodyLine(' ', '', true));
      j += 1;
    } else if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      body.push(bodyLine(l[0] as ' ' | '-' | '+', l.slice(1), false));
      j += 1;
    } else if (l[0] === '\\') {
      if (body.length > 0) body[body.length - 1]!.backslash = true;
      j += 1;
    } else {
      break;
    }
  }
  // An empty line a `\` line follows is not at the end of the body: the `\` line is a body line after it.
  while (body.length > 0 && body[body.length - 1]!.rawEmpty && !body[body.length - 1]!.backslash) body.pop();
  return { body, next: j };
}

function newSection(diffOld: string | null, diffNew: string | null, pairOld: string | null, pairNew: string | null): Section {
  return { diffOld, diffNew, dashOld: pairOld, dashNew: pairNew, renOld: null, renNew: null, create: false, del: false, hunks: [] };
}

function hunkOf(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  for (const e of body) {
    if (e.kind === ' ' || e.kind === '-') o.push(e.text);
    if (e.kind === ' ' || e.kind === '+') n.push(e.text);
  }
  return { a, body, o, n };
}

/** The hunk's last context or `+` line, if it has one. */
function lastContextOrPlus(h: Hunk): BodyLine | null {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const e = h.body[i]!;
    if (e.kind === ' ' || e.kind === '+') return e;
  }
  return null;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let pairSeen = false;
  let seenHunk = false;
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    pairSeen = false;
    seenHunk = false;
  };
  const startWithPair = (oldP: string, newP: string): void => {
    push();
    cur = newSection(null, null, oldP, newP);
    pairSeen = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const [x, y] = parseDiffGit(line, i + 1);
        push();
        cur = newSection(x, y, null, null);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startWithPair(dashPath(line), dashPath(lines[i + 1]!));
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1;
      }
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('diff --git ')) {
        const [x, y] = parseDiffGit(line, i + 1);
        push();
        cur = newSection(x, y, null, null);
        i += 1;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!pairSeen) {
            cur.dashOld = dashPath(line);
            cur.dashNew = dashPath(lines[i + 1]!);
            pairSeen = true;
          } else {
            startWithPair(dashPath(line), dashPath(lines[i + 1]!));
          }
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        i += 1;
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i + 1);
        const { body, next } = parseHunkBody(lines, i + 1);
        cur.hunks.push(hunkOf(a, body));
        seenHunk = true;
        i = next;
      } else if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        i += 1;
      } else if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        i += 1;
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i + 1);
      push();
      cur = newSection(x, y, null, null);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startWithPair(dashPath(line), dashPath(lines[i + 1]!));
      i += 2;
    } else if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i + 1);
      const { body, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push(hunkOf(a, body));
      i = next;
    } else {
      i += 1;
    }
  }
  push();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec));
}

/** Apply a section's hunks in order to a file's text. */
function applyHunksToText(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const ins = h.body.filter((e) => e.kind === '+').map((e) => e.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (ins.length > 0 && atEnd) {
        const last = lastContextOrPlus(h);
        f.final = last === null ? true : !last.backslash;
      }
      d += h.n.length;
      continue;
    }
    const found = pickTier(h.o, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = replacement(h.body, f.lines, best, found.tier, h.o[0]!);
    const runsToEnd = best + h.o.length === f.lines.length;
    f.lines.splice(best, h.o.length, ...rep);
    if (runsToEnd) {
      const last = lastContextOrPlus(h);
      f.final = last === null ? true : !last.backslash;
    }
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

function unifiedSectionEdit(sec: Section): Edit {
  return (tree, cx) => {
    const oldPath = stripAB(sec.dashOld ?? sec.renOld ?? sec.diffOld ?? '');
    const newPath = stripAB(sec.dashNew ?? sec.renNew ?? sec.diffNew ?? '');
    const isCreate = oldPath === '/dev/null' || sec.create;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.del);
    if (isCreate) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastBackslash = false;
      for (const h of sec.hunks) {
        for (const e of h.body) {
          if (e.kind === '+') {
            plus.push(e.text);
            lastBackslash = e.backslash;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(newPath, applyHunksToText(before, sec.hunks, cx.strict, oldPath));
      tree.now.set(oldPath, null);
      cx.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunksToText(before, sec.hunks, cx.strict, oldPath));
  };
}

/* SEARCH/REPLACE blocks (section 7). */

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, cx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = pickTier(oldLines, f.lines, 0, cx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rep = newLines.map((l) => reindent(l, found.tier, leadWs(f.lines[pos]!), leadWs(oldLines[0]!)));
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep)));
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* V4A patches (section 8). */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
  o: string[];
  n: string[];
}

function v4aChunkOf(anchor: string | null, eof: boolean, body: BodyLine[]): V4aChunk {
  const o: string[] = [];
  const n: string[] = [];
  for (const e of body) {
    if (e.kind === ' ' || e.kind === '-') o.push(e.text);
    if (e.kind === ' ' || e.kind === '+') n.push(e.text);
  }
  return { anchor, eof, body, o, n };
}

interface SectionLines {
  /** The section's lines with their 1-based patch line numbers, trailing blank lines removed. */
  body: Array<[string, number]>;
  next: number;
}

/** A section's lines: up to the next section header or `*** End Patch`. */
function v4aSectionLines(lines: string[], start: number, end: number): SectionLines {
  const body: Array<[string, number]> = [];
  let j = start;
  while (j < end) {
    const l = lines[j]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    body.push([l, j + 1]);
    j += 1;
  }
  while (body.length > 0 && blank(body[body.length - 1]![0])) body.pop();
  return { body, next: j };
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return (tree, cx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let idx = -1;
        for (const tier of tiersOf(cx.strict)) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (normLine(f.lines[k]!, tier) === normLine(ch.anchor!, tier)) {
              idx = k;
              break;
            }
          }
          if (idx >= 0) break;
        }
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = ch.body.filter((e) => e.kind === '+').map((e) => e.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (const tier of tiersOf(cx.strict)) {
        const positions = occurrences(ch.o, f.lines, tier, cursor);
        const cand = ch.eof ? positions.filter((p) => p + ch.o.length === f.lines.length) : positions;
        if (cand.length > 0) {
          found = { tier, pos: cand[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = replacement(ch.body, f.lines, found.pos, found.tier, ch.o[0]!);
      f.lines.splice(found.pos, ch.o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      cx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const { body, next } = v4aSectionLines(lines, i + 1, last);
      for (const [ln, no] of body) {
        if (!(ln.startsWith('+') || ln === '')) throw new Exit2(`error: parse ${no}`);
      }
      edits.push(v4aAddEdit(path, body.map(([ln]) => (ln === '' ? '' : ln.slice(1)))));
      i = next;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      const { body, next } = v4aSectionLines(lines, i + 1, last);
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]![1]}`);
      edits.push(v4aDeleteEdit(path));
      i = next;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      const { body, next } = v4aSectionLines(lines, i + 1, last);
      let moveTo: string | null = null;
      let at = 0;
      if (body.length > 0 && body[0]![0].startsWith('*** Move to: ')) {
        moveTo = body[0]![0].slice(13).trim();
        at = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
      let started = false;
      const finish = (): void => {
        if (cur !== null) {
          chunks.push(v4aChunkOf(cur.anchor, cur.eof, cur.body));
          cur = null;
        }
      };
      for (; at < body.length; at += 1) {
        const [ln, no] = body[at]!;
        if (ln.startsWith('@@')) {
          finish();
          cur = { anchor: ln.slice(2).trim(), eof: false, body: [] };
          started = true;
        } else if (ln === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          finish();
        } else if (ln === '' || ln[0] === ' ' || ln[0] === '-' || ln[0] === '+') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(bodyLine(ln === '' ? ' ' : (ln[0] as ' ' | '-' | '+'), ln === '' ? '' : ln.slice(1), ln === ''));
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      finish();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
      i = next;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* Running the CLI (sections 1, 2 and 10). */

function parsePatch(kind: string, lines: string[], text: string): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return unifiedEdits(lines);
  if (kind === 'search-replace') return srEdits(lines);
  return v4aEdits(lines);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, lines, text);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const cx: Cx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, cx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of cx.moves) {
    const dIdx = rows.findIndex((r) => r.text === `D ${oldP}`);
    const aIdx = rows.findIndex((r) => r.text === `A ${newP}`);
    if (dIdx >= 0 && aIdx >= 0) {
      rows.splice(Math.max(dIdx, aIdx), 1);
      rows.splice(Math.min(dIdx, aIdx), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
