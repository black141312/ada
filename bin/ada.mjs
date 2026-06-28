#!/usr/bin/env node
// ada — terminal coding agent. Registers the tsx loader so the TypeScript client
// runs with no build step, then hands off to the CLI entrypoint (which self-runs).
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/client/cli.ts", import.meta.url));
