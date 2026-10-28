/**
 * ConnectionStatus.jsx
 * Topbar pill showing live WebSocket connection state.
 * Reads state from wsClient and updates via event listener.
 */
import { useEffect, useState } from 'react'
import wsClient, { WS_STATE } from '../services/wsClient'

const STATE_CONFIG = {
  [WS_STATE.OPEN]:         { label: 'Connected',    dotClass: 'online',  badgeClass: 'badge-online',   pulse: true  },
  [WS_STATE.CONNECTING]:   { label: 'Connecting…',  dotClass: 'warning', badgeClass: 'badge-warning',  pulse: false },
  [WS_STATE.RECONNECTING]: { label: 'Reconnecting…',dotClass: 'warning', badgeClass: 'badge-warning',  pulse: true  },
  [WS_STATE.CLOSED]:       { label: 'Offline',       dotClass: 'danger',  badgeClass: 'badge-danger',   pulse: false },
}

export default function ConnectionStatus() {
  const [state, setState] = useState(wsClient.state)

  useEffect(() => {
    const unsub = wsClient.on('connection', ({ state: s }) => {
      if (s) setState(s)
    })
    return unsub
  }, [])

  const { label, dotClass, badgeClass } = STATE_CONFIG[state] ?? STATE_CONFIG[WS_STATE.CLOSED]

  return (
    <div
      id="connection-status"
      className={`badge ${badgeClass}`}
      style={{ gap: 6 }}
      title={`WebSocket: ${state}`}
    >
      <span
        className={`status-dot ${dotClass}`}
        style={{ display: 'inline-block' }}
      />
      {label}
    </div>
  )
}
