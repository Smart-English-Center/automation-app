import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

function clean_(value) {
  return String(value ?? "").trim();
}

export function getBuildInfo(environment = process.env) {
  const commitHash = clean_(environment.SLIPLANE_COMMIT_HASH);

  return {
    service: packageJson.name,
    package_version: packageJson.version,
    commit_hash: commitHash || null,
    commit_hash_available: Boolean(commitHash)
  };
}
