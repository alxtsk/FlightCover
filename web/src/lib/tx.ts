import {useState} from 'react'
import {usePublicClient, useWriteContract} from 'wagmi'
import type {Abi, Address} from 'viem'
import {humanizeError} from './format'

/** Loosely typed on purpose: one helper serves every function in the ABI, and the
 *  contract itself is the final validator of names and arguments. */
export type TxRequest = {
  abi: Abi
  address: Address
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

export type TxCallbacks = {
  onPending: (hash: string, label: string) => void
  onSuccess: (hash: string, label: string) => void
  onError: (message: string) => void
}

/**
 * One helper for every write in the app: sign, announce the hash, wait for inclusion
 * (Arc finalises on inclusion, so the receipt is the settlement), then report.
 * Returns `busy` so each button can disable itself while its own transaction is in flight.
 */
export function useTx(cb: TxCallbacks) {
  const {writeContractAsync} = useWriteContract()
  const client = usePublicClient()
  const [busy, setBusy] = useState<string | null>(null)

  async function run(
    key: string,
    labels: {pending: string; success: string},
    request: TxRequest,
    after?: () => void,
  ) {
    setBusy(key)
    try {
      const hash = await writeContractAsync(request as never)
      cb.onPending(hash, labels.pending)
      const receipt = await client!.waitForTransactionReceipt({hash})
      if (receipt.status !== 'success') throw new Error('reverted')
      cb.onSuccess(hash, labels.success)
      after?.()
    } catch (err) {
      cb.onError(humanizeError(err))
    } finally {
      setBusy(null)
    }
  }

  return {run, busy}
}
