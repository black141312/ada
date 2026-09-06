// Posting to X and LinkedIn over their ordinary REST APIs, using the token the connector's sign-in
// already holds.
//
// Neither is an MCP server, so neither reaches here through the usual discovery path — see the
// explicit `oauthEndpoints` on their catalog entries and the `meta` escape hatch in beginLogin.
//
// UNLIKE the Gmail tools next door, these WRITE, and what they write is public and effectively
// permanent. Two consequences run through this file:
//   - every post tool is needsApproval, so a scheduled turn cannot publish unattended;
//   - a `draft` mode returns exactly what WOULD be sent without sending it, so a prompt can be
//     iterated on safely and a schedule can be dry-run before it is armed.
// The alternative — an agent that can publish on its own — is not a capability worth having by
// default on an account that represents a company.

import { registerTool } from "./tools.ts";

type TokenFn = () => Promise<string | null>;

/** X's limit for a standard account. Longer posts need a paid tier, and the API rejects them with a
 *  message that does not mention length, so the check happens here where it can say so. */
const X_LIMIT = 280;
/** LinkedIn's documented ceiling for post commentary. */
const LI_LIMIT = 3000;

async function api(
  token: string,
  url: string,
  init: RequestInit & { body?: string },
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; text: string; body: unknown }> {
  const r = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!r.ok) {
    // Both APIs bury the useful sentence in a different place, and the raw envelope is noise in a
    // transcript. 401/403 are called out by name because they mean "your app lacks the scope or the
    // tier", which is a setup problem no retry will fix — not a transient failure.
    const b = body as { detail?: string; title?: string; message?: string; errors?: Array<{ message?: string }> } | null;
    const msg = b?.detail ?? b?.message ?? b?.errors?.[0]?.message ?? b?.title ?? text.slice(0, 300);
    const hint =
      r.status === 401
        ? " — the token is missing or expired; sign in to the connector again"
        : r.status === 403
          ? " — the app is not permitted to do this: check the write scope was granted, and that the API tier allows posting"
          : "";
    return { ok: false, text: `${r.status}: ${msg}${hint}`, body };
  }
  return { ok: true, text, body };
}

/** Post to X. Returns the tool's own result shape. */
function xTools(prefix: string, getToken: TokenFn): number {
  const need = async (): Promise<string> => {
    const t = await getToken();
    if (!t) throw new Error("not signed in to X — connect it first");
    return t;
  };

  registerTool({
    name: `${prefix}__post`,
    description:
      "Publish a post to X (Twitter) on the connected account. PUBLIC and effectively permanent — prefer draft:true first to see " +
      `exactly what would be sent. Text is limited to ${X_LIMIT} characters on a standard account.`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post body, as it should appear." },
        reply_to: { type: "string", description: "Optional id of a post to reply to." },
        draft: { type: "boolean", description: "Return what would be posted without posting it. Use this first." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const text = String(args.text ?? "");
      // Checked before the token, so a length mistake is reported even when nothing is connected —
      // that is the failure a draft is meant to catch.
      if (!text.trim()) return { output: "nothing to post: text is empty", isError: true };
      if (text.length > X_LIMIT)
        return { output: `too long for X: ${text.length} characters, limit is ${X_LIMIT}`, isError: true };
      if (args.draft) return { output: `DRAFT — not posted (${text.length}/${X_LIMIT} chars):\n\n${text}` };
      try {
        const token = await need();
        const payload: Record<string, unknown> = { text };
        if (args.reply_to) payload.reply = { in_reply_to_tweet_id: String(args.reply_to) };
        const r = await api(token, "https://api.x.com/2/tweets", { method: "POST", body: JSON.stringify(payload) });
        if (!r.ok) return { output: r.text, isError: true };
        const id = (r.body as { data?: { id?: string } })?.data?.id;
        return { output: id ? `posted: https://x.com/i/web/status/${id}` : `posted: ${r.text.slice(0, 200)}` };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  return 1;
}

function linkedinTools(prefix: string, getToken: TokenFn): number {
  const need = async (): Promise<string> => {
    const t = await getToken();
    if (!t) throw new Error("not signed in to LinkedIn — connect it first");
    return t;
  };

  /** LinkedIn addresses the author by URN, not by name, and every post body needs one. The id comes
   *  from the token's own profile, so a wrong account is impossible to address by accident. */
  async function authorUrn(token: string, orgId?: string): Promise<string> {
    if (orgId) return `urn:li:organization:${String(orgId).replace(/^urn:li:organization:/, "")}`;
    const r = await api(token, "https://api.linkedin.com/v2/userinfo", { method: "GET" });
    if (!r.ok) throw new Error(`could not identify the signed-in member (${r.text})`);
    const sub = (r.body as { sub?: string })?.sub;
    if (!sub) throw new Error("LinkedIn did not return a member id for this token");
    return `urn:li:person:${sub}`;
  }

  registerTool({
    name: `${prefix}__post`,
    description:
      "Publish a post to LinkedIn as the connected member, or as a company page when organization_id is given. PUBLIC and " +
      "effectively permanent — prefer draft:true first. Posting as a page requires the app to be authorised for that page.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post body, as it should appear." },
        organization_id: { type: "string", description: "Post as this company page instead of as yourself." },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Default PUBLIC." },
        draft: { type: "boolean", description: "Return what would be posted without posting it. Use this first." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const text = String(args.text ?? "");
      if (!text.trim()) return { output: "nothing to post: text is empty", isError: true };
      if (text.length > LI_LIMIT)
        return { output: `too long for LinkedIn: ${text.length} characters, limit is ${LI_LIMIT}`, isError: true };
      const as = args.organization_id ? `company page ${args.organization_id}` : "the signed-in member";
      if (args.draft) return { output: `DRAFT — not posted, would post as ${as} (${text.length}/${LI_LIMIT} chars):\n\n${text}` };
      try {
        const token = await need();
        const author = await authorUrn(token, args.organization_id ? String(args.organization_id) : undefined);
        const r = await api(
          token,
          "https://api.linkedin.com/rest/posts",
          {
            method: "POST",
            body: JSON.stringify({
              author,
              commentary: text,
              visibility: args.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
              distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
              lifecycleState: "PUBLISHED",
            }),
          },
          // Versioned API: LinkedIn rejects /rest/ calls that do not pin a version, and the error
          // does not say which header is missing.
          { "LinkedIn-Version": "202411", "X-Restli-Protocol-Version": "2.0.0" },
        );
        if (!r.ok) return { output: r.text, isError: true };
        return { output: `posted to LinkedIn as ${as}` };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  return 1;
}

/** Register the built-in tools for a social connector. Returns how many were registered.
 *  `getToken` is called per invocation rather than once, so a refreshed token is picked up. */
export function registerSocialTools(prefix: string, kind: "x" | "linkedin", getToken: TokenFn): number {
  return kind === "x" ? xTools(prefix, getToken) : linkedinTools(prefix, getToken);
}
