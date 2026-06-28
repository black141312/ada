// Server-Sent Events helpers shared by the adapters.

import type { ServerResponse } from "node:http";

export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

/** Write one OpenAI-style `data: {...}` SSE chunk. */
export function writeChunk(res: ServerResponse, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/** Write the terminal `data: [DONE]` line and end the response. */
export function endStream(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}
