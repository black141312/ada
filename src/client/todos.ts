// A task checklist the agent maintains via the update_todos tool, rendered like pi's todo view.

export interface Todo {
  text: string;
  status: "todo" | "doing" | "done";
}

let current: Todo[] = [];

export function setTodos(items: Todo[]): void {
  current = items;
}

export function getTodos(): Todo[] {
  return current;
}

export function renderTodos(): string {
  if (!current.length) return "\x1b[2m(no todos)\x1b[0m";
  const mark = (s: Todo["status"]): string =>
    s === "done" ? "\x1b[32m✓\x1b[0m" : s === "doing" ? "\x1b[38;5;214m▸\x1b[0m" : "\x1b[2m○\x1b[0m";
  return current.map((t) => `  ${mark(t.status)} ${t.status === "done" ? `\x1b[2m${t.text}\x1b[0m` : t.text}`).join("\n");
}
