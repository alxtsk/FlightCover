import {useCallback, useMemo, useRef, useState} from 'react'
import {ExternalLink, Loader2, Plane, Radio, ShieldCheck, Timer, Wallet} from 'lucide-react'
import {useQueryClient} from '@tanstack/react-query'
import {useAccount, useReadContract, useReadContracts} from 'wagmi'
import type {Address, Hex} from 'viem'
import {ConnectBar} from './components/ConnectBar'
import {ToastStack, type ToastState} from './components/Toast'
import {coverAbi} from './lib/abi'
import {activeChain, contractAddress, explorerAddress} from './lib/chain'
import {formatTimestamp, formatUsdc, shortAddress, toBaseUnits, validateAmount} from './lib/format'
import {useTx, type TxCallbacks} from './lib/tx'

const base = {abi: coverAbi, address: (contractAddress ?? undefined) as Address | undefined} as const
const OUTCOME = ['Waiting for reporters', 'On time — no payout', 'Delayed — paid', 'No data — premium refunded'] as const
const input = 'h-10 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink placeholder:text-faint focus:border-brand'

const PILLARS = [
  {Icon: Timer, title: 'Paid at the gate, not in six weeks', body: 'When the reporter quorum confirms a delay over the threshold, anyone can trigger settlement and the fixed payout lands in the traveller’s wallet.'},
  {Icon: ShieldCheck, title: 'Fully reserved, always', body: 'Every policy locks its full payout. A policy the pool can’t cover simply can’t be bought, and underwriters can only withdraw free capital.'},
  {Icon: Radio, title: 'k-of-n reporters, with a fallback', body: 'Reporters must agree on the same delay. If they never do, the traveller gets the premium back after the report window.'},
]

function Policies({cb}: {cb: TxCallbacks}) {
  const {address} = useAccount()
  const {run, busy} = useTx(cb)
  const ids = useReadContract({...base, functionName: 'policiesOf', args: address ? [address] : undefined, query: {enabled: Boolean(address), refetchInterval: 10_000}})
  const list = [...(ids.data ?? [])].reverse()
  const pols = useReadContracts({contracts: list.map((id) => ({...base, functionName: 'getPolicy', args: [id]}) as const), query: {enabled: list.length > 0, refetchInterval: 10_000}})
  const keys = (pols.data ?? []).map((p) => (p.result as {flightKey: Hex} | undefined)?.flightKey)
  const flights = useReadContracts({contracts: keys.filter(Boolean).map((k) => ({...base, functionName: 'flights', args: [k!]}) as const), query: {enabled: keys.some(Boolean), refetchInterval: 10_000}})
  if (!address || list.length === 0) return null
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-ink">Your policies</h2>
      {list.map((id, i) => {
        const p = pols.data?.[i]?.result as {settled: boolean} | undefined
        const f = flights.data?.[i]?.result as readonly [bigint, number, number, number] | undefined
        const outcome = f?.[1] ?? 0
        return (
          <article key={id.toString()} className="tnum flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
            <span className="text-ink">Policy #{id.toString()} · departs {f ? formatTimestamp(f[0]) : '…'}{f && outcome > 0 && outcome < 3 ? ` · delay ${f[2]} min` : ''}</span>
            <span className={outcome === 2 ? 'text-paid' : outcome === 0 ? 'text-muted' : 'text-faint'}>{OUTCOME[outcome]}{p?.settled ? ' · settled' : ''}</span>
            {outcome > 0 && p && !p.settled && (
              <button type="button" disabled={busy !== null} onClick={() => run(`s${id}`, {pending: 'Settling', success: 'Settled'}, {abi: coverAbi, address: contractAddress!, functionName: 'settle', args: [id]})}
                className="h-8 cursor-pointer rounded-lg bg-brand px-3 text-xs font-semibold text-on-brand disabled:opacity-45">Settle now</button>
            )}
          </article>
        )
      })}
    </section>
  )
}

