// Gmail and Calendar over Google's ORDINARY REST APIs.
//
// Google also ships MCP servers for these (gmailmcp/calendarmcp.googleapis.com) and Ada can talk to
// them — but they are gated behind the Google Workspace Developer Preview Program, and every call
// from a project that is not enrolled comes back "The caller does not have permission" no matter how
// correct the token is. The plain REST APIs have no such gate: same OAuth token, same scopes, same
// project, and they answer immediately.
//
// So these tools use the token Ada already holds from the connector's normal sign-in, and call
// gmail.googleapis.com / calendar/v3 directly. If the preview enrollment later lands, the MCP path
// works too and this becomes redundant rather than wrong.
//
// Deliberately read-mostly: search, read, list, and DRAFT. There is no send. A drafted reply waits
// for a human, which is the same line Google's own MCP server draws.

import { registerTool } from "./tools.ts";

/** Fetch JSON from a Google API, turning failures into readable tool output rather than throws. */
async function api(token: string, url: string, init?: RequestInit): Promise<{ ok: boolean; body: unknown; text: string }> {
  const r = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!r.ok) {
    // Google nests the useful sentence; the raw envelope is noise in a transcript.
    const msg = (body as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300);
    return { ok: false, body, text: `${r.status}: ${msg}` };
  }
  return { ok: true, body, text };
}

type TokenFn = () => Promise<string | null>;

