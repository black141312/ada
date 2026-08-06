// Ink-based TUI: same Agent, rendered with React. The transcript is committed to <Static>
// (user bars, finished replies), the in-flight reply streams in a live region, and the footer
// holds the composer (ink-text-input), a spinner while the model works, and inline y/a/n
// approval prompts. The agent's `onEvent` stream already carries ANSI-styled markdown and
// ⏺ tool lines, so items render as raw <Text> — no markdown logic here.

import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
// Default React import is required: when ada runs from another directory, tsx may not find
// this repo's tsconfig and falls back to the classic JSX transform (React.createElement).
import React, { type JSX, useEffect, useRef, useState } from "react";
import type { Agent } from "./agent.ts";
import { setAsker } from "./tools.ts";
import type { AskOption } from "./tools.ts";

const GOLD = "#ffaf00"; // ada accent (xterm 214)
const WORDS = ["Cogitating", "Pondering", "Noodling", "Percolating", "Ruminating", "Tinkering", "Untangling", "Brewing", "Mulling", "Crunching"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Item =
  | { id: number; kind: "header"; text: string }
  | { id: number; kind: "user" | "reply" | "ask" | "error" | "info"; text: string };

function ItemView({ item }: { item: Item }): JSX.Element {
  switch (item.kind) {
    case "header":
      return <Text>{item.text}</Text>;
    case "user":
      return (
        <Box marginTop={1} width="100%" backgroundColor="#3a3a3a" paddingX={1}>
          <Text bold>
            <Text color={GOLD}>{"› "}</Text>
            <Text color="white">{item.text}</Text>
          </Text>
        </Box>
      );
    case "reply":
      return (
        <Box marginTop={1}>
          <Text color={GOLD}>{"◆ "}</Text>
          <Text>{item.text.replace(/^\n+/, "")}</Text>
        </Box>
      );
    case "info":
      return <Text dimColor>{item.text}</Text>;
    case "ask":
      return <Text color="cyan">{`? ${item.text}`}</Text>;
    case "error":
      return (
        <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
          <Text color="red">{item.text}</Text>
        </Box>
      );
  }
}

function AdaApp({ agent, model }: { agent: Agent; model: string }): JSX.Element {
  const { exit } = useApp();
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>([
    {
      id: 0,
      kind: "header",
      text:
        `\x1b[38;5;214m█▀█ █▀▄ █▀█\n█▀█ █▄▀ █▀█\x1b[0m  \x1b[2m${model}\x1b[0m\n` +
        `\x1b[2mAsk me to build, edit, or explain code in ${process.cwd()}\x1b[0m\n`,
    },
  ]);
  const [input, setInput] = useState("");
  const [queued, setQueued] = useState<string[]>([]);
  const [live, setLive] = useState("");
  const [running, setRunning] = useState(false);
  const [tokens, setTokens] = useState(agent.contextTokens());
  const [confirm, setConfirm] = useState<{ risk: string; detail: string; danger: boolean; resolve: (d: "yes" | "all" | "no") => void } | null>(null);
  const [asking, setAsking] = useState<{ options?: AskOption[]; resolve: (s: string) => void } | null>(null);
  const [word, setWord] = useState(WORDS[0]!);
  const [secs, setSecs] = useState(0);
  const [spin, setSpin] = useState(0);

  const liveRef = useRef("");
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const steerRef = useRef<string[]>([]);
  const hist = useRef<{ list: string[]; i: number }>({ list: [], i: -1 });

  const push = (kind: Exclude<Item["kind"], "header">, text: string): void =>
    setItems((prev) => [...prev, { id: nextId.current++, kind, text }]);

  agent.setOnApprove(
    (name, summary) =>
      new Promise((resolve) => {
        // summary is "<permission phrase>\n<detail>" (same contract as the REPL's approvePrompt)
        const nl = summary.indexOf("\n");
        const risk = ((nl >= 0 ? summary.slice(0, nl) : summary) || `run the ${name} tool`).trim();
        setConfirm({ risk: risk.replace(/^⚠ /, ""), danger: risk.startsWith("⚠"), detail: nl >= 0 ? summary.slice(nl + 1).trim() : "", resolve });
      }),
  );
  setAsker(
    (question, options) =>
      new Promise((resolve) => {
        push(
          "ask",
          options?.length ? `${question}\n${options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}` : question,
        );
        setAsking({ options, resolve });
      }),
  );

  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setSecs(0);
    setWord(WORDS[Math.floor(Math.random() * WORDS.length)]!);
    const t = setInterval(() => {
      setSecs(Math.floor((Date.now() - start) / 1000));
      setSpin((s) => (s + 1) % SPIN.length);
      if (Math.random() < 0.05) setWord(WORDS[Math.floor(Math.random() * WORDS.length)]!);
    }, 120);
    return () => clearInterval(t);
  }, [running]);

  const run = async (text: string): Promise<void> => {
    const abort = new AbortController();
    abortRef.current = abort;
    steerRef.current = [];
    liveRef.current = "";
    setLive("");
    setRunning(true);
    runningRef.current = true;
    let error = "";
    try {
      await agent.send(text, {
        signal: abort.signal,
        steer: steerRef.current,
        onEvent: (e) => {
          if (e.type === "text") {
            liveRef.current += e.delta;
            setLive(liveRef.current);
            setQueued((q) => (q.length === steerRef.current.length ? q : [...steerRef.current])); // reflect drained steers
          } else if (e.type === "done" && e.context) setTokens(e.context);
        },
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (liveRef.current.trim()) push("reply", liveRef.current);
      if (error) push("error", error);
      liveRef.current = "";
      setLive("");
      setQueued([]);
      setRunning(false);
      runningRef.current = false;
      setTokens(agent.contextTokens());
    }
  };

  const submit = (raw: string): void => {
    const text = raw.trim();
    setInput("");
    if (asking) {
      setAsking(null);
      const n = Number(text);
      const opts = asking.options;
      asking.resolve(opts?.length && Number.isInteger(n) && n >= 1 && n <= opts.length ? opts[n - 1]!.label : text);
      return;
    }
    if (!text) return;
    hist.current.list.push(text);
    hist.current.i = -1;
    if (text === "/exit" || text === "/quit") return exit();
    if (text.startsWith("/") && !text.includes(" ") && text.length > 1) {
      // ponytail: TUI only implements /exit; other commands live in the plain REPL for now
      push("user", text);
      push("info", `  ${text} isn't wired up in the TUI yet — run ada without --tui for slash commands. (Not sent to the model.)`);
      return;
    }
    if (runningRef.current) {
      steerRef.current.push(text);
      setQueued([...steerRef.current]);
      return;
    }
    push("user", text);
    void run(text);
  };

  useInput((ch, key) => {
    if (confirm) {
      const k = ch.toLowerCase();
      const done = (d: "yes" | "all" | "no"): void => {
        setConfirm(null);
        const mark = d === "no" ? "✗ denied" : d === "all" ? "✓ approved · always this session" : "✓ approved";
        push("info", `${mark} — ${confirm.risk}`);
        confirm.resolve(d);
      };
      if (k === "y") done("yes");
      else if (k === "a") done("all");
      else if (k === "n" || key.return || key.escape) done("no");
      return;
    }
    if (key.escape && runningRef.current) return abortRef.current?.abort();
    if (key.ctrl && ch === "c") {
      if (runningRef.current) abortRef.current?.abort();
      else exit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (runningRef.current) {
        // ↑ pulls the newest queued steer back into the composer for editing
        if (key.upArrow && steerRef.current.length) {
          const t = steerRef.current.pop()!;
          setQueued([...steerRef.current]);
          setInput(t);
        }
        return;
      }
      if (hist.current.list.length) {
        const h = hist.current;
        if (key.upArrow) h.i = h.i < 0 ? h.list.length - 1 : Math.max(0, h.i - 1);
        else h.i = h.i < 0 ? -1 : h.i + 1;
        setInput(h.i >= 0 && h.i < h.list.length ? h.list[h.i]! : "");
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      {live.trim() ? (
        <Box marginTop={1}>
          <Text color={GOLD}>{"◆ "}</Text>
          <Text>{live.replace(/^\n+/, "")}</Text>
        </Box>
      ) : null}
      {running && !confirm && !asking ? (
        <Text>
          <Text color={GOLD}>{`${SPIN[spin]} `}</Text>
          <Text dimColor>{`${word}… (${secs}s · esc to interrupt)`}</Text>
        </Text>
      ) : null}
      {confirm ? (
        <Box flexDirection="column" borderStyle="round" borderColor={confirm.danger ? "red" : "yellow"} paddingX={1} marginTop={1}>
          <Text bold>
            {confirm.danger ? <Text color="red">{"⚠ "}</Text> : null}ada wants to {confirm.risk}
          </Text>
          {confirm.detail ? <Text dimColor>{confirm.detail}</Text> : null}
          <Text dimColor>y = yes · a = always this session · n or esc = no</Text>
        </Box>
      ) : null}
      {queued.length ? (
        <Box flexDirection="column" width="100%" backgroundColor="#2e2e2e" paddingX={1} marginTop={1}>
          {queued.map((q, i) => (
            <Text key={i} dimColor>
              <Text color={GOLD}>{"› "}</Text>
              {q}
            </Text>
          ))}
        </Box>
      ) : null}
      {!confirm ? (
        <Box width="100%" borderStyle="round" borderColor="#555555" paddingX={1} marginTop={1}>
          <Text color={GOLD}>{"› "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={queued.length ? "press ↑ to edit queued messages" : ""} />
        </Box>
      ) : null}
      <Box width="100%" justifyContent="space-between" borderStyle="single" borderColor="#333333" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>{running ? "esc to interrupt · enter to queue" : "/exit to quit"}</Text>
        <Text dimColor>{`${model} · ~${tokens} tok`}</Text>
      </Box>
    </Box>
  );
}

export async function runInkTui(agent: Agent, model: string): Promise<void> {
  const app = render(<AdaApp agent={agent} model={model} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
}
