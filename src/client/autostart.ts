// Auto-start the ada backend if it isn't reachable. So new users running `ada` for the first time
// don't have to also remember "start ada-server in another terminal." If the configured backend URL
// is remote (not localhost), we DON'T spawn anything — the user clearly meant to point at a remote.
// The spawned child is killed when this process exits.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** True if the backend URL points at this machine — the only case we auto-spawn for. */
export function isLocalBackend(backendUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(backendUrl).hostname);
  } catch {
    return false;
  }
}

/** Probe the backend's /health. The URL passed in is `<base>/v1`; /health is at the base, not /v1. */
export function healthUrl(backendUrl: string): string {
  try {
    const u = new URL(backendUrl);
    u.pathname = "/health";
    u.search = "";
    return u.toString();
  } catch {
    return `${backendUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "")}/health`;
  }
}

// Plain node:http with agent:false, NOT fetch: undici's keep-alive socket from a probe lingers into
// process teardown and deterministically prints "Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)" on Windows at exit. agent:false closes the socket with the response.
function probe(url: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:http")
      .then((http) => {
        const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
          res.resume(); // drain so the socket can close
          resolve((res.statusCode ?? 500) < 400);
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(false));
      })
      .catch(() => resolve(false));
  });
}

/** Resolved path to bin/ada-server.mjs (sibling of bin/ada.mjs, packaged in the npm tarball). */
function serverBin(): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "bin", "ada-server.mjs");
}

/**
 * If the backend isn't responding (and the URL is local), spawn `ada-server` as a child process and
 * wait up to `waitMs` for /health to come up. Returns `"running"` if already alive, `"started"` if
 * we spawned it, `"remote"` if the URL is remote (skipped), or `"failed"` if it didn't come up in
 * time. Sets `process.on(...)` handlers so the child dies with us.
 */
export async function ensureBackend(backendUrl: string, opts?: { quiet?: boolean; waitMs?: number }): Promise<"running" | "started" | "remote" | "failed"> {
  const probeUrl = healthUrl(backendUrl);
  if (await probe(probeUrl)) return "running";
  if (!isLocalBackend(backendUrl)) return "remote";

  if (!opts?.quiet) process.stderr.write("\x1b[2mstarting ada-server…\x1b[0m ");
  const child = spawn(process.execPath, [serverBin()], { stdio: ["ignore", "ignore", "ignore"], detached: false });
  child.unref(); // don't keep parent alive once parent's own work finishes
  const killChild = (): void => {
    try {
      if (!child.killed) child.kill();
    } catch {
      /* ignore */
    }
  };
  process.once("exit", killChild);
  process.once("SIGINT", () => {
    killChild();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    killChild();
    process.exit(143);
  });
  child.once("error", () => {
    /* surfaced via the probe loop's timeout */
  });

  // 9s (not 5s): a cold first start now loads Better Auth's native better-sqlite3, which on a
  // fresh install can take a few seconds. Returns the instant /health responds, so a warm start
  // (≈1s) pays nothing extra — this only buys headroom for the cold case.
  const deadline = Date.now() + (opts?.waitMs ?? 9000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await probe(probeUrl, 400)) {
      if (!opts?.quiet) process.stderr.write("\x1b[32mok\x1b[0m\n");
      return "started";
    }
    if (child.exitCode != null) break; // child died — no point waiting more
  }
  if (!opts?.quiet) process.stderr.write("\x1b[31mfailed\x1b[0m\n");
  killChild();
  return "failed";
}
