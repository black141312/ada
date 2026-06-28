// Extension hook registry: transform user input, and intercept tool calls (deny / rewrite args /
// post-process results). Extensions register a ToolHooks object; the agent runs them in order.

import type { ToolResult } from "./tools.ts";

export interface ToolHooks {
  onUserMessage?(text: string): string | undefined | Promise<string | undefined>;
  beforeTool?(
    name: string,
    args: Record<string, unknown>,
  ): { deny?: string; args?: Record<string, unknown> } | void | Promise<{ deny?: string; args?: Record<string, unknown> } | void>;
  afterTool?(name: string, args: Record<string, unknown>, result: ToolResult): ToolResult | undefined | Promise<ToolResult | undefined>;
}

const hooks: ToolHooks[] = [];

export function addHook(h: ToolHooks): void {
  hooks.push(h);
}

export async function transformInput(text: string): Promise<string> {
  for (const h of hooks) if (h.onUserMessage) text = (await h.onUserMessage(text)) ?? text;
  return text;
}

export async function beforeTool(name: string, args: Record<string, unknown>): Promise<{ deny?: string; args: Record<string, unknown> }> {
  let cur = args;
  for (const h of hooks) {
    if (!h.beforeTool) continue;
    const r = await h.beforeTool(name, cur);
    if (r?.deny) return { deny: r.deny, args: cur };
    if (r?.args) cur = r.args;
  }
  return { args: cur };
}

export async function afterTool(name: string, args: Record<string, unknown>, result: ToolResult): Promise<ToolResult> {
  for (const h of hooks) if (h.afterTool) result = (await h.afterTool(name, args, result)) ?? result;
  return result;
}
