/**
 * PeerList.jsx
 * Left sidebar listing discovered LAN peers with Smart Search & Direct IP Connect.
 * Minimal, flat aesthetic with Ctrl+K keyboard shortcut.
 */
import { useEffect, useRef, useState } from 'react'
import wsClient, { WS_EVENT } from '../services/wsClient'

function PeerAvatar({ name }) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  const hue = Math.abs(hash) % 360

  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: 'var(--radius-sm)',
        background: `hsl(${hue} 45% 45%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '0.7rem',
        fontWeight: 600,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  )
}

function PeerRow({ peer, isActive, onClick, unread }) {
  const isOnline = peer.isOnline !== false

  return (
    <button
      id={`peer-${peer.id}`}
      onClick={() => onClick(peer)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 9px',
        borderRadius: 'var(--radius-md)',
        width: '100%',
        textAlign: 'left',
        background: isActive ? 'var(--color-bg-hover)' : 'transparent',
        border: isActive
          ? '1px solid var(--color-border-strong)'
          : '1px solid transparent',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        opacity: isOnline ? 1 : 0.72,
      }}
    >
      <div style={{ position: 'relative' }}>
        <PeerAvatar name={peer.name} />
        <span
          className={`status-dot ${isOnline ? 'online' : 'idle'}`}
          title={isOnline ? 'Online' : 'Offline'}
          style={{ position: 'absolute', bottom: -1, right: -1, width: 6, height: 6, border: '1.5px solid var(--color-bg-surface)' }}
        />
      </div>
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {peer.name}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{peer.ip}</span>
          {!isOnline && (
            <span style={{ fontSize: '0.62rem', color: 'var(--color-text-muted)', opacity: 0.8 }}>• Offline</span>
          )}
        </div>
      </div>
      {unread > 0 && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: '0.65rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            flexShrink: 0,
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

export default function PeerList({ activeChat, onSelectPeer, unreadCounts = {} }) {
  const [peers, setPeers] = useState(() => {
    try {
      const saved = localStorage.getItem('locallink_known_peers')
      if (saved) {
        const parsed = JSON.parse(saved)
        return parsed.map((p) => ({ ...p, isOnline: false }))
      }
      return []
    } catch {
      return []
    }
  })
  const [query, setQuery] = useState('')
  const [connectingIp, setConnectingIp] = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)
  const searchInputRef = useRef(null)

  // Persist known peers list across reloads
  useEffect(() => {
    if (peers.length > 0) {
      localStorage.setItem('locallink_known_peers', JSON.stringify(peers))
    }
  }, [peers])

  // Global keyboard shortcut: Ctrl+K or / to focus search
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA')) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const handlePeerUpdate = ({ peer }) => {
      if (!peer) return
      setPeers((prev) => {
        const isOnline = peer.isOnline !== false
        const exists = prev.find((p) => p.id === peer.id || p.ip === peer.ip)
        if (exists) {
          return prev.map((p) => {
            if (p.id === peer.id || p.ip === peer.ip) {
              const bestName = (peer.name && peer.name !== peer.ip) ? peer.name : (p.name || peer.name || peer.ip)
              return { ...p, ...peer, name: bestName, isOnline }
            }
            return p
          })
        }
        return [...prev, { ...peer, isOnline }]
      })

      // If this was the IP we were connecting to, auto-select, clear search and connecting state
      setConnectingIp((curr) => {
        if (curr && (curr === peer.ip || curr === peer.id)) {
          onSelectPeer(peer)
          setQuery('')
          return null
        }
        return curr
      })
    }

    const unsubAnnounce = wsClient.on(WS_EVENT.PEER_ANNOUNCE, handlePeerUpdate)
    const unsubConnected = wsClient.on(WS_EVENT.PEER_CONNECTED, handlePeerUpdate)

    const unsubOffline = wsClient.on(WS_EVENT.PEER_OFFLINE, ({ peerId }) => {
      // Mark peer as offline instead of removing them from the list
      setPeers((prev) =>
        prev.map((p) => (p.id === peerId || p.ip === peerId ? { ...p, isOnline: false } : p))
      )
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
      unsubConnected()
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

    // Reset connecting spinner after 5s if no response
    setTimeout(() => {
      setConnectingIp((curr) => (curr === ip ? null : curr))
    }, 5000)
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
      style={{
        width: 250,
        flexShrink: 0,
        background: 'var(--color-bg-surface)',
        borderRight: '1px solid var(--color-border)',
        padding: '12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div className="flex-between" style={{ padding: '0 4px' }}>
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--color-text-muted)',
          }}
        >
          Peers on LAN
        </span>
        {peers.length > 0 && (
          <span className="badge badge-online" style={{ fontSize: '0.65rem', padding: '1px 5px' }}>
            {peers.filter((p) => p.isOnline !== false).length} online
          </span>
        )}
      </div>

      {/* Smart Search & Connect Bar with Shortcut Hint */}
      <div style={{ position: 'relative' }}>
        <input
          ref={searchInputRef}
          id="peer-search-input"
          type="text"
          className="input"
          placeholder="Search or IP… (Ctrl+K)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            padding: '6px 28px 6px 9px',
            fontSize: '0.8rem',
            background: 'var(--color-bg-base)',
          }}
        />
        {query ? (
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
        ) : (
          <span
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '0.65rem',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              pointerEvents: 'none',
            }}
          >
            /
          </span>
        )}
      </div>

      {/* Direct Connect Action Card */}
      {showDirectConnect && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
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

      {/* Error notification */}
      {errorMsg && (
        <div
          style={{
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-danger-dim)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--color-danger)',
            fontSize: '0.75rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: '0.85rem' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Peer list items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
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
          <div className="flex-col gap-2" style={{ marginTop: 8 }}>
            {[65, 45, 75].map((w, i) => (
              <div key={i} className="flex-center gap-2" style={{ padding: '6px 8px' }}>
                <div className="skeleton" style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', flexShrink: 0 }} />
                <div className="flex-col gap-1" style={{ flex: 1 }}>
                  <div className="skeleton" style={{ height: 8, width: `${w}%` }} />
                  <div className="skeleton" style={{ height: 6, width: '40%' }} />
                </div>
              </div>
            ))}
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 6 }}>
              Listening for LAN peers…
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
