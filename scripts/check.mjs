#!/usr/bin/env node
// Static check with no dependencies: runs `node --check` on every .js/.mjs file under js/,
// scripts/ and tests/, and verifies that each relative import (`import ... from './x.js'`,
// `import './x.js'`, `export ... from './x.js'`) points at an existing file. Browsers need the
// exact path, extension included, so a typo here is a blank page there.
//
//   node scripts/check.mjs      prints "OK <n> files" and exits 0, or lists the problems and exits 1

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DIRS = ['js', 'scripts', 'tests'];

// Group 1 captures a specifier that starts with '.'; bare ones ('three', 'node:test') are skipped.
const IMPORT_FROM = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.[^'"]*)['"]/gm;
const IMPORT_BARE = /^[ \t]*import\s*['"](\.[^'"]*)['"]/gm;

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
  const source = readFileSync(file, 'utf8');
  for (const pattern of [IMPORT_FROM, IMPORT_BARE]) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!isFile(resolve(dirname(file), specifier))) {
        problems.push(`${show(file)}: import '${specifier}' does not resolve to a file`);
      }
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
