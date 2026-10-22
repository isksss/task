import migration from "../migrations/0002_v1.sql?raw";

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let trigger = false;
  for (const line of sql.split(/\r?\n/).filter((part) => part.trim())) {
    if (current.length === 0 && /^CREATE TRIGGER\b/i.test(line.trim())) trigger = true;
    current.push(line);
    const complete = trigger ? line.trim().toUpperCase() === "END;" : line.includes(";");
    if (complete) {
      statements.push(current.join("\n").trim());
      current = [];
      trigger = false;
    }
  }
  return statements.filter(Boolean);
}

export async function applySchema(db: D1Database): Promise<void> {
  for (const statement of migrationStatements(migration)) {
    await db.prepare(statement).run();
  }
}

let localSchema: Promise<void> | undefined;

export function ensureLocalSchema(db: D1Database): Promise<void> {
  if (!localSchema) {
    localSchema = applySchema(db).catch((error) => {
      localSchema = undefined;
      throw error;
    });
  }
  return localSchema;
}
