import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const sourceRoots = [join(root, "src"), join(root, "scripts")];
const files = [];

for (const sourceRoot of sourceRoots) {
  await collectJavaScriptFiles_(sourceRoot, files);
}

for (const file of files.sort()) {
  const result = await runNodeCheck_(file);
  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.code || 1);
  }
}

console.log(JSON.stringify({
  ok: true,
  checked_file_count: files.length,
  files: files.map((file) => relative(root, file))
}, null, 2));

async function collectJavaScriptFiles_(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectJavaScriptFiles_(path, output);
    else if (extname(entry.name) === ".js") output.push(path);
  }
}

function runNodeCheck_(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", file], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
