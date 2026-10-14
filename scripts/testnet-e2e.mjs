// Arc TESTNET end-to-end for ArcFlightCover on a demo market whose flights depart in a minute
// (sale cut-off 0, report window 1 h) so the whole life cycle fits in one run:
// underwriter funds the pool → two travellers buy → flights depart → 2-of-3 reporters post
// a 145-min delay for one flight and 20 min for the other → settle pays only the delayed one.
//
//   TESTNET_PRIVATE_KEY=0x… node testnet-e2e.mjs

import {readFileSync} from 'node:fs'
import {createPublicClient, createWalletClient, formatUnits, http, parseUnits} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {arcTestnet} from 'viem/chains'

const RPC = 'https://rpc.testnet.arc.network'
const EXPLORER = 'https://explorer.testnet.arc.io'
const key = process.env.TESTNET_PRIVATE_KEY
if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) throw new Error('TESTNET_PRIVATE_KEY required')

const lp = privateKeyToAccount(key)
const [t1, t2, r1, r2, r3] = [0, 1, 2, 3, 4].map(() => privateKeyToAccount(generatePrivateKey()))
const pub = createPublicClient({chain: arcTestnet, transport: http(RPC)})
const w = (a) => createWalletClient({account: a, chain: arcTestnet, transport: http(RPC)})
const {abi, bytecode} = JSON.parse(readFileSync(new URL('../contracts/out/ArcFlightCover.sol/ArcFlightCover.json', import.meta.url)))
const u = (n) => parseUnits(n, 18)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) process.exitCode = 1 }
async function send(a, label, req) {
  const hash = await w(a).writeContract(req)
  const r = await pub.waitForTransactionReceipt({hash})
  if (r.status !== 'success') throw new Error(`${label} reverted`)
  console.log(`✓ ${label}: ${EXPLORER}/tx/${hash}`)
}

const premium = u('0.002'), payout = u('0.04')
const h = await w(lp).deployContract({abi, bytecode: bytecode.object,
  args: [premium, payout, 120, 0, 3600, [r1.address, r2.address, r3.address], 2]})
const fc = (await pub.waitForTransactionReceipt({hash: h})).contractAddress
console.log(`✓ ArcFlightCover (demo market) deployed: ${EXPLORER}/address/${fc}`)
for (const a of [t1, t2, r1, r2]) await pub.waitForTransactionReceipt({hash: await w(lp).sendTransaction({to: a.address, value: u('0.01')})})

await send(lp, 'underwriter deposits 0.08 into the pool', {address: fc, abi, functionName: 'deposit', value: u('0.08')})
const dep = BigInt(Math.floor(Date.now() / 1000) + 45)
const A = 'LH1234 2026-10-05', B = 'AF77 2026-10-05'
await send(t1, `traveller 1 buys cover on ${A}`, {address: fc, abi, functionName: 'buy', args: [A, dep], value: premium})
await send(t2, `traveller 2 buys cover on ${B}`, {address: fc, abi, functionName: 'buy', args: [B, dep], value: premium})
try {
  await pub.simulateContract({account: t2, address: fc, abi, functionName: 'buy', args: [B, dep], value: premium})
  check(false, 'third policy sold beyond capital')
} catch (e) { check(e.message.includes('NotEnoughFreeCapital'), 'third policy refused: pool fully reserved (NotEnoughFreeCapital)') }

console.log('  waiting for departure…')
while (BigInt(Math.floor(Date.now() / 1000)) < dep + 5n) await sleep(3000)
const kA = await pub.readContract({address: fc, abi, functionName: 'flightKey', args: [A, dep]})
const kB = await pub.readContract({address: fc, abi, functionName: 'flightKey', args: [B, dep]})
await send(r1, `reporter 1: ${A} delayed 145 min`, {address: fc, abi, functionName: 'report', args: [kA, 145, false]})
await send(r2, `reporter 2: ${A} delayed 145 min → quorum`, {address: fc, abi, functionName: 'report', args: [kA, 145, false]})
await send(r1, `reporter 1: ${B} delayed 20 min`, {address: fc, abi, functionName: 'report', args: [kB, 20, false]})
await send(r2, `reporter 2: ${B} delayed 20 min → quorum`, {address: fc, abi, functionName: 'report', args: [kB, 20, false]})

const b1 = await pub.getBalance({address: t1.address}), b2 = await pub.getBalance({address: t2.address})
await send(lp, 'settleMany (permissionless)', {address: fc, abi, functionName: 'settleMany', args: [[0n, 1n]]})
check(await pub.getBalance({address: t1.address}) - b1 === payout, `traveller 1 paid ${formatUnits(payout, 18)} automatically (145 ≥ 120 min)`)
check(await pub.getBalance({address: t2.address}) === b2, 'traveller 2 not paid (20 min < threshold)')
check(await pub.readContract({address: fc, abi, functionName: 'reserved'}) === 0n, 'reserves released')
