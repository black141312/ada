// Launched inside a pty by ink-tui-smoke.mjs — runs the Ink TUI against a stub agent.
import { runInkTui } from "../src/client/ink-tui.tsx";

const agent = {
  contextTokens: () => 42,
  setOnApprove() {},
  async send(input, ctrl) {
    for (const word of `stub reply to: ${input}`.split(" ")) {
      ctrl.onEvent({ type: "text", delta: `${word} ` });
      await new Promise((r) => setTimeout(r, 20));
    }
    ctrl.onEvent({ type: "done", text: "", usage: "", context: 43 });
    return "";
  },
};

await runInkTui(agent, "stub-model");
process.exit(0);
