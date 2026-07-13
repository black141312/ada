// Enterprise control plane: seats (per-user client keys), org policy, usage metering, audit log.
// One deployment = one org (it's self-hosted; multi-org is the SaaS upgrade path, not v1).
//
// Enterprise mode ACTIVATES when a seat exists or ADA_ADMIN_KEY is set — with neither, the backend
// behaves exactly as before (dev-open / ADA_CLIENT_KEYS / login). Bootstrap:
//
//   ADA_ADMIN_KEY=<random> ada-server
//   curl -X POST -H "Authorization: Bearer $ADA_ADMIN_KEY" localhost:8787/v1/users -d '{"name":"alice"}'
//
// Security posture (hardened after an adversarial review):
//   - lookups are own-property + format-guarded (no prototype-key auth bypass);
//   - writes are atomic (tmp + rename); a corrupt/unreadable store fails CLOSED (never dev-open);
//   - key comparisons are timing-safe.
// ponytail: file-backed under ~/.ada/server — fine to ~50 seats. Postgres + rotating usage logs are
// the upgrade path when an org outgrows files (usageSummary/auditTail read whole files: OK to
// low-millions of rows, then rotate).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolved once: an empty ADA_DATA_DIR means "unset", and a relative path can't scatter the auth
// store across working directories (which would itself be a fail-open).
const DATA_DIR = resolve(process.env.ADA_DATA_DIR || join(homedir(), ".ada", "server"));
function dataDir(): string {
  return DATA_DIR;
}

/** Thrown when a store file exists but can't be read/parsed — callers must fail CLOSED, never open. */
export class CorruptStore extends Error {}

export interface Seat {
  name: string;
  role: "admin" | "dev";
  created: string;
  disabled?: boolean;
  externalId?: string; // OIDC SSO: issuer-scoped stable id (`iss#sub`) — non-secret, the deprovision target
  iss?: string; // OIDC issuer the seat was provisioned from (so an issuer change is detectable)
}
export interface PolicyRule {
  tool?: string;
  pattern?: string;
  action: "allow" | "ask" | "deny";
}
export interface Policy {
  models?: string[];
  permissions?: PolicyRule[];
}
export interface UsageRow {
  ts: number;
  user: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
}
export interface Identity {
  user: string;
  role: "admin" | "dev";
}

const usersFile = (dir: string): string => join(dir, "users.json");
const policyFile = (dir: string): string => join(dir, "policy.json");
const usageFile = (dir: string): string => join(dir, "usage.jsonl");
const auditFile = (dir: string): string => join(dir, "audit.jsonl");

function atomicWrite(file: string, data: string): void {
  // Owner-only: users.json holds full `ada_sk_` seat/admin keys (plaintext bearer secrets). The mode
  // applies to the per-pid tmp inode and survives the rename. (Windows chmod is a no-op — this guards
  // POSIX/Docker, e.g. the documented ADA_DATA_DIR `/data` volume.)
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file); // atomic on the same filesystem — a crash can't leave a torn file
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** Seats keyed by full key. Missing file → empty (prototype-free) map. Any OTHER read/parse error
 *  → CorruptStore (callers fail closed — a torn users.json must not silently disable auth). */
