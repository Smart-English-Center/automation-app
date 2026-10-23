import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseRoot = path.join(repoRoot, "database", "selc");

function listSqlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSqlFiles(absolutePath);
    return entry.isFile() && absolutePath.endsWith(".sql") ? [absolutePath] : [];
  });
}

function scanSql(file, source) {
  const stack = [];
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] || "";

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = "";
      }
      continue;
    }

    if (singleQuoted) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === "'") {
      singleQuoted = true;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      continue;
    }
    if (character === "$") {
      const tag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] || "";
      if (tag) {
        dollarTag = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === "(") stack.push(index);
    if (character === ")") {
      if (!stack.length) throw new Error(`${file}: unmatched closing parenthesis at byte ${index}`);
      stack.pop();
    }
  }

  if (singleQuoted) throw new Error(`${file}: unterminated single-quoted string`);
  if (doubleQuoted) throw new Error(`${file}: unterminated quoted identifier`);
  if (blockCommentDepth > 0) throw new Error(`${file}: unterminated block comment`);
  if (dollarTag) throw new Error(`${file}: unterminated dollar quote ${dollarTag}`);
  if (stack.length) throw new Error(`${file}: ${stack.length} unmatched opening parenthesis/parentheses`);
}

const requestedRoots = process.argv.slice(2).map((value) => path.resolve(value));
const roots = requestedRoots.length ? requestedRoots : (fs.existsSync(supabaseRoot) ? [supabaseRoot] : []);
const files = [...new Set(roots.flatMap((root) => {
  if (!fs.existsSync(root)) throw new Error(`SQL path does not exist: ${root}`);
  const stat = fs.statSync(root);
  if (stat.isDirectory()) return listSqlFiles(root);
  if (stat.isFile() && root.endsWith(".sql")) return [root];
  throw new Error(`SQL path is neither a directory nor a .sql file: ${root}`);
}))].sort();
for (const file of files) scanSql(path.relative(repoRoot, file), fs.readFileSync(file, "utf8"));

console.log(JSON.stringify({ ok: true, checked_file_count: files.length }, null, 2));
