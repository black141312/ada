// Cross-platform niceties: detect WSL / tmux / Termux and read the OS clipboard accordingly.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PlatformInfo {
  os: NodeJS.Platform;
  wsl: boolean;
  tmux: boolean;
  termux: boolean;
}

export function platformInfo(): PlatformInfo {
  let wsl = false;
  try {
    wsl = process.platform === "linux" && existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    /* ignore */
  }
  return {
    os: process.platform,
    wsl,
    tmux: !!process.env.TMUX,
    termux: !!process.env.TERMUX_VERSION || (process.env.PREFIX ?? "").includes("com.termux"),
  };
}

/** Read text from the OS clipboard (best-effort; tries the right tool for the platform). */
export function readClipboard(): string {
  const p = platformInfo();
  const tries: Array<[string, string[]]> =
    p.os === "win32" || p.wsl
      ? [["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"]]]
      : p.os === "darwin"
        ? [["pbpaste", []]]
        : p.termux
          ? [["termux-clipboard-get", []]]
          : [
              ["wl-paste", []],
              ["xclip", ["-selection", "clipboard", "-o"]],
              ["xsel", ["-b"]],
            ];
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      if (r.status === 0 && r.stdout) return r.stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
    } catch {
      /* try the next tool */
    }
  }
  return "";
}

/** Best-effort desktop notification (+ terminal bell); ignores failures. */
export function notify(title: string, body: string): void {
  process.stdout.write("\x07"); // bell
  const p = platformInfo();
  try {
    if (p.os === "darwin") spawnSync("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
    else if (p.termux) spawnSync("termux-notification", ["-t", title, "-c", body]);
    else if (p.os === "linux") spawnSync("notify-send", [title, body]);
  } catch {
    /* ignore — the bell already fired */
  }
}

/** Read an image from the OS clipboard as a PNG data URL (best-effort), or null. */
export function readClipboardImage(): string | null {
  const p = platformInfo();
  const tmp = join(tmpdir(), `ada-clip-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  try {
    if (p.os === "win32" || p.wsl) {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){ $i.Save('${tmp}'); 'OK' } else { 'NONE' }`;
      const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
      if (!r.stdout || !r.stdout.includes("OK")) return null;
    } else if (p.os === "darwin") {
      if (spawnSync("pngpaste", [tmp]).status !== 0) return null;
    } else {
      spawnSync("sh", ["-c", `wl-paste --type image/png > '${tmp}' 2>/dev/null || xclip -selection clipboard -t image/png -o > '${tmp}' 2>/dev/null`]);
    }
    if (!existsSync(tmp) || statSync(tmp).size === 0) return null;
    return `data:image/png;base64,${readFileSync(tmp).toString("base64")}`;
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}
