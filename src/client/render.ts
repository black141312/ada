// Terminal rendering: colored edit diffs + a streaming markdown styler with light,
// dependency-free syntax highlighting. Colors come from a theme (ADA_THEME=dark|light).

const ESC = "\x1b[";
const wrap = (code: string) => (s: string) => `${ESC}${code}m${s}${ESC}0m`;
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");
export const dim = wrap("2");
export const bold = wrap("1");
const magenta = wrap("35");
const blue = wrap("34");

interface Theme {
  heading: (s: string) => string;
  bullet: (s: string) => string;
  inlineCode: (s: string) => string;
  keyword: (s: string) => string;
  str: (s: string) => string;
  comment: (s: string) => string;
  num: (s: string) => string;
  meta: (s: string) => string;
  add: (s: string) => string;
  del: (s: string) => string;
}

const THEMES: Record<string, Theme> = {
  dark: { heading: bold, bullet: yellow, inlineCode: cyan, keyword: magenta, str: green, comment: dim, num: yellow, meta: dim, add: green, del: red },
  light: { heading: bold, bullet: blue, inlineCode: blue, keyword: magenta, str: green, comment: dim, num: yellow, meta: dim, add: green, del: red },
};

export const theme: Theme = THEMES[process.env.ADA_THEME ?? "dark"] ?? THEMES.dark!;

// A small, language-agnostic keyword set — enough to make most code blocks readable.
const KEYWORDS = new Set(
  ("const let var function return if else for while class new import export from async await try catch finally throw " +
    "typeof instanceof of in do switch case break continue default extends implements interface type enum namespace " +
    "public private protected static readonly void null undefined true false this super yield " +
    "def lambda elif fn pub use struct impl match mut self None True False and or not is with as pass raise " +
    "package func go defer chan map range select")
    .split(" "),
);

/** Index of a line comment (`//` or `#`) not inside a string, or -1. */
function commentStart(line: string): number {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q && line[i - 1] !== "\\") q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return i;
    if (c === "#") return i;
  }
  return -1;
}

/** Heuristic syntax highlight for a single code line: strings, numbers, keywords, comments. */
export function highlight(line: string): string {
  const ci = commentStart(line);
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const comment = ci >= 0 ? line.slice(ci) : "";
  const colored = code.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)/g,
    (m, str, num, word) => {
      if (str) return theme.str(str);
      if (num) return theme.num(num);
      if (word && KEYWORDS.has(word)) return theme.keyword(word);
      return m;
    },
  );
  return colored + (comment ? theme.comment(comment) : "");
}

/** A colored diff for an exact edit (old_text → new_text), trimming shared head/tail lines
 *  so only the changed region is shown. */
export function renderEditDiff(path: string, oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const out: string[] = [theme.meta(path)];
  for (const l of a.slice(pre, a.length - suf)) out.push(theme.del(`- ${l}`));
  for (const l of b.slice(pre, b.length - suf)) out.push(theme.add(`+ ${l}`));
  return out.map((l) => `  ${l}`).join("\n");
}

/** Styles streamed assistant text line-by-line (markdown). Feed deltas to push(); it returns
 *  the styled, already-completed lines to print and buffers the in-progress line until its
 *  newline arrives. Call end() once the stream finishes to flush the last partial line. */
export class MarkdownStreamer {
  private buf = "";
  private inCode = false;

  push(text: string): string {
    this.buf += text;
    let out = "";
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      out += `${this.styleLine(this.buf.slice(0, nl))}\n`;
      this.buf = this.buf.slice(nl + 1);
    }
    return out;
  }

  end(): string {
    if (!this.buf) return "";
    const out = this.styleLine(this.buf);
    this.buf = "";
    return out;
  }

  private styleLine(line: string): string {
    if (/^\s*```/.test(line)) {
      this.inCode = !this.inCode;
      return theme.meta(line);
    }
    if (this.inCode) return highlight(line);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) return theme.heading(heading[1]!);
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) return `${bullet[1]}${theme.bullet("•")} ${this.inline(bullet[2]!)}`;
    return this.inline(line);
  }

  private inline(s: string): string {
    return s.replace(/\*\*([^*]+)\*\*/g, (_, m) => bold(m)).replace(/`([^`]+)`/g, (_, m) => theme.inlineCode(m));
  }
}
