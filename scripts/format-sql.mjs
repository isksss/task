import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "sql-formatter";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = JSON.parse(readFileSync(resolve(root, ".sql-formatter.json"), "utf8"));
const check = process.argv.includes("--check");
// Keep schema.ts's bare-END trigger splitting and one-line ALTER matcher working.
const formatSql = (sql) => {
  const lines = format(sql, options).split("\n");
  let inTrigger = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^CREATE TRIGGER\b/i.test(lines[i])) inTrigger = true;
    else if (inTrigger && /^END;\s*$/i.test(lines[i])) inTrigger = false;
    else if (inTrigger && /^\s+END;\s*$/i.test(lines[i])) {
      let previous = i - 1;
      while (previous >= 0 && (!lines[previous] || !lines[previous].trim())) previous--;
      lines[previous] += ` ${lines[i].trim()}`;
      lines[i] = null;
    }
  }
  return lines
    .filter((line) => line !== null)
    .join("\n")
    .replace(/^ALTER TABLE (\w+)\nADD COLUMN /gm, "ALTER TABLE $1 ADD COLUMN ");
};
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.sql"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file && existsSync(resolve(root, file)));
let unformatted = false;

for (const file of files) {
  const path = resolve(root, file);
  const original = readFileSync(path, "utf8");
  const formatted = formatSql(original);
  if (formatted === original) continue;
  if (check) {
    console.error(`${file} is not formatted`);
    unformatted = true;
  } else {
    writeFileSync(path, formatted);
  }
}

if (unformatted) process.exitCode = 1;
