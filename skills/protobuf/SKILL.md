---
name: protobuf
description: Design protobuf schemas that stay backward- and forward-compatible as they evolve
category: networking
---

# Protobuf

Reach for this when designing the wire format for messages shared across services, languages, or versions. The schema is a long-lived contract — design it for change.

1. Start a `.proto` with `syntax = "proto3";`, a stable `package`, and one message per logical entity; keep messages small and composable.
2. Assign field tags deliberately: 1–15 (single-byte) for the hottest fields, and never change a tag once it ships.
3. Choose precise types — `int32`/`int64`/`bool`/`string`/`bytes`, `repeated` for lists, `map<k,v>` for dictionaries, and nested messages over flat blobs.
4. Use `enum` with a `0` value named `*_UNSPECIFIED` as the default, and `oneof` for mutually exclusive fields.
5. Evolve safely: add new fields with new tags, and `reserved` the tags/names of anything you remove.
6. Lint and check compatibility (`buf lint`, `buf breaking`) in CI so breaking changes are caught before merge.

## Rules
- Field tags are the contract, not field names — renaming a field is safe on the wire, renumbering is catastrophic.
- Every `enum` must have a `0 = *_UNSPECIFIED` member; proto3 treats `0` as the default and you can't tell "unset" from "first value" otherwise.
- Don't change a field's type (e.g. `int32`→`string`) in place — add a new field and migrate; type changes corrupt decoding.
- Reserve removed tags AND names (`reserved 4; reserved "old_name";`) so nobody silently reuses them.
- Prefer explicit messages over `Any`/`Struct`/JSON-in-a-string; you lose type safety and compatibility checking.
