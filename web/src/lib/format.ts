import {formatUnits, parseUnits} from 'viem'

/*
  Arc exposes one USDC balance through two interfaces: native, which `msg.value` and
  every balance in this app speak, at 18 decimals; and ERC-20 at 0x3600..., at 6.
  Everything below is native. Mixing the two is the single easiest way to be wrong by
  a factor of a trillion, so the constant is named rather than inlined.
*/
export const USDC_NATIVE_DECIMALS = 18

/** Human string ("250.5") to native base units. Throws on anything unparseable. */
export function toBaseUnits(amount: string): bigint {
  return parseUnits(amount.trim(), USDC_NATIVE_DECIMALS)
}

/** Base units to a grouped display string: 1250000000000000000000n -> "1,250.00" */
export function formatUsdc(value: bigint, maxFractionDigits = 2): string {
  const asDecimal = formatUnits(value, USDC_NATIVE_DECIMALS)
  const n = Number(asDecimal)

  // Below the display precision but non-zero, say so instead of rendering "0.00".
  if (value > 0n && n < 10 ** -maxFractionDigits) return `<0.${'0'.repeat(maxFractionDigits - 1)}1`

  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, maxFractionDigits),
  })
}

/**
 * Validates an amount the way the contract does, before the user spends gas finding
 * out. Returns an error string, or null when the value is good.
 */
export function validateAmount(raw: string): string | null {
  const v = raw.trim()
  if (!v) return 'Enter an amount.'
  if (!/^\d*\.?\d*$/.test(v)) return 'Use digits and a single decimal point.'

  const [, fraction = ''] = v.split('.')
  if (fraction.length > USDC_NATIVE_DECIMALS) {
    return `At most ${USDC_NATIVE_DECIMALS} decimal places.`
  }

  let units: bigint
  try {
    units = toBaseUnits(v)
  } catch {
    return 'That is not a valid amount.'
  }
  if (units === 0n) return 'Amount must be greater than zero.'
  return null
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export const isAddress = (v: string) => ADDRESS_RE.test(v.trim())

/** Mirrors the contract's MAX_TEXT_LENGTH, which counts bytes, not characters. */
export const MAX_TEXT_BYTES = 280

export const byteLength = (s: string) => new TextEncoder().encode(s).length

export function shortAddress(addr?: string | null): string {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function formatTimestamp(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatRelative(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000
  if (!ms) return '—'
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatTimestamp(seconds)
}

/**
 * Turns a viem/wagmi error into one sentence a non-developer can act on. The raw
 * messages are several hundred characters of ABI dump; showing those verbatim is how
 * a demo stops looking finished.
 */
export function humanizeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

  if (/User rejected|User denied|rejected the request/i.test(raw)) {
    return 'You rejected the transaction in your wallet.'
  }
  if (/NotEnoughFreeCapital/.test(raw)) return 'The pool cannot cover another policy right now — try later or ask underwriters to add capital.'
  if (/WrongPremium/.test(raw)) return 'Send exactly the premium.'
  if (/SalesClosed/.test(raw)) return 'Sales for this flight have closed (too close to departure).'
  if (/DepartureMismatch/.test(raw)) return 'That flight is already registered with a different departure time.'
  if (/NotReporter/.test(raw)) return 'Only a registered reporter can post delays.'
  if (/AlreadyReported/.test(raw)) return 'You already reported this flight.'
  if (/NotDeparted/.test(raw)) return 'This flight has not departed yet.'
  if (/AlreadyFinal/.test(raw)) return 'This flight already has a final outcome.'
  if (/NotFinal/.test(raw)) return 'No final outcome yet — waiting for reporters.'
  if (/AlreadySettled/.test(raw)) return 'This policy is already settled.'
  if (/InsufficientShares/.test(raw)) return 'You do not have that many shares.'
  if (/ZeroAmount/.test(raw)) return 'Enter an amount above zero.'
  if (/TransferFailed/.test(raw)) return 'Arc refused the transfer to this address.'
  if (/insufficient funds|exceeds the balance/i.test(raw)) {
    return 'Not enough USDC in this wallet to cover the amount plus gas.'
  }
  if (/chain.*mismatch|does not match the target chain/i.test(raw)) {
    return 'Your wallet is on the wrong network. Switch to Arc and try again.'
  }
  if (/HTTP request failed|fetch failed|timed out/i.test(raw)) {
    return 'Could not reach the Arc RPC. Check your connection and retry.'
  }
  return 'The transaction failed. Check your wallet and try again.'
}
