# Arc Flight Cover

**Two hours late? You're paid before you leave the gate.** Parametric flight-delay cover on Arc:
underwriters pool USDC, travellers buy a fixed-payout policy per flight, a k-of-n reporter
committee posts the actual delay, and a delay over the threshold (or a cancellation) pays the
traveller automatically — no claim form, no adjuster, no six-week wait.

| | |
|---|---|
| **Contract** | `ArcFlightCover.sol` — one market per deployment, terms immutable |
| **Network** | Arc mainnet, chain ID `5042` (tested end to end on Arc testnet) |
| **Live app** | _TBD after deploy_ |
| **Deployed at** | _TBD after deploy_ |

## The problem

EU261-style compensation and travel insurance exist, but claiming means forms, proofs and weeks
of waiting — most delayed passengers never claim. Small, frequent payouts are uneconomic for
insurers because of claims handling, not because of risk.

## How it works

- **Market terms** (constructor, immutable): premium, payout, delay threshold (120 min), sales
  cut-off before departure (6 h), report window (2 days), reporters and quorum.
- **Underwriters** `deposit()` for pool shares; premiums accrue to the pool. `withdraw()` only
  from **free capital** (pool − reserved payouts).
- **Travellers** `buy(flight, departure)` with the exact premium. A policy is sold only if free
  capital covers its full payout — the pool is always fully reserved.
- **Reporters** post `(delayMinutes, cancelled)` after departure; the value `quorum` reporters
  agree on becomes final. Disagreement or silence → after the report window, `expire()` →
  premium refunded.
- **Settlement** is permissionless (`settle`, `settleMany`): delayed → payout, on time → nothing,
  no data → premium back.

## Why Arc specifically

- **One currency end to end.** Premiums, underwriting capital and payouts are all native USDC,
  so the pool's solvency is a plain comparison — no collateral token that can crash against the
  liability.
- **Finality on inclusion**: the payout is final while the traveller is still at the gate.
- **Cheap settlement**: a keeper can settle every policy of a flight for fractions of a cent,
  which is what makes "no claim needed" economically real.

## Tested end to end on Arc testnet

`scripts/testnet-e2e.mjs` runs a demo market (sale cut-off 0, departures one minute out):

- Market: [`0xfa16…70e1`](https://explorer.testnet.arc.io/address/0xfa1616512e20f9d38fe08020879b319bc2b870e1)
- Underwriter deposited 0.08; two travellers bought cover (premium 0.002, payout 0.04); a third
  policy was refused with `NotEnoughFreeCapital` — the pool was fully reserved.
- After departure, 2-of-3 reporters posted 145 min for LH1234 and 20 min for AF77.
- One `settleMany` paid LH1234's traveller 0.04 automatically, paid AF77's nothing, and released
  the reserves: [tx](https://explorer.testnet.arc.io/tx/0x49ee256aee66572c0ea035c113b77208e87a790a6c9b810e628c962ddff4c58e)

The web app was run against this market: live pool, reserved and free capital, "can sell N more
policies", buy form, reporter panel.

## Repository

```
contracts/  ArcFlightCover.sol + 9 tests (solvency, cut-off, quorum, no-data refund, LP shares)
            script/Deploy.s.sol — market terms from env (REPORTERS, QUORUM, PREMIUM_USDC, PAYOUT_USDC)
web/        Traveller (buy, policies, settle), underwriting pool, reporter panel
scripts/    testnet-e2e.mjs
```

## Known limits

- Insurance is regulated; this is a technical demo of parametric settlement, not an offering.
- Reporters are trusted (k-of-n). Production would source from multiple flight-data APIs and
  slash dishonest reporters' bonds.
- Fixed premium per market; risk-based pricing per route would be a separate market per route.
- LPs bear the full risk of correlated events (a storm grounding many covered flights).
