# PROJECT_BRAIN — bots-manager

## Project Summary
Telegram-controlled supervisor for all 0xd bots. Manages startup/shutdown, log tailing, auto-updates, wallet balance checks across Base and Arbitrum.

## Current State
- **Status**: Was crashing on startup due to dead `RPC_URL` reference (fixed 2026-03-27)
- **Manages**: 4 bots (arb, liquidation, arb_arbitrum, liquidation_arbitrum)

## Architecture
- `manager.js` — single file, Telegram bot polling, process management
- `CHAIN_CONFIG` (lines 19-32) — per-chain RPC config (Base + Arbitrum)
- Telegram commands: /status, /start, /stop, /logs, /balance, etc.

## Active Tasks
- Verify clean startup after RPC_URL fix

## Blockers
- None currently

## Decisions Log
| Date | Decision | Why |
|---|---|---|
| 2026-03-27 | Replaced dead `RPC_URL` reference with `CHAIN_CONFIG` loop | `RPC_URL` and `PUBLIC_RPC_FALLBACKS` were never declared — Frankenstein leftover from single-chain era. Caused fatal crash on every startup. |

## Session Log

### 2026-03-27
**Done:**
1. Fixed fatal `RPC_URL is not defined` crash in manager.js line 790
2. Replaced with proper per-chain RPC logging from CHAIN_CONFIG
3. Pushed to gitDivine/bots-manager (master)

**Pending:**
- Confirm VPS restart succeeds
- Verify Telegram commands work

**Next:**
- User restarts on VPS: `cd ~/bots-manager && git pull && npm start`
