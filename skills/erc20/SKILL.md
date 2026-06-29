---
name: erc20
description: Implement a standards-compliant ERC-20 token using OpenZeppelin with tests
category: web3
---

# ERC-20 Token

Reach for this to ship a fungible token. Extend OpenZeppelin's audited base rather than implementing the standard by hand.

1. Inherit `ERC20` from OpenZeppelin and set name/symbol in the constructor; decimals default to 18 unless you override for a reason.
2. Decide supply policy: fixed (mint all in constructor) or mintable (`ERC20` + `Ownable`/`AccessControl` gating `mint`); add `ERC20Burnable` only if burning is intended.
3. Add only the extensions you need — `ERC20Permit` (EIP-2612 gasless approvals), `ERC20Pausable`, `ERC20Capped` — and avoid feature creep.
4. Wire access control: restrict `mint`/`pause` to roles, never leave them public.
5. Write tests covering transfer, `approve`/`transferFrom`, allowance edge cases, zero-address reverts, and supply invariants.
6. Deploy with a script that records the token address, then verify the source on the block explorer (Etherscan/Sourcify).

## Rules
- Do not reimplement transfer/allowance logic — inherit it; custom logic reintroduces known bugs.
- Be aware of the `approve` race; prefer `ERC20Permit` or increase/decrease-allowance patterns.
- Never override `decimals()` casually — wallets and integrators assume the value you publish.
- Gate `mint` and `pause`; an open mint function is an instant exploit.
- Don't add transfer fees/rebasing without warning — they break DEXes and many integrators.
- Account for decimals in every amount; mixing raw and human units is a common bug.
