import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, CI: "1" };
delete env.TASK_ALLOW_PRODUCTION_DEPLOY;

const result = spawnSync(
  join(root, "node_modules", ".bin", "cf"),
  ["build", "--mode", "production"],
  {
    cwd: join(root, "apps", "api"),
    env,
    encoding: "utf8",
    timeout: 30_000,
  },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

assert.equal(
  result.error,
  undefined,
  `cf build could not complete: ${result.error ?? "unknown error"}\n${output}`,
);
assert.notEqual(result.status, 0, `Production build unexpectedly succeeded.\n${output}`);
assert.match(
  output,
  /Production mode is disabled/,
  `Expected production guard message in output.\n${output}`,
);
console.log("Production mode guard rejected cf build without TASK_ALLOW_PRODUCTION_DEPLOY=1.");