export function loadSeats(dir = dataDir()): Record<string, Seat> {
  const map: Record<string, Seat> = Object.create(null); // no Object.prototype — belt-and-suspenders with the own-property check
  let text: string;
  try {
    text = readFileSync(usersFile(dir), "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return map;
    throw new CorruptStore(`users.json unreadable: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const parsed = (JSON.parse(text) as { users?: Record<string, Seat> }).users ?? {};
    for (const [k, v] of Object.entries(parsed)) map[k] = v;
    return map;
  } catch (e) {
    throw new CorruptStore(`users.json corrupt: ${e instanceof Error ? e.message : e}`);
  }
}

function saveSeats(seats: Record<string, Seat>, dir = dataDir()): void {
  atomicWrite(usersFile(dir), JSON.stringify({ users: seats }, null, 2));
}

/** Enterprise mode = admin key set, or seats exist. A corrupt seat store counts as enterprise
 *  (locked), never as "no seats" — fail closed. */
export function enterpriseMode(dir = dataDir()): boolean {
  if (process.env.ADA_ADMIN_KEY) return true;
  try {
    return Object.keys(loadSeats(dir)).length > 0;
  } catch {
    return true;
  }
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Resolve a bearer token to a seat identity (or the bootstrap admin). Null = not a seat. Throws
 *  CorruptStore if the seat store can't be read (caller returns 503, never dev-open). */
export function identifySeat(token: string, dir = dataDir()): Identity | null {
  const admin = process.env.ADA_ADMIN_KEY;
  if (admin && timingEqual(token, admin)) return { user: "admin", role: "admin" };
  if (!token.startsWith("ada_sk_")) return null; // format guard — "toString"/"__proto__"/… never reach the map
  const seats = loadSeats(dir); // may throw CorruptStore
  if (!Object.prototype.hasOwnProperty.call(seats, token)) return null; // own-property only
  const seat = seats[token]!;
  return seat.disabled ? null : { user: seat.name, role: seat.role };
}

/** Create a seat; returns its full key (shown once — only a prefix is ever listed again). */
export function createSeat(name: string, role: "admin" | "dev" = "dev", dir = dataDir()): string {
  const key = `ada_sk_${randomBytes(24).toString("hex")}`;
  const seats = loadSeats(dir);
  seats[key] = { name, role, created: new Date().toISOString() };
  saveSeats(seats, dir);
  appendAudit({ ts: Date.now(), user: "-", event: "seat_created", detail: `${name} (${role})` }, dir);
  return key;
}

/** Find a seat by its OIDC externalId (`iss#sub`). Scans the (small) seat map by VALUE — externalId
 *  is compared, never used as a lookup key, so it's inherently prototype-safe. Inherits CorruptStore
 *  from loadSeats (callers fail closed). */
export function seatByExternalId(externalId: string, dir = dataDir()): { key: string; seat: Seat } | null {
  const seats = loadSeats(dir);
  for (const key of Object.keys(seats)) {
    const seat = seats[key]!;
    if (seat.externalId === externalId) return { key, seat };
  }
  return null;
}

/** JIT-provision (or reuse) a seat for a verified OIDC identity. Returns the seat's `ada_sk_` key, or
 *  null if the seat exists but is DISABLED (a deprovisioned user must not be resurrected by re-login).
 *  - existing enabled seat → reuse its key (NO rotation); if it was admin and the login no longer
 *    carries the admin group, downgrade admin→dev (privilege revocation). Never auto-ESCALATE here.
 *  - new identity → mint one key, stamp externalId+iss, one `seat_created` audit row. */
export function upsertSeatForSSO(externalId: string, iss: string, name: string, role: "admin" | "dev", dir = dataDir()): string | null {
  const seats = loadSeats(dir);
  let foundKey: string | null = null;
  for (const key of Object.keys(seats)) {
    if (seats[key]!.externalId === externalId) {
      foundKey = key;
      break;
    }
  }
  if (foundKey) {
    const seat = seats[foundKey]!;
    if (seat.disabled) return null; // deprovisioned — do NOT resurrect
    if (seat.role === "admin" && role === "dev") {
      seat.role = "dev";
      saveSeats(seats, dir);
      appendAudit({ ts: Date.now(), user: name, event: "role_changed", detail: `${name} admin→dev (SSO group removed)` }, dir);
    }
    return foundKey;
  }
  const key = `ada_sk_${randomBytes(24).toString("hex")}`;
  seats[key] = { name, role, created: new Date().toISOString(), externalId, iss };
  saveSeats(seats, dir);
  appendAudit({ ts: Date.now(), user: name, event: "seat_created", detail: `${name} (${role}) via OIDC ${externalId}` }, dir);
  return key;
}

/** Immediate offboarding: disable the seat for an OIDC externalId. The admin endpoint (and, later,
 *  SCIM DELETE) call this — the next identifySeat for that key returns null (401). */
export function disableSeatByExternalId(externalId: string, dir = dataDir()): string | null {
  const seats = loadSeats(dir);
  for (const key of Object.keys(seats)) {
    const seat = seats[key]!;
    if (seat.externalId === externalId) {
      if (seat.disabled) return seat.name; // idempotent
      seat.disabled = true;
      saveSeats(seats, dir);
      appendAudit({ ts: Date.now(), user: seat.name, event: "seat_disabled", detail: `${seat.name} (SSO ${externalId})` }, dir);
      return seat.name;
    }
  }
  return null;
}

/** Disable (not delete — the audit trail keeps the history) the seat whose key starts with prefix. */
export function disableSeat(prefix: string, dir = dataDir()): string | null {
  if (prefix.length < 12) return null; // too short to be safely unique
  const seats = loadSeats(dir);
  const keys = Object.keys(seats).filter((k) => k.startsWith(prefix));
  if (keys.length !== 1) return null;
  seats[keys[0]!]!.disabled = true;
  saveSeats(seats, dir);
  appendAudit({ ts: Date.now(), user: "-", event: "seat_disabled", detail: seats[keys[0]!]!.name }, dir);
  return seats[keys[0]!]!.name;
}

/** Key prefixes + metadata for listing — full keys are never returned after creation. Display-only,
 *  so a corrupt store yields [] rather than crashing the banner. */
export function listSeats(dir = dataDir()): Array<Seat & { keyPrefix: string }> {
  try {
    return Object.entries(loadSeats(dir)).map(([k, s]) => ({ ...s, keyPrefix: k.slice(0, 14) }));
  } catch {
    return [];
  }
}

let lastGoodPolicy: Policy | null = null;
/** Missing file → {} (no policy = allow all, legitimate). A corrupt EXISTING file → last-known-good
 *  if we have one, else CorruptStore (fail closed — a security control must not degrade to allow-all). */
export function loadPolicy(dir = dataDir()): Policy {
  let text: string;
  try {
    text = readFileSync(policyFile(dir), "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return {};
    if (lastGoodPolicy) return lastGoodPolicy;
    throw new CorruptStore(`policy.json unreadable: ${e instanceof Error ? e.message : e}`);
  }
  try {
    lastGoodPolicy = JSON.parse(text) as Policy;
    return lastGoodPolicy;
  } catch (e) {
    if (lastGoodPolicy) return lastGoodPolicy;
    throw new CorruptStore(`policy.json corrupt: ${e instanceof Error ? e.message : e}`);
  }
}

export function savePolicy(p: Policy, dir = dataDir()): void {
  atomicWrite(policyFile(dir), JSON.stringify(p, null, 2));
  lastGoodPolicy = p;
  appendAudit({ ts: Date.now(), user: "-", event: "policy_updated", detail: JSON.stringify(p).slice(0, 300) }, dir);
}

/** Validate a policy shape from the wire. Returns the typed policy or an error message. */
export function validatePolicy(raw: unknown): { policy: Policy } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "policy must be a JSON object" };
  const r = raw as Record<string, unknown>;
  const out: Policy = {};
  if (r.models !== undefined) {
    if (!Array.isArray(r.models) || r.models.some((m) => typeof m !== "string" || !m.trim())) return { error: "models must be an array of non-empty strings" };
    out.models = r.models as string[];
  }
  if (r.permissions !== undefined) {
    if (!Array.isArray(r.permissions)) return { error: "permissions must be an array" };
    for (const p of r.permissions) {
      const rule = p as Record<string, unknown>;
      if (!rule || typeof rule !== "object" || !["allow", "ask", "deny"].includes(rule.action as string)) return { error: "each permission needs action: allow|ask|deny" };
      if (rule.tool !== undefined && typeof rule.tool !== "string") return { error: "permission.tool must be a string" };
      if (rule.pattern !== undefined && typeof rule.pattern !== "string") return { error: "permission.pattern must be a string" };
    }
    out.permissions = r.permissions as PolicyRule[];
  }
  return { policy: out };
}

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(s);
}

/** Is this model allowed by org policy? No/empty allowlist = everything allowed. */
export function modelAllowed(model: string, policy: Policy): boolean {
  if (!Array.isArray(policy.models) || !policy.models.length) return true;
  return policy.models.some((p) => globMatch(p, model));
}

export function appendUsage(row: UsageRow, dir = dataDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(usageFile(dir), `${JSON.stringify(row)}\n`);
  } catch {
    /* metering is best-effort; never fail a request over it */
  }
}

export interface AuditRow {
  ts: number;
  user: string;
  event: string;
  detail: string;
}

export function appendAudit(row: AuditRow, dir = dataDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(auditFile(dir), `${JSON.stringify(row)}\n`);
  } catch {
    /* best-effort */
  }
}

