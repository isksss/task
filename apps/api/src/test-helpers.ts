import { env } from "cloudflare:test";
import type { Env } from "./index";
import { applySchema } from "./schema";

const testDatabase = (env as unknown as { DB: D1Database }).DB;

export async function ensureTestSchema(): Promise<void> {
  await applySchema(testDatabase);
}

export function makeTestEnv(sub: string = crypto.randomUUID()): Env {
  return {
    ...(env as unknown as Env),
    AUTH_MODE: "test",
    DEPLOYMENT_ENV: "test",
    DEV_USER_SUB: sub,
  };
}

export function versioned<T>(v: T, ts = Date.now(), counter = 0) {
  return { v, hlc: { ts, counter, device_id: "test-device" } };
}

export function taskChange(fields: Record<string, ReturnType<typeof versioned>>, id: string = crypto.randomUUID()) {
  return { change_id: crypto.randomUUID(), entity: "task" as const, id, fields };
}

export function projectChange(fields: Record<string, ReturnType<typeof versioned>>, id = crypto.randomUUID()) {
  return { change_id: crypto.randomUUID(), entity: "project" as const, id, fields };
}
