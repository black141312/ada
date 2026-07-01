// Pure helpers for ada's HTTP+SSE agent service (the session endpoints on `ada serve`). Kept
// separate from cli.ts's route wiring so the tricky bits — SSE framing, id generation, and
// approval correlation — are unit-testable offline, with no live model required.

import type { ApprovalDecision } from "./agent.ts";

/** Format one Server-Sent Events frame for a JSON-serializable event. */
export function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

let seq = 0;
/** A short, process-unique id (session id, approval-request id, …). */
export function newId(prefix: string): string {
  seq++;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Correlates a mid-turn approval request with the IDE's later response. `wait()` is called from
 * inside the Agent's onApprove callback (which is blocked on the returned promise); `settle()` is
 * called from the POST .../approve handler once the IDE's user has decided.
 */
export class ApprovalRegistry {
  private pending = new Map<string, (d: ApprovalDecision) => void>();

  wait(): { id: string; promise: Promise<ApprovalDecision> } {
    const id = newId("appr");
    const promise = new Promise<ApprovalDecision>((resolve) => this.pending.set(id, resolve));
    return { id, promise };
  }

  /** Resolve a pending approval by id. False if the id is unknown (already settled, or bogus). */
  settle(id: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(decision);
    return true;
  }

  /** Deny every pending approval — an aborted turn must not stay parked on an unanswered prompt. */
  abortAll(): number {
    const n = this.pending.size;
    for (const resolve of this.pending.values()) resolve("no");
    this.pending.clear();
    return n;
  }

  get size(): number {
    return this.pending.size;
  }
}