export default function App() {
  const {address} = useAccount()
  const queryClient = useQueryClient()
  const [toasts, setToasts] = useState<ToastState[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])
  const push = useCallback((t: Omit<ToastState, 'id'>) => setToasts([{...t, id: nextId.current++}]), [])
  const cb: TxCallbacks = useMemo(() => ({
    onPending: (hash, label) => push({kind: 'pending', title: label, detail: 'Waiting for Arc to include the transaction.', hash}),
    onSuccess: (hash, label) => { push({kind: 'success', title: label, detail: 'Final on Arc.', hash}); queryClient.invalidateQueries() },
    onError: (message) => push({kind: 'error', title: 'Transaction failed', detail: message}),
  }), [push, queryClient])
  const {run, busy} = useTx(cb)

  const reads = useReadContracts({contracts: (['premium', 'payout', 'delayThresholdMinutes', 'saleCutoff', 'freeCapital', 'reserved', 'poolValue', 'totalShares'] as const)
    .map((fn) => ({...base, functionName: fn}) as const), query: {enabled: Boolean(contractAddress), refetchInterval: 10_000}})
  const [premium, payout, threshold, cutoff, free, reserved, pool, totalShares] = (reads.data ?? []).map((r) => r.result as bigint | number | undefined)
  const myShares = useReadContract({...base, functionName: 'sharesOf', args: address ? [address] : undefined, query: {enabled: Boolean(address)}})
  const isRep = useReadContract({...base, functionName: 'isReporter', args: address ? [address] : undefined, query: {enabled: Boolean(address)}})

  const [flight, setFlight] = useState('LH1234')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('10:30')
  const [dep, setDep] = useState('')
  const [wd, setWd] = useState('')
  const [rFlight, setRFlight] = useState('')
  const [rDate, setRDate] = useState('')
  const [rTime, setRTime] = useState('')
  const [rDelay, setRDelay] = useState('')
  const [rCancelled, setRCancelled] = useState(false)

  const departure = date && time ? BigInt(Math.floor(new Date(`${date}T${time}`).getTime() / 1000)) : 0n
  const flightId = `${flight.trim().toUpperCase()} ${date}`
  const rDeparture = rDate && rTime ? BigInt(Math.floor(new Date(`${rDate}T${rTime}`).getTime() / 1000)) : 0n
  const rKey = useReadContract({...base, functionName: 'flightKey', args: rFlight && rDeparture ? [`${rFlight.trim().toUpperCase()} ${rDate}`, rDeparture] : undefined,
    query: {enabled: Boolean(rFlight && rDeparture)}})
  const myValue = pool && totalShares && myShares.data ? (myShares.data * (pool as bigint)) / (totalShares as bigint) : 0n

  return (
    <div className="min-h-dvh">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] grid-veil" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4 py-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-brand text-on-brand"><Plane className="size-5" aria-hidden="true" /></span>
            <div><p className="text-[15px] font-semibold leading-tight text-ink">Arc Flight Cover</p><p className="text-xs text-muted">Parametric delay insurance, paid automatically</p></div>
          </div>
          <ConnectBar />
        </header>
        <section className="py-8 sm:py-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted">
            <span className="size-1.5 rounded-full bg-paid" aria-hidden="true" /> Live on {activeChain.name} · chain {activeChain.id}
          </span>
          <h1 className="mt-5 max-w-3xl text-3xl font-semibold leading-[1.15] tracking-tight text-ink text-balance sm:text-5xl">Two hours late? You’re paid before you leave the gate.</h1>
          <dl className="mt-8 grid gap-4 sm:grid-cols-3">
            {PILLARS.map(({Icon, title, body}) => (
              <div key={title} className="rounded-xl border border-line bg-surface/60 p-4">
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon className="size-4 text-brand" aria-hidden="true" /> {title}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted">{body}</dd>
              </div>
            ))}
          </dl>
        </section>
        {!contractAddress && <div role="alert" className="mb-8 rounded-xl border border-pending/30 bg-pending-bg/40 p-4 text-sm text-muted">Set <code className="tnum rounded bg-canvas px-1.5 py-0.5 text-brand">VITE_CONTRACT_ADDRESS</code> in web/.env.</div>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:items-start">
          <div className="space-y-6">
            <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-ink">Cover a flight</h2>
              <p className="tnum mt-1 text-sm text-muted">
                Pay {premium ? formatUsdc(premium as bigint, 4) : '…'} USDC · get {payout ? formatUsdc(payout as bigint) : '…'} USDC if it’s ≥ {String(threshold ?? '…')} min late or cancelled ·
                sales close {cutoff !== undefined ? `${Number(cutoff) / 3600} h` : '…'} before departure
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <input aria-label="Flight number" className={`${input} tnum`} value={flight} onChange={(e) => setFlight(e.target.value)} placeholder="LH1234" />
                <input aria-label="Departure date" type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
                <input aria-label="Scheduled departure time (local)" type="time" className={input} value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <button type="button" disabled={!address || !premium || !departure || busy !== null}
                onClick={() => run('buy', {pending: 'Buying cover', success: 'Covered — nothing else to do'}, {abi: coverAbi, address: contractAddress!, functionName: 'buy', args: [flightId, departure], value: premium as bigint})}
                className="mt-3 inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg bg-brand px-5 font-semibold text-on-brand disabled:opacity-45">
                {busy === 'buy' && <Loader2 className="size-4 animate-spin" />} Buy cover for {flightId.trim() || 'this flight'}
              </button>
            </section>
            <Policies cb={cb} />
          </div>

          <aside className="space-y-4">
            <section className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink"><Wallet className="size-4 text-brand" /> Underwriting pool</h2>
              <dl className="tnum mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-canvas/60 px-3 py-2"><dt className="text-[11px] uppercase text-faint">Pool</dt><dd className="font-semibold text-ink">{pool !== undefined ? formatUsdc(pool as bigint) : '—'}</dd></div>
                <div className="rounded-lg bg-canvas/60 px-3 py-2"><dt className="text-[11px] uppercase text-faint">Reserved</dt><dd className="font-semibold text-ink">{reserved !== undefined ? formatUsdc(reserved as bigint) : '—'}</dd></div>
                <div className="col-span-2 rounded-lg bg-canvas/60 px-3 py-2"><dt className="text-[11px] uppercase text-faint">Free capital · can sell {free && payout ? String((free as bigint) / (payout as bigint)) : 0} more policies</dt><dd className="font-semibold text-ink">{free !== undefined ? formatUsdc(free as bigint) : '—'}</dd></div>
              </dl>
              {address && <p className="tnum mt-2 text-xs text-muted">Your stake ≈ {formatUsdc(myValue)} USDC</p>}
              <div className="mt-3 flex gap-2">
                <input aria-label="Deposit amount" inputMode="decimal" className={`${input} tnum`} value={dep} onChange={(e) => setDep(e.target.value)} placeholder="Deposit USDC" />
                <button type="button" disabled={!address || Boolean(validateAmount(dep)) || busy !== null}
                  onClick={() => run('dep', {pending: 'Depositing', success: 'Capital added'}, {abi: coverAbi, address: contractAddress!, functionName: 'deposit', value: toBaseUnits(dep)}, () => setDep(''))}
                  className="h-10 shrink-0 cursor-pointer rounded-lg bg-brand px-3 text-sm font-semibold text-on-brand disabled:opacity-45">Add</button>
              </div>
              <div className="mt-2 flex gap-2">
                <input aria-label="Withdraw share percent" inputMode="decimal" className={`${input} tnum`} value={wd} onChange={(e) => setWd(e.target.value)} placeholder="Withdraw % of stake" />
                <button type="button" disabled={!myShares.data || !(Number(wd) > 0 && Number(wd) <= 100) || busy !== null}
                  onClick={() => run('wd', {pending: 'Withdrawing', success: 'Withdrawn'}, {abi: coverAbi, address: contractAddress!, functionName: 'withdraw', args: [(myShares.data! * BigInt(Math.round(Number(wd) * 100))) / 10_000n]}, () => setWd(''))}
                  className="h-10 shrink-0 cursor-pointer rounded-lg border border-line px-3 text-sm font-medium text-ink disabled:opacity-45">Withdraw</button>
              </div>
            </section>
            {isRep.data && (
              <section className="rounded-2xl border border-line bg-surface p-5">
                <h2 className="flex items-center gap-2 text-base font-semibold text-ink"><Radio className="size-4 text-brand" /> Report a flight</h2>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <input aria-label="Flight" className={`${input} tnum`} value={rFlight} onChange={(e) => setRFlight(e.target.value)} placeholder="LH1234" />
                  <input aria-label="Date" type="date" className={input} value={rDate} onChange={(e) => setRDate(e.target.value)} />
                  <input aria-label="Time" type="time" className={input} value={rTime} onChange={(e) => setRTime(e.target.value)} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input aria-label="Delay minutes" inputMode="numeric" className={`${input} tnum`} value={rDelay} onChange={(e) => setRDelay(e.target.value)} placeholder="Delay, minutes" />
                  <label className="flex shrink-0 items-center gap-1 text-sm text-muted"><input type="checkbox" checked={rCancelled} onChange={(e) => setRCancelled(e.target.checked)} /> cancelled</label>
                </div>
                <button type="button" disabled={!rKey.data || !(Number(rDelay) >= 0) || rDelay === '' || busy !== null}
                  onClick={() => run('rep', {pending: 'Reporting', success: 'Report recorded'}, {abi: coverAbi, address: contractAddress!, functionName: 'report', args: [rKey.data!, Number(rDelay), rCancelled]})}
                  className="mt-2 h-10 w-full cursor-pointer rounded-lg bg-brand text-sm font-semibold text-on-brand disabled:opacity-45">Submit report</button>
              </section>
            )}
          </aside>
        </div>
        <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm text-faint">
          <p>Built on Arc · premiums, capital and payouts in native USDC</p>
          {contractAddress && <a href={explorerAddress(contractAddress)} target="_blank" rel="noreferrer" className="tnum inline-flex items-center gap-1.5 hover:text-ink">Market {shortAddress(contractAddress)} <ExternalLink className="size-3.5" aria-hidden="true" /></a>}
        </footer>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
