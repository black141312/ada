#!/usr/bin/env node
// ada backend — the routing server that holds provider keys. Same no-build launcher.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/server/index.ts", import.meta.url));
