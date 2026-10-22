import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const apiDir = join(root, "apps", "api");
const cfBin = join(root, "node_modules", ".bin", "cf");
const databaseId = "00000000-0000-4000-8000-000000000000";
const timeoutMs = 90_000;
const portTimeoutMs = 30_000;
const controller = new AbortController();
const timeout = setTimeout(
  () => controller.abort(new Error(`Smoke test exceeded ${timeoutMs}ms`)),
  timeoutMs,
);
const abortOnSignal = (signal) => controller.abort(new Error(`Received ${signal}`));
const onSigint = () => abortOnSignal("SIGINT");
const onSigterm = () => abortOnSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !groupExists(pid);
}

async function stopGroup(child) {
  if (!child?.pid || !signalGroup(child.pid, "SIGTERM")) return;
  if (await waitForGroupExit(child.pid, 500)) return;
  signalGroup(child.pid, "SIGKILL");
  if (!(await waitForGroupExit(child.pid, 2_000))) {
    throw new Error(`Process group ${child.pid} did not exit`);
  }
}

function waitForExit(child, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, childSignal) => {
      cleanup();
      resolve({ code, signal: childSignal });
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function runCommand(command, args, cwd, signal) {
  signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  });
  try {
    const { code, signal: childSignal } = await waitForExit(child, signal);
    if (code !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed (${childSignal ?? code})`);
    }
  } finally {
    await stopGroup(child);
  }
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fetchSmoke(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function portIsOpen(port, signal) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const timer = setTimeout(() => finish(false), 500);
    const abort = () => finish(false);
    function finish(open) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(open);
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitForPort(port, child, signal) {
  const deadline = Date.now() + portTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("cf dev exited before opening its port");
    }
    if (await portIsOpen(port, signal)) return;
    await sleep(200, signal);
  }
  throw new Error(`cf dev did not open port ${port} within ${portTimeoutMs}ms`);
}

async function waitForHttpReady(url, child, signal) {
  const deadline = Date.now() + portTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("cf dev exited before becoming ready");
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
    }
    await sleep(200, signal);
  }
  throw new Error(`cf dev did not become HTTP-ready within ${portTimeoutMs}ms`);
}

let persistenceDir;
let server;
let phase = "setup";
try {
  persistenceDir = await mkdtemp(join(tmpdir(), "task-smoke-"));
  phase = "web build";
  await runCommand("pnpm", ["--filter", "@task/web", "build"], root, controller.signal);
  phase = "local D1 migrations";
  await runCommand(
    cfBin,
    [
      "d1",
      "migrations",
      "apply",
      databaseId,
      "--local",
      "--dir",
      "migrations",
      "--persist-to",
      persistenceDir,
      "--mode",
      "development",
    ],
    apiDir,
    controller.signal,
  );
  console.log("Local D1 migrations applied.");

  const port = await getFreePort();
  phase = "cf dev startup";
  console.log(`Starting cf dev on 127.0.0.1:${port}.`);
  server = spawn(
    cfBin,
    [
      "dev",
      "--mode",
      "development",
      "--persist-to",
      persistenceDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: apiDir,
      detached: true,
      env: { ...process.env, CI: "1" },
      stdio: "inherit",
    },
  );
  await new Promise((resolve, reject) => {
    server.once("spawn", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForPort(port, server, controller.signal);
  phase = "cf dev HTTP readiness";
  await waitForHttpReady(`${baseUrl}/`, server, controller.signal);
  console.log("cf dev is ready.");

  const page = await fetchSmoke(`${baseUrl}/`);
  const html = await page.text();
  assert.equal(page.status, 200, "GET / should return 200");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/i);
  assert.match(html, /<html[\s>]/i);
  assert.match(html, /<title>task<\/title>/);
  assert.match(html, /id="root"/);

  const health = await fetchSmoke(`${baseUrl}/api/health`);
  assert.equal(health.status, 200, "GET /api/health should return 200");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { ok: true });

  const missing = await fetchSmoke(`${baseUrl}/api/x`, { headers: { Accept: "text/html" } });
  assert.equal(missing.status, 404, "GET /api/x should return 404");
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), { error: "not_found" });

  console.log("Smoke test passed: app HTML, API health/cache policy, and JSON API 404.");
} catch (error) {
  if (controller.signal.aborted) console.error(`Smoke timed out during ${phase}.`);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await stopGroup(server);
  } finally {
    clearTimeout(timeout);
    try {
      if (persistenceDir) await rm(persistenceDir, { recursive: true, force: true });
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}
