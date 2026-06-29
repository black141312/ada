---
name: web3-frontend
description: Wire a dapp frontend to contracts with wagmi/viem (or ethers) for wallet, reads, and writes
category: web3
---

# Web3 Frontend

Use when connecting a React/Next dapp to on-chain contracts. Prefer wagmi + viem for typed, hook-based access; ethers is the fallback.

1. Install and configure: `wagmi`, `viem`, and a connector kit (RainbowKit/ConnectKit); define `chains`, transports (RPC URLs from env), and wrap the app in `WagmiProvider` + a React Query client.
2. Handle connection: render a connect button, read account/chain via `useAccount`/`useChainId`, and prompt a network switch when the wrong chain is active.
3. Load typed ABIs: import the contract ABI `as const` so viem infers argument and return types.
4. Read state with `useReadContract`/`useReadContracts`; batch related reads and key cache invalidation on the relevant block/account.
5. Send transactions with `useWriteContract` + `useWaitForTransactionReceipt`; surface pending → confirmed → error states in the UI.
6. Decode reverts and events into human-readable messages; format token amounts with `formatUnits`/`parseUnits` using the token's decimals.
7. Test against a local fork/testnet (Anvil/Hardhat) before pointing at mainnet.

## Rules
- Never hardcode private keys or seed phrases in frontend code — the wallet signs, the app never holds keys.
- Put RPC URLs and API keys in env vars and proxy paid RPC through a backend to avoid leaking quota.
- Always check `chainId` and the connected account before a write; guard against wrong-network sends.
- Use `parseUnits`/`formatUnits` with correct decimals; never do token math in floats.
- Show explicit loading/pending/error states — transactions are async and can fail or be dropped.
- Validate addresses (`isAddress`) and handle user rejection (code 4001) gracefully.
