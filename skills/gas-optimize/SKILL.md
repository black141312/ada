---
name: gas-optimize
description: Reduce a contract's gas cost by measuring hotspots and applying proven storage/logic optimizations
category: web3
---

# Gas Optimize

Reach for this after a contract is correct and tested, to cut deployment and per-call gas. Measure first — never optimize blind.

1. Baseline: run `forge test --gas-report` (or `hardhat-gas-reporter`) and `forge snapshot` to capture current costs per function.
2. Attack storage — the biggest lever: pack variables into single 32-byte slots, shrink types where safe, cache `storage` reads in `memory`/local vars inside loops, and use `immutable`/`constant` for fixed values.
3. Tighten loops: cache `array.length`, avoid repeated SLOADs, prefer `unchecked` increments where overflow is impossible (post-0.8).
4. Trim logic: replace `require`-strings with custom errors, use `calldata` over `memory` for read-only external args, mark functions `external`, and short-circuit cheap conditions first.
5. Tune the compiler: set the `optimizer` runs to match usage (low runs = cheaper deploy, high runs = cheaper calls); consider Yul/inline assembly only as a last resort.
6. Re-measure after each change with `forge snapshot --diff`; keep changes that help, revert those that don't.
7. Re-run the full test suite — confirm optimizations changed cost, not behavior.

## Rules
- Always measure before and after; an "obvious" optimization can cost more after compiler optimization.
- Never sacrifice safety for gas — keep reentrancy guards, overflow checks, and access control intact.
- Only use `unchecked` when you can prove the arithmetic cannot overflow/underflow.
- Storage (SSTORE/SLOAD) dominates cost; optimize slot packing and read caching before micro-tweaks.
- Avoid assembly unless the gas win is large, tested, and commented — it removes safety nets.
- Watch the storage-layout: reordering variables can break upgradeable/proxy contracts.