export function auditTail(limit = 200, dir = dataDir()): AuditRow[] {
  let lines: string[];
  try {
    lines = readFileSync(auditFile(dir), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: AuditRow[] = [];
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l) as AuditRow); // skip a torn last line instead of losing the whole view
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

interface Bucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}
export interface UsageSummary {
  since: number;
  totals: Bucket;
  byUser: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
}

export function usageSummary(days = 30, dir = dataDir()): UsageSummary {
  const since = Date.now() - days * 86_400_000;
  const zero = (): Bucket => ({ requests: 0, promptTokens: 0, completionTokens: 0 });
  const out: UsageSummary = { since, totals: zero(), byUser: Object.create(null), byModel: Object.create(null) };
  let lines: string[] = [];
  try {
    lines = readFileSync(usageFile(dir), "utf8").split("\n").filter(Boolean);
  } catch {
    return out;
  }
  for (const l of lines) {
    let r: UsageRow;
    try {
      r = JSON.parse(l) as UsageRow;
    } catch {
      continue;
    }
    if (r.ts < since) continue;
    for (const b of [out.totals, (out.byUser[r.user] ??= zero()), (out.byModel[r.model] ??= zero())]) {
      b.requests++;
      b.promptTokens += r.promptTokens || 0;
      b.completionTokens += r.completionTokens || 0;
    }
  }
  return out;
}

function matchBraces(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Pull the LAST real `"usage": { … }` object out of streamed/response text. Skips a trailing
 *  `"usage": null` and keeps scanning backwards, so a null in a late frame doesn't hide a real one. */
export function extractLastUsage(text: string): { promptTokens: number; completionTokens: number } | null {
  let at = text.lastIndexOf('"usage"');
  while (at >= 0) {
    const brace = text.indexOf("{", at + 7);
    const colon = text.indexOf(":", at + 7);
    if (brace >= 0 && colon >= 0 && text.slice(colon + 1, brace).trim() === "") {
      const obj = matchBraces(text, brace);
      if (obj) {
        try {
          const u = JSON.parse(obj) as { prompt_tokens?: number; completion_tokens?: number };
          if (u.prompt_tokens != null || u.completion_tokens != null) return { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };
        } catch {
          /* malformed — keep looking backwards */
        }
      }
    }
    at = text.lastIndexOf('"usage"', at - 1);
  }
  return null;
}

export function storeExists(dir = dataDir()): boolean {
  return existsSync(usersFile(dir)) || existsSync(policyFile(dir));
}
