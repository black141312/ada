// Gmail and Calendar over Google's ORDINARY REST APIs, against a fake Google.
//
// Why these exist at all: Google's Gmail/Calendar MCP servers are gated behind the Workspace
// Developer Preview, and refuse a perfectly valid token from an unenrolled project. The REST APIs
// answer the same token with no gate. This proves the tools hit the right endpoints, survive the
// shapes Google actually returns, and — the one that matters — that drafting never sends.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerGoogleRestTools } from "../src/client/google-rest.ts";
import { toolByName } from "../src/client/tools.ts";

const seen: Array<{ method: string; url: string; body: string }> = [];
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const google = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push({ method: req.method ?? "", url: req.url ?? "", body });
  const json = (o: unknown): void => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  const u = new URL(req.url ?? "/", "http://x");

  if (u.pathname.endsWith("/threads") && req.method === "GET") return json({ threads: [{ id: "t1" }, { id: "t2" }] });
  if (u.pathname.includes("/threads/t1"))
    return json({
      messages: [
        {
          labelIds: ["INBOX", "UNREAD"],
          snippet: "the invoice is attached",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Finance <finance@example.com>" },
              { name: "Subject", value: "Invoice 42" },
              { name: "Date", value: "Mon, 10 Aug 2026 09:00:00 +0000" },
            ],
            body: { data: b64("Please approve invoice 42 before Friday.") },
          },
        },
      ],
    });
  if (u.pathname.includes("/threads/t2")) return json({ messages: [{ snippet: "hi", payload: { headers: [] } }] });
  if (u.pathname.endsWith("/labels")) return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
  if (u.pathname.endsWith("/drafts") && req.method === "POST") return json({ id: "draft-1" });
  if (u.pathname.endsWith("/calendarList")) return json({ items: [{ id: "primary", summary: "Aditya", primary: true }] });
  if (u.pathname.includes("/events"))
    return json({
      items: [
        {
          summary: "Roadmap review",
          location: "Meet",
          start: { dateTime: "2026-08-11T09:30:00Z" },
          end: { dateTime: "2026-08-11T10:00:00Z" },
          attendees: [{ email: "priya@example.com", responseStatus: "accepted" }],
        },
      ],
    });
  res.writeHead(404).end("{}");
});

await new Promise<void>((r) => google.listen(8998, "127.0.0.1", r));
const base = "http://127.0.0.1:8998";

try {
  // Point the module at the fake Google. The tools build URLs from these constants, so overriding
  // them here exercises the real request-building code rather than a stub of it.
  const mod = (await import("../src/client/google-rest.ts")) as unknown as Record<string, unknown>;
  void mod; // the endpoints are module constants; the fake is reached via the fetch patch below

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const redirected = url
      .replace("https://gmail.googleapis.com/gmail/v1/users/me", `${base}/gmail`)
      .replace("https://www.googleapis.com/calendar/v3", `${base}/cal`);
    return realFetch(redirected, init);
  }) as typeof fetch;

  registerGoogleRestTools("gmail", "gmail", async () => "test-token");
  registerGoogleRestTools("calendar", "calendar", async () => "test-token");

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const t = toolByName.get(name);
    assert.ok(t, `${name} was not registered`);
    const out = await t.run(args as never, { cwd: process.cwd() } as never);
    return String((out as { output: string }).output);
  };

  // --- search ---------------------------------------------------------------------------------
  const search = await call("gmail__search_threads", { query: "is:unread", max: 2 });
  assert.match(search, /Invoice 42/, "the subject comes back");
  assert.match(search, /finance@example\.com/, "and the sender");
  assert.match(search, /UNREAD/, "and whether it is unread — the whole point of a briefing");
  assert.ok(seen.some((s) => s.url.includes("q=is%3Aunread")), "the Gmail query is passed through, not ignored");
  console.log("gmail search   : subject, sender, unread flag, query honoured");

  // --- read -----------------------------------------------------------------------------------
  const thread = await call("gmail__get_thread", { id: "t1" });
  assert.match(thread, /approve invoice 42 before Friday/, "the base64url body is decoded");
  console.log("gmail read     : body decoded from base64url");

  // --- draft, and ONLY draft ------------------------------------------------------------------
  const draft = await call("gmail__create_draft", { to: "a@b.com", subject: "Re: Invoice 42", body: "Approved." });
  assert.match(draft, /NOT been sent/i, "it says plainly that nothing was sent");
  const drafted = seen.find((s) => s.method === "POST" && s.url.includes("/drafts"));
  assert.ok(drafted, "it posted to /drafts");
  assert.ok(
    !seen.some((s) => s.url.includes("/send") || s.url.includes("/messages/send")),
    "NOTHING MAY EVER HIT A SEND ENDPOINT — a drafted reply waits for a human",
  );
  const raw = Buffer.from(JSON.parse(drafted!.body).message.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: a@b\.com/m, "the RFC 2822 envelope is well formed");
  assert.match(raw, /^Subject: Re: Invoice 42/m);
  console.log("gmail draft    : saved to /drafts, never sent, envelope well formed");

  // --- calendar -------------------------------------------------------------------------------
  const cals = await call("calendar__list_calendars");
  assert.match(cals, /primary/, "calendars listed");
  const events = await call("calendar__list_events");
  assert.match(events, /Roadmap review/, "the event");
  assert.match(events, /priya@example\.com \(accepted\)/, "attendees with their response");
  const eventsReq = seen.find((s) => s.url.includes("/events"));
  assert.ok(eventsReq!.url.includes("singleEvents=true"), "recurrences are expanded, or a weekly stand-up never appears");
  assert.ok(eventsReq!.url.includes("timeMin=") && eventsReq!.url.includes("timeMax="), "bounded to a window");
  console.log("calendar       : events, attendees, recurrences expanded, window bounded");

  // --- not signed in is a message, not a crash --------------------------------------------------
  registerGoogleRestTools("gmail", "gmail", async () => null);
  const out = await call("gmail__search_threads", {});
  assert.match(out, /not signed in/i, "says what to do rather than throwing");
  console.log("signed out     : explains itself instead of crashing");

  globalThis.fetch = realFetch;
  console.log("\ngoogle REST connectors: read mail and calendar with the token we already have — no preview needed");
} finally {
  google.close();
  await new Promise((r) => setTimeout(r, 200));
}
process.exit(0);
