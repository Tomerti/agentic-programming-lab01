#!/usr/bin/env node
// Static check with no dependencies: runs `node --check` on every .js/.mjs file under js/,
// scripts/ and tests/, and verifies that each relative import (`import ... from './x.js'`,
// `import './x.js'`, `export ... from './x.js'`) points at an existing file, spelled with the
// exact case of every folder and file on disk. Browsers need the exact path, extension
// included, and GitHub Pages serves from Linux, where './Config.js' is not './config.js' even
// though Windows and macOS open either: a slip here is a blank page there.
//
// Comments are blanked out before the imports are looked for, so an import in a comment is
// not checked; a statement starts at the start of a line or after a `;`, so a second import
// on the same line is, but not where that line start or `;` lies inside a string, a template
// literal or a regular expression.
//
//   node scripts/check.mjs      prints "OK <n> files" and exits 0, or lists the problems and exits 1

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DIRS = ['js', 'scripts', 'tests'];

// Group 1 captures a specifier that starts with '.'; bare ones ('three', 'node:test') are skipped.
const IMPORT_FROM = /(?:^|;)[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.[^'"]*)['"]/gm;
const IMPORT_BARE = /(?:^|;)[ \t]*import\s*['"](\.[^'"]*)['"]/gm;

function* walk(dir) {
  if (!existsSync(dir)) return; // not created yet
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.m?js$/.test(entry.name)) yield path;
  }
}

const isFile = path => existsSync(path) && statSync(path).isFile();
const show = file => relative(root, file).replaceAll('\\', '/');

// The source with its comments blanked out, and where its literals lie. Each comment character becomes a space (a
// newline stays), so that everything keeps its offset. Strings, template literals and regular expression literals
// are copied whole, so that a quote, a // or a /* inside one starts nothing, and `literals` lists their spans as
// [start, end) offsets. A / starts a regular expression where an operand is due: at the start, or after one of
// ( , = : [ ! & | ? { } ; + - * % < > ~ ^ (a heuristic that the code here follows; `return /x/` would be misread,
// and only that line's comment blanking could suffer).
function scan(source) {
  let code = '';
  const literals = [];
  let last = ''; // the last character of code before this point, spaces and comments aside
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    let end = i + 1; // the end of the piece that starts at i
    if (c === '/' && (next === '*' || next === '/')) {
      const close = next === '*' ? source.indexOf('*/', i + 2) : source.indexOf('\n', i + 2);
      end = close < 0 ? source.length : close + (next === '*' ? 2 : 0);
      code += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      let inClass = false; // inside a regular expression's [...], where a / does not end it
      while (end < source.length) {
        const d = source[end];
        if (d === '\\') {
          end += 2; // an escaped character ends nothing
          continue;
        }
        if (d === '\n' && c !== '`') break; // a string or a regular expression ends with its line at the latest
        end += 1;
        if (c === '/' && (d === '[' || d === ']')) inClass = d === '[';
        else if (d === c && !inClass) break; // the closing quote, backtick or slash
      }
      end = Math.min(end, source.length);
      literals.push([i, end]);
    }
    code += source.slice(i, end);
    if (!/^\s$/.test(c)) last = source[end - 1];
    i = end;
  }
  return { code, literals };
}

// Whether offset `at` lies inside one of the literals: a `;` or a line start there begins no statement.
const insideLiteral = (literals, at) => literals.some(([start, end]) => start < at && at < end);

// The entries of each folder on disk, read once.
const listings = new Map();
const entriesOf = dir => {
  if (!listings.has(dir)) listings.set(dir, readdirSync(dir));
  return listings.get(dir);
};

// The repo-relative path of an existing `path` as it is spelled on disk, or null when it is spelled so already (or
// lies outside the repo, which is not ours to check).
function caseMismatch(path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  let dir = root;
  let wrong = false;
  const onDisk = rel.split(sep).map(segment => {
    const entries = entriesOf(dir);
    const actual = entries.includes(segment) ? segment
      : entries.find(entry => entry.toLowerCase() === segment.toLowerCase()) ?? segment;
    wrong ||= actual !== segment;
    dir = join(dir, actual);
    return actual;
  });
  return wrong ? onDisk.join('/') : null;
}

const files = DIRS.flatMap(dir => [...walk(join(root, dir))]).sort();
const problems = [];

for (const file of files) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) {
    const detail = (syntax.stderr || String(syntax.error)).split(/\r?\n/)
      .filter(line => !/^\s+at |^Node\.js v/.test(line)) // drop Node's internal stack frame and version
      .map(line => line && `  ${line}`).join('\n').trimEnd();
    problems.push(`${show(file)}: syntax check failed\n${detail}`);
  }
  const { code, literals } = scan(readFileSync(file, 'utf8'));
  for (const pattern of [IMPORT_FROM, IMPORT_BARE]) {
    for (const { index, 1: specifier } of code.matchAll(pattern)) {
      if (insideLiteral(literals, index)) continue; // text in a string, not a statement
      const target = resolve(dirname(file), specifier);
      if (!isFile(target)) {
        problems.push(`${show(file)}: import '${specifier}' does not resolve to a file`);
        continue;
      }
      const onDisk = caseMismatch(target);
      if (onDisk) problems.push(`${show(file)}: import '${specifier}' has a case mismatch: the file is ${onDisk}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`FAILED: ${problems.length} problem(s) in ${files.length} files`);
  process.exitCode = 1;
} else {
  console.log(`OK ${files.length} files`);
}
