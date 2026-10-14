/*
  Dev-only EIP-1193 wallet for end-to-end testing against a local anvil node.

  Loaded only when `import.meta.env.DEV` and `VITE_DEV_WALLET=true` are both set, so it
  never reaches a production build. It holds no keys: anvil's default accounts are
  unlocked, so `eth_sendTransaction` is simply forwarded and anvil signs.

  Switch the acting account from the console, then reload:
    localStorage.devAccount = '0x…'
*/

const rpc = import.meta.env.VITE_RPC_URL || 'http://127.0.0.1:8545'

async function call(method: string, params: unknown[] = []) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  }).then((r) => r.json())
  if (res.error) {
    const err = new Error(res.error.message) as Error & {code?: number; data?: unknown}
    err.code = res.error.code
    err.data = res.error.data
    throw err
  }
  return res.result
}

const accounts: string[] = await call('eth_accounts')
const stored = localStorage.getItem('devAccount')
const account = stored && accounts.includes(stored.toLowerCase()) ? stored.toLowerCase() : accounts[0]
const chainId: string = await call('eth_chainId')

const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}

;(window as unknown as {ethereum: unknown}).ethereum = {
  isMetaMask: true,
  on(event: string, fn: (...a: unknown[]) => void) {
    ;(listeners[event] ||= []).push(fn)
  },
  removeListener(event: string, fn: (...a: unknown[]) => void) {
    listeners[event] = (listeners[event] || []).filter((f) => f !== fn)
  },
  async request({method, params = []}: {method: string; params?: unknown[]}) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account]
      case 'eth_chainId':
        return chainId
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return [{parentCapability: 'eth_accounts'}]
      case 'eth_sendTransaction':
        return call(method, [{...(params[0] as object), from: account}])
      default:
        return call(method, params)
    }
  },
}

console.info(`[devWallet] acting as ${account} on chain ${parseInt(chainId, 16)}`)