/** The header a Gmail message carries, by name — Gmail returns them as an unordered array. */
function header(msg: Record<string, unknown>, name: string): string {
  const headers = ((msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) ?? [];
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Gmail bodies are base64url, and split across nested parts. Walks to the first text it finds. */
function messageText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const data = (payload.body as { data?: string })?.data;
  const mime = String(payload.mimeType ?? "");
  if (data && (mime === "text/plain" || mime === "")) return Buffer.from(data, "base64url").toString("utf8");
  for (const part of (payload.parts as Array<Record<string, unknown>>) ?? []) {
    const found = messageText(part);
    if (found) return found;
  }
  // No plain-text part: fall back to HTML so the model gets SOMETHING rather than an empty body.
  if (data && mime === "text/html") return Buffer.from(data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
  return "";
}

/** RFC 2822, base64url — what Gmail's draft endpoint expects instead of JSON fields. */
function rawMessage(to: string, subject: string, body: string, cc?: string): string {
  const lines = [`To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";

function gmailTools(prefix: string, getToken: TokenFn): number {
  const need = async (): Promise<string> => {
    const t = await getToken();
    if (!t) throw new Error("not signed in to Gmail — connect it in Settings → Connectors");
    return t;
  };

  registerTool({
    name: `${prefix}__search_threads`,
    description:
      "Search Gmail and return matching threads with sender, subject, date and a snippet. `query` uses Gmail search syntax " +
      "(is:unread, from:x@y.com, newer_than:2d, has:attachment, in:inbox, label:NAME, -in:sent). Omit it for the most recent mail.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Gmail search syntax, e.g. "is:unread newer_than:1d"' },
        max: { type: "number", description: "How many threads to return (default 10, max 50)" },
      },
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      try {
        const token = await need();
        const a = args as { query?: string; max?: number };
        const max = Math.min(Math.max(Number(a.max) || 10, 1), 50);
        const q = a.query ? `&q=${encodeURIComponent(a.query)}` : "";
        const list = await api(token, `${GMAIL}/threads?maxResults=${max}${q}`);
        if (!list.ok) return { output: list.text, isError: true };
        const threads = ((list.body as { threads?: Array<{ id: string }> }).threads ?? []).slice(0, max);
        if (!threads.length) return { output: "No threads matched." };
        // One metadata read per thread. Gmail has no batch endpoint that returns headers, and the
        // alternative — returning bare ids — makes the model fetch them one at a time anyway.
        const rows = await Promise.all(
          threads.map(async (t) => {
            const d = await api(token, `${GMAIL}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            if (!d.ok) return `- ${t.id}: ${d.text}`;
            const msgs = ((d.body as { messages?: Array<Record<string, unknown>> }).messages ?? []) as Array<Record<string, unknown>>;
            const first = msgs[0] ?? {};
            const last = msgs[msgs.length - 1] ?? first;
            const unread = msgs.some((m) => ((m.labelIds as string[]) ?? []).includes("UNREAD"));
            return [
              `- [${t.id}] ${header(first, "Subject") || "(no subject)"}`,
              `    from: ${header(last, "From")}`,
              `    date: ${header(last, "Date")}${unread ? "   UNREAD" : ""}${msgs.length > 1 ? `   (${msgs.length} messages)` : ""}`,
              `    ${String(last.snippet ?? first.snippet ?? "").slice(0, 200)}`,
            ].join("\n");
          }),
        );
        return { output: `${threads.length} thread(s):\n${rows.join("\n")}` };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: `${prefix}__get_thread`,
    description: "Read a Gmail thread in full — every message's sender, date and body text. Use the id from search_threads.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    needsApproval: true,
    async run(args) {
      try {
        const token = await need();
        const d = await api(token, `${GMAIL}/threads/${String((args as { id: string }).id)}?format=full`);
        if (!d.ok) return { output: d.text, isError: true };
        const msgs = ((d.body as { messages?: Array<Record<string, unknown>> }).messages ?? []) as Array<Record<string, unknown>>;
        const parts = msgs.map((m) => {
          const body = messageText(m.payload as Record<string, unknown>).trim();
          return [
            `From: ${header(m, "From")}`,
            `To: ${header(m, "To")}`,
            `Date: ${header(m, "Date")}`,
            `Subject: ${header(m, "Subject")}`,
            "",
            // Whole threads run to tens of thousands of tokens; the tail of a long message is
            // rarely what decides anything, and an unbounded read is how a briefing costs millions.
            body.length > 4000 ? `${body.slice(0, 4000)}\n[... ${body.length - 4000} more characters]` : body,
          ].join("\n");
        });
        return { output: parts.join("\n\n---\n\n") || "(empty thread)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: `${prefix}__list_labels`,
    description: "List Gmail labels, with the ids needed by search queries (label:ID).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    needsApproval: true,
    async run() {
      try {
        const token = await need();
        const d = await api(token, `${GMAIL}/labels`);
        if (!d.ok) return { output: d.text, isError: true };
        const labels = ((d.body as { labels?: Array<{ id: string; name: string; type: string }> }).labels ?? [])
          .map((l) => `- ${l.name} (${l.id})${l.type === "system" ? " [system]" : ""}`)
          .join("\n");
        return { output: labels || "(no labels)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: `${prefix}__create_draft`,
    description:
      "Create a Gmail DRAFT. It is saved to the drafts folder and is NOT sent — a person still has to press send. " +
      "Pass threadId to draft a reply within an existing thread.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text body" },
        cc: { type: "string" },
        threadId: { type: "string", description: "Optional: reply inside this thread" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      try {
        const token = await need();
        const a = args as { to: string; subject: string; body: string; cc?: string; threadId?: string };
        const payload: Record<string, unknown> = { message: { raw: rawMessage(a.to, a.subject, a.body, a.cc) } };
        if (a.threadId) (payload.message as Record<string, unknown>).threadId = a.threadId;
        const d = await api(token, `${GMAIL}/drafts`, { method: "POST", body: JSON.stringify(payload) });
        if (!d.ok) return { output: d.text, isError: true };
        const id = (d.body as { id?: string }).id ?? "?";
        return { output: `Draft saved (id ${id}). It has NOT been sent — review it in Gmail and send from there.` };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  return 4;
}

function calendarTools(prefix: string, getToken: TokenFn): number {
  const need = async (): Promise<string> => {
    const t = await getToken();
    if (!t) throw new Error("not signed in to Google Calendar — connect it in Settings → Connectors");
    return t;
  };

  registerTool({
    name: `${prefix}__list_calendars`,
    description: "List the calendars this account can see, with the ids used by list_events.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    needsApproval: true,
    async run() {
      try {
        const token = await need();
        const d = await api(token, `${CAL}/users/me/calendarList`);
        if (!d.ok) return { output: d.text, isError: true };
        const items = ((d.body as { items?: Array<{ id: string; summary: string; primary?: boolean }> }).items ?? [])
          .map((c) => `- ${c.summary}${c.primary ? " [primary]" : ""} (${c.id})`)
          .join("\n");
        return { output: items || "(no calendars)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: `${prefix}__list_events`,
    description:
      "Events in a time range, with times, attendees and location. Defaults to the primary calendar for the next 24 hours, " +
      "which is what a morning briefing wants. Times are ISO 8601; omit them for 'from now'.",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: 'Calendar id, or "primary" (the default)' },
        timeMin: { type: "string", description: "ISO 8601 start, e.g. 2026-08-11T00:00:00Z" },
        timeMax: { type: "string", description: "ISO 8601 end" },
        max: { type: "number", description: "How many events (default 20)" },
      },
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      try {
        const token = await need();
        const a = args as { calendarId?: string; timeMin?: string; timeMax?: string; max?: number };
        const now = new Date();
        const min = a.timeMin ?? now.toISOString();
        const max = a.timeMax ?? new Date(now.getTime() + 24 * 3600_000).toISOString();
        const id = encodeURIComponent(a.calendarId ?? "primary");
        const n = Math.min(Math.max(Number(a.max) || 20, 1), 100);
        // singleEvents expands recurrences — without it a weekly stand-up appears once, as its
        // original definition, and never on the day you asked about.
        const d = await api(
          token,
          `${CAL}/calendars/${id}/events?singleEvents=true&orderBy=startTime&maxResults=${n}` +
            `&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}`,
        );
        if (!d.ok) return { output: d.text, isError: true };
        const items = (d.body as { items?: Array<Record<string, unknown>> }).items ?? [];
        if (!items.length) return { output: `No events between ${min} and ${max}.` };
        const rows = items.map((e) => {
          const start = (e.start as { dateTime?: string; date?: string }) ?? {};
          const end = (e.end as { dateTime?: string; date?: string }) ?? {};
          const when = start.dateTime ? `${new Date(start.dateTime).toLocaleString()} → ${end.dateTime ? new Date(end.dateTime).toLocaleTimeString() : "?"}` : `${start.date} (all day)`;
          const who = ((e.attendees as Array<{ email: string; responseStatus?: string }>) ?? [])
            .map((x) => `${x.email}${x.responseStatus && x.responseStatus !== "needsAction" ? ` (${x.responseStatus})` : ""}`)
            .join(", ");
          return [
            `- ${String(e.summary ?? "(no title)")}`,
            `    when: ${when}`,
            e.location ? `    where: ${String(e.location)}` : "",
            who ? `    attendees: ${who}` : "",
            e.description ? `    notes: ${String(e.description).replace(/\s+/g, " ").slice(0, 300)}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        });
        return { output: `${items.length} event(s):\n${rows.join("\n")}` };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  return 2;
}

/**
 * Register the built-in tools for a REST-backed connector. Returns how many were registered.
 * `getToken` is called per invocation rather than once, so a refreshed token is picked up.
 */
export function registerGoogleRestTools(prefix: string, kind: "gmail" | "calendar", getToken: TokenFn): number {
  return kind === "gmail" ? gmailTools(prefix, getToken) : calendarTools(prefix, getToken);
}
