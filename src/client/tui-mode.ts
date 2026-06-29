// The inline TUI loop: drives the same Agent, rendering everything inline (composer follows the
// conversation, reply opens on the ◆ icon, spinner shows a "thinking" word while the model works).

import { stdout } from "node:process";
import type { Agent } from "./agent.ts";
import { setAsker } from "./tools.ts";
import { Tui } from "./tui.ts";

export async function runTui(agent: Agent, model: string): Promise<void> {
  const tui = new Tui();
  agent.setOnApprove(async (name, summary) => tui.confirm(`run ${name} ${summary}`));
  setAsker((question, options) => tui.ask(question, options));
  tui.start();
  // Header as the first lines (scrolls away naturally as the conversation grows).
  stdout.write(
    `${"\x1b[38;5;214m"}█▀█ █▀▄ █▀█\n█▀█ █▄▀ █▀█\x1b[0m  \x1b[2m${model}\x1b[0m\n` +
      `\x1b[2mAsk me to build, edit, or explain code in ${process.cwd()}\x1b[0m\n\n`,
  );
  try {
    for (;;) {
      tui.setStatus(`${model} · ~${agent.contextTokens()} tok`);
      const line = await tui.readLine();
      if (line === null) break; // Ctrl+C/Ctrl+D at empty prompt
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      const abort = new AbortController();
      const steer: string[] = [];
      tui.beginTurn(abort, steer);
      try {
        await agent.send(line, { signal: abort.signal, steer, onReplyStart: () => tui.replyStart() });
      } catch (e) {
        stdout.write(`\n\x1b[31m[error] ${e instanceof Error ? e.message : e}\x1b[0m`);
      } finally {
        tui.endTurn();
        stdout.write("\n\n"); // breathing room before the next composer
      }
    }
  } finally {
    tui.stop();
  }
}
