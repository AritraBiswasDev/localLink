/**
 * PeerList.jsx
 * Left sidebar listing discovered LAN peers with Smart Search & Direct IP Connect.
 * Peers arrive via PEER_ANNOUNCE / PEER_OFFLINE WebSocket events.
 */
import { useEffect, useState } from 'react'
import wsClient, { WS_EVENT } from '../services/wsClient'

function PeerAvatar({ name }) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  // Deterministic hue from name
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  const hue = Math.abs(hash) % 360

  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-full)',
        background: `hsl(${hue} 60% 55%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '0.7rem',
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
        letterSpacing: '0.05em',
      }}
    >
      {initials}
    </div>
  )
}

function PeerRow({ peer, isActive, onClick, unread }) {
  return (
    <button
      id={`peer-${peer.id}`}
      onClick={() => onClick(peer)}
      className="btn-ghost animate-slide-in-left"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 'var(--radius-md)',
        width: '100%',
        textAlign: 'left',
        background: isActive ? 'var(--color-accent-dim)' : 'transparent',
        border: isActive
          ? '1px solid rgba(99,102,241,0.25)'
          : '1px solid transparent',
        cursor: 'pointer',
        transition: 'background var(--transition-fast), border-color var(--transition-fast)',
      }}
    >
      <div style={{ position: 'relative' }}>
        <PeerAvatar name={peer.name} />
        <span
          className="status-dot online animate-pulse-ring"
          style={{ position: 'absolute', bottom: 0, right: 0, width: 8, height: 8, border: '2px solid var(--color-bg-surface)' }}
        />
      </div>
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {peer.name}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
          {peer.ip}
        </div>
      </div>
      {/* Unread badge */}
      {unread > 0 && (
        <span
          style={{
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: '0.7rem',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 5px',
            flexShrink: 0,
            boxShadow: 'var(--shadow-glow-sm)',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

export default function PeerList({ activeChat, onSelectPeer, unreadCounts = {} }) {
  const [peers, setPeers] = useState([])
  const [query, setQuery] = useState('')
  const [connectingIp, setConnectingIp] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    const unsubAnnounce = wsClient.on(WS_EVENT.PEER_ANNOUNCE, ({ peer }) => {
      if (!peer) return
      setPeers((prev) => {
        const exists = prev.find((p) => p.id === peer.id)
        return exists ? prev.map((p) => (p.id === peer.id ? peer : p)) : [...prev, peer]
      })

      // If this was the IP we were connecting to, auto-select and clear connecting state
      setConnectingIp((curr) => {
        if (curr && (curr === peer.ip || curr === peer.id)) {
          onSelectPeer(peer)
          return null
        }
        return curr
      })
    })

    const unsubOffline = wsClient.on(WS_EVENT.PEER_OFFLINE, ({ peerId }) => {
      setPeers((prev) => prev.filter((p) => p.id !== peerId))
    })

    const unsubConnectFailed = wsClient.on(WS_EVENT.PEER_CONNECT_FAILED, ({ ip, error }) => {
      setConnectingIp((curr) => {
        if (curr === ip) {
          setErrorMsg(error || `Could not connect to ${ip}`)
          setTimeout(() => setErrorMsg(null), 4000)
          return null
        }
        return curr
      })
    })

    return () => {
      unsubAnnounce()
      unsubOffline()
      unsubConnectFailed()
    }
  }, [onSelectPeer])

  function handleConnect(targetIp) {
    const ip = (targetIp || query).trim()
    if (!ip) return
    setConnectingIp(ip)
    setErrorMsg(null)
    wsClient.send('CONNECT_PEER', { ip })

    // Reset connecting spinner after 10s if no response
    setTimeout(() => {
      setConnectingIp((curr) => (curr === ip ? null : curr))
    }, 10000)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const trimmed = query.trim()
      if (!trimmed) return
      const matched = peers.filter(
        (p) => p.name.toLowerCase().includes(trimmed.toLowerCase()) || p.ip.includes(trimmed)
      )
      if (matched.length === 1) {
        onSelectPeer(matched[0])
      } else {
        handleConnect(trimmed)
      }
    }
  }

  const trimmedQuery = query.trim().toLowerCase()
  const filteredPeers = peers.filter(
    (p) => p.name.toLowerCase().includes(trimmedQuery) || p.ip.toLowerCase().includes(trimmedQuery)
  )

  const showDirectConnect =
    trimmedQuery.length > 0 &&
    !peers.some(
      (p) => p.ip.toLowerCase() === trimmedQuery || p.name.toLowerCase() === trimmedQuery
    )

  return (
    <aside
      id="peer-sidebar"
      className="glass flex-col"
      style={{
        width: 250,
        flexShrink: 0,
        borderRight: '1px solid var(--color-border)',
        padding: '16px 12px',
        gap: 8,
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div className="flex-between" style={{ padding: '0 4px' }}>
        <p
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-text-muted)',
          }}
        >
          Peers on LAN
        </p>
        {peers.length > 0 && (
          <span className="badge badge-online" style={{ fontSize: '0.65rem', padding: '2px 6px' }}>
            {peers.length}
          </span>
        )}
      </div>

      {/* Smart Search & Connect Bar */}
      <div style={{ position: 'relative' }}>
        <input
          id="peer-search-input"
          type="text"
          className="input"
          placeholder="Search name or IP…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '7px 10px',
            fontSize: '0.8rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-base)',
            border: '1px solid var(--color-border)',
          }}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Direct Connect Action Row */}
      {showDirectConnect && (
        <div
          className="animate-slide-in-up"
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(99, 102, 241, 0.12)',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={{ overflow: 'hidden', flex: 1 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--color-accent-light)' }}>
              Direct Connect
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-primary)',
                fontFamily: 'var(--font-mono)',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {query.trim()}
            </div>
          </div>
          <button
            id="direct-connect-btn"
            className="btn btn-primary btn-sm"
            disabled={connectingIp === query.trim()}
            onClick={() => handleConnect(query.trim())}
            style={{ padding: '3px 8px', fontSize: '0.7rem' }}
          >
            {connectingIp === query.trim() ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}

      {/* Error message */}
      {errorMsg && (
        <div
          style={{
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#f87171',
            fontSize: '0.75rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.85rem' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Peer list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        {filteredPeers.length > 0 ? (
          filteredPeers.map((peer) => (
            <PeerRow
              key={peer.id}
              peer={peer}
              isActive={activeChat === peer.id}
              onClick={onSelectPeer}
              unread={unreadCounts[peer.id] || 0}
            />
          ))
        ) : query ? (
          <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 12 }}>
            No peers matching "{query}"
          </p>
        ) : (
          /* Discovery skeleton */
          <div className="flex-col gap-2" style={{ marginTop: 4 }}>
            {[75, 55, 85].map((w, i) => (
              <div
                key={i}
                className="flex-center gap-2"
                style={{ padding: '8px 10px', animationDelay: `${i * 80}ms` }}
              >
                <div
                  className="skeleton"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 'var(--radius-full)',
                    flexShrink: 0,
                  }}
                />
                <div className="flex-col gap-1" style={{ flex: 1 }}>
                  <div
                    className="skeleton"
                    style={{ height: 10, width: `${w}%`, borderRadius: 'var(--radius-sm)' }}
                  />
                  <div
                    className="skeleton"
                    style={{ height: 8, width: '50%', borderRadius: 'var(--radius-sm)' }}
                  />
                </div>
              </div>
            ))}
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
                textAlign: 'center',
                marginTop: 8,
              }}
            >
              Discovering peers…
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
