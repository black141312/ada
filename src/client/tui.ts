// Inline terminal UI for the ada REPL — no scroll region, no pinned footer. Everything flows
// inline like a chat: the composer is drawn right after the last reply (so there's never a void),
// the user's line is committed as a dim full-width bar, and ada's reply begins on the ◆ icon's
// line. While the model is thinking, a spinner cycles a random "processing" word. Raw-mode input
// is a small state machine:
//   line    — reading a user message (Enter submits; ↑/↓ history)
//   turn    — agent running (Esc/Ctrl+C interrupts; type+Enter queues a steer)
//   confirm — an approval prompt awaiting y / a / n

import { stdin, stdout } from "node:process";

const GOLD = "\x1b[38;5;214m"; // ada accent (xterm 214)
const DIM = "\x1b[2m";
const RST = "\x1b[0m";
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Playful gerunds shown while the model works (à la Claude's "Cogitating…").
const WORDS = [
  "Cogitating", "Pondering", "Noodling", "Percolating", "Ruminating", "Conjuring",
  "Finagling", "Tinkering", "Scheming", "Untangling", "Marinating", "Synthesizing",
  "Spelunking", "Vibing", "Hatching", "Brewing", "Mulling", "Crunching", "Simmering", "Whittling",
];

type Mode = "idle" | "line" | "turn" | "confirm";

/** Claude-style full-width user bar, e.g. " › hi" on a dim background. */
export function userBar(text: string, cols: number): string {
  const visible = 3 + text.length; // " › " + text
  const pad = visible >= cols ? "" : " ".repeat(cols - visible);
  return `\x1b[48;5;238m ${GOLD}›${RST}\x1b[97m ${text}${pad}${RST}`;
}

export class Tui {
  private buf = "";
  private status = "";
  private history: string[] = [];
  private hist = -1;
  private mode: Mode = "idle";
  private spin = 0;
  private word = WORDS[0]!;
  private thinkTimer: ReturnType<typeof setInterval> | null = null;
  private thinking = false;
  private thinkStart = 0; // ms epoch when the current turn began thinking — for the live elapsed timer

  private lineResolve: ((s: string | null) => void) | null = null;
  private confirmResolve: ((s: "yes" | "all" | "no") => void) | null = null;
  private abort: AbortController | null = null;
  private steer: string[] | null = null;
  private onData = (b: Buffer): void => this.key(b.toString("utf8"));

  start(): void {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", this.onData);
    stdout.write("\x1b[?25l"); // hide the real cursor; the composer draws a fake block
  }

  stop(): void {
    this.stopThinking();
    stdin.off("data", this.onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause(); // unref stdin so the process can exit
    stdout.write("\x1b[?25h\n"); // show cursor, fresh line
  }

  setStatus(s: string): void {
    this.status = s;
  }

  /** Read one user line in an inline composer. Resolves null on Ctrl+C/Ctrl+D at an empty prompt. */
  readLine(): Promise<string | null> {
    this.mode = "line";
    this.buf = "";
    this.hist = -1;
    this.renderComposer();
    return new Promise((res) => (this.lineResolve = res));
  }

  /** Ask the user a question mid-turn (for the ask_user tool); returns their answer. */
  async ask(question: string, options?: string[]): Promise<string> {
    this.stopThinking();
    stdout.write(`\x1b[36m? ${question}\x1b[0m\n`);
    if (options?.length) stdout.write(`${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n`);
    const ans = ((await this.readLine()) ?? "").trim();
    this.mode = "turn";
    if (options?.length) {
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    }
    return ans;
  }

  beginTurn(abort: AbortController, steer: string[]): void {
    this.mode = "turn";
    this.abort = abort;
    this.steer = steer;
    this.buf = "";
    this.startThinking();
  }

  endTurn(): void {
    this.stopThinking();
    this.mode = "idle";
  }

  /** First visible output of the turn: drop the spinner and open the reply on the ◆ line. */
  replyStart(): void {
    this.stopThinking();
    stdout.write(`${GOLD}◆${RST} `);
  }

  /** Approval prompt drawn inline; resolves on y / a / n. */
  confirm(label: string): Promise<"yes" | "all" | "no"> {
    this.stopThinking();
    this.mode = "confirm";
    stdout.write(`${GOLD}?${RST} ${label}  ${DIM}[y]es / [a]ll / [N]o${RST} `);
    return new Promise((res) => (this.confirmResolve = res));
  }

  // ---- internals ----
  private renderComposer(): void {
    const cols = stdout.columns || 80;
    const max = Math.max(8, cols - 3);
    const shown = this.buf.length > max ? `…${this.buf.slice(this.buf.length - max + 1)}` : this.buf;
    stdout.write(`\r\x1b[2K${GOLD}›${RST} ${shown}\x1b[7m \x1b[0m`); // trailing reverse-video = block cursor
  }

  private commitUser(text: string): void {
    stdout.write(`\r\x1b[2K${userBar(text, stdout.columns || 80)}\n`); // composer line becomes the bar
  }

  private startThinking(): void {
    this.thinking = true;
    this.thinkStart = Date.now();
    this.word = WORDS[Math.floor(Math.random() * WORDS.length)]!;
    this.renderThinking();
    this.thinkTimer = setInterval(() => {
      this.spin = (this.spin + 1) % SPIN.length;
      if (this.spin === 0) this.word = WORDS[Math.floor(Math.random() * WORDS.length)]!;
      this.renderThinking();
    }, 90);
  }

  private renderThinking(): void {
    const secs = Math.floor((Date.now() - this.thinkStart) / 1000); // live elapsed timer (design mockup)
    const meta = this.status ? `${this.status} · ${secs}s · esc to interrupt` : `${secs}s · esc to interrupt`;
    stdout.write(`\r\x1b[2K${GOLD}${SPIN[this.spin]}${RST} ${DIM}${this.word}…${RST}  ${DIM}(${meta})${RST}`);
  }

  private stopThinking(): void {
    if (this.thinkTimer) {
      clearInterval(this.thinkTimer);
      this.thinkTimer = null;
    }
    if (this.thinking) {
      stdout.write("\r\x1b[2K"); // erase the spinner line, leave cursor at column 0
      this.thinking = false;
    }
  }

  private key(s: string): void {
    if (this.mode === "confirm") {
      const k = s.toLowerCase();
      if (k === "y") this.resolveConfirm("yes");
      else if (k === "a") this.resolveConfirm("all");
      else if (k === "n" || k === "\r" || k === "\n" || k === "\x1b") this.resolveConfirm("no");
      return;
    }

    if (s === "\x03") {
      // Ctrl+C
      if (this.mode === "turn") this.abort?.abort();
      else if (this.lineResolve) {
        stdout.write("\n");
        this.lineResolve(this.buf ? "" : null); // empty prompt → exit
      }
      return;
    }
    if (s === "\x1b") {
      if (this.mode === "turn") this.abort?.abort();
      return;
    }
    if (s === "\x1b[A" || s === "\x1b[B") {
      if (this.mode === "line" && this.history.length) {
        if (s === "\x1b[A") this.hist = this.hist < 0 ? this.history.length - 1 : Math.max(0, this.hist - 1);
        else this.hist = this.hist < 0 ? -1 : this.hist + 1;
        this.buf = this.hist >= 0 && this.hist < this.history.length ? this.history[this.hist]! : "";
        this.renderComposer();
      }
      return;
    }
    if (s.startsWith("\x1b")) return; // ignore other escape sequences

    for (const ch of s) {
      if (ch === "\r" || ch === "\n") {
        const text = this.buf.trim();
        this.buf = "";
        if (this.mode === "line") {
          if (text) {
            this.history.push(text);
            this.commitUser(text); // echo exactly once, as the bar
          } else {
            stdout.write("\r\x1b[2K");
          }
          this.hist = -1;
          this.lineResolve?.(text);
        } else if (this.mode === "turn" && text) {
          this.steer?.push(text);
          stdout.write(`${DIM}  ↳ queued: ${text}${RST}\n`); // steer is captured blind, echoed on submit
        }
      } else if (ch === "\x7f" || ch === "\b") {
        this.buf = this.buf.slice(0, -1);
        if (this.mode === "line") this.renderComposer();
      } else if (ch >= " ") {
        this.buf += ch;
        if (this.mode === "line") this.renderComposer();
      }
    }
  }

  private resolveConfirm(d: "yes" | "all" | "no"): void {
    this.mode = "turn";
    const r = this.confirmResolve;
    this.confirmResolve = null;
    stdout.write("\n"); // finalize the prompt line
    r?.(d);
  }
}
