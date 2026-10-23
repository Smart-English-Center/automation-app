import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['src', 'scripts', 'tests'];
const importPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g;

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(absolutePath);
    return entry.isFile() && absolutePath.endsWith('.js') ? [absolutePath] : [];
  });
}

function resolveLocalImport(importingFile, specifier) {
  const basePath = path.resolve(path.dirname(importingFile), specifier);
  const candidates = [basePath, `${basePath}.js`, path.join(basePath, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

const files = sourceRoots.flatMap((root) => listJavaScriptFiles(path.join(repoRoot, root)));
const missing = [];
let checkedImportCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    checkedImportCount += 1;
    const specifier = match[2];
    if (!resolveLocalImport(file, specifier)) {
      missing.push({
        file: path.relative(repoRoot, file),
        specifier,
      });
    }
  }
}

if (missing.length > 0) {
  console.error(JSON.stringify({ ok: false, checked_import_count: checkedImportCount, missing }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked_import_count: checkedImportCount }, null, 2));
}
