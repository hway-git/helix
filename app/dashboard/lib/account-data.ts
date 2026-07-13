export type AccountSourceStatus = 'live' | 'partial' | 'offline'
export type AccountAuthStatus = 'configured' | 'missing' | 'invalid' | 'unknown'

export type AccountTableRow = Record<string, string | number>

export type AccountSnapshot = {
  ok: boolean
  mode: 'read_only'
  balances: AccountTableRow[]
  positions: AccountTableRow[]
  orders: AccountTableRow[]
  history: AccountTableRow[]
  source: {
    name: 'Helix Account'
    status: AccountSourceStatus
    fetchedAt: number
    errors: string[]
    auth: {
      status: AccountAuthStatus
      label: string
    }
    permissions: {
      read: boolean
      trade: false
    }
  }
}
