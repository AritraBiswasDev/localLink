/**
 * App.jsx — LocalLink Main Application
 * Minimal, flat, distraction-free interface with dual light/dark themes.
 */
import { useEffect, useRef, useState } from 'react'

import wsClient, { WS_EVENT } from './services/wsClient'
import ConnectionStatus from './components/ConnectionStatus'
import PeerList from './components/PeerList'
import ChatWindow from './components/ChatWindow'
import FileTransferBar from './components/FileTransferBar'

export default function App() {
  const [activePeer, setActivePeer] = useState(null)
  const [unreadCounts, setUnreadCounts] = useState({}) // { [peerId]: count }
  const [myInfo, setMyInfo] = useState({ username: '', ip: '' })
  const [copied, setCopied] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('locallink_theme') || 'dark')

  // Sync theme with DOM and localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('locallink_theme', theme)
  }, [theme])

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  // Ref so the wsClient listener always sees the latest activePeer
  const activePeerRef = useRef(activePeer)
  useEffect(() => { activePeerRef.current = activePeer }, [activePeer])

  // Connect to local backend proxy on mount; disconnect cleanly on unmount
  useEffect(() => {
    wsClient.connect()
    return () => wsClient.disconnect()
  }, [])

  // Listen for local machine info (detected IP and username)
  useEffect(() => {
    const unsub = wsClient.on(WS_EVENT.MY_INFO, (info) => {
      if (info) setMyInfo(info)
    })
    return unsub
  }, [])

  // Keep activePeer updated when their name is announced or changed
  useEffect(() => {
    const handlePeerUpdate = ({ peer }) => {
      if (!peer) return
      setActivePeer((curr) => {
        if (curr && (curr.id === peer.id || curr.ip === peer.ip)) {
          const effectiveName = (peer.name && peer.name !== peer.ip) ? peer.name : (curr.name || peer.name || peer.ip)
          return { ...curr, ...peer, name: effectiveName }
        }
        return curr
      })
    }

    const unsubAnnounce = wsClient.on(WS_EVENT.PEER_ANNOUNCE, handlePeerUpdate)
    const unsubConnected = wsClient.on(WS_EVENT.PEER_CONNECTED, handlePeerUpdate)
    return () => {
      unsubAnnounce()
      unsubConnected()
    }
  }, [])

  // Track unread counts — increment when a message arrives for a non-active peer
  useEffect(() => {
    const unsub = wsClient.on(WS_EVENT.CHAT_MESSAGE, ({ from }) => {
      if (activePeerRef.current?.id !== from) {
        setUnreadCounts((prev) => ({ ...prev, [from]: (prev[from] || 0) + 1 }))
      }
    })
    return unsub
  }, [])

  function handleCopyIp() {
    if (!myInfo.ip) return
    navigator.clipboard.writeText(myInfo.ip)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleSelectPeer(peer) {
    setActivePeer(peer)
    setUnreadCounts((prev) => ({ ...prev, [peer.id]: 0 }))
  }

  return (
    <div
      id="app-root"
      style={{
        flex: 1,
        backgroundColor: 'var(--color-bg-base)',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header
        id="topbar"
        className="flex-between"
        style={{
          padding: '0 20px',
          height: 52,
          flexShrink: 0,
          background: 'var(--color-bg-surface)',
          borderBottom: '1px solid var(--color-border)',
          zIndex: 10,
        }}
      >
        <div className="flex-center gap-2">
          {/* Minimal Logo */}
          <div
            id="app-logo"
            style={{
              width: 24,
              height: 24,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <span style={{ fontSize: '0.9375rem', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-text-primary)' }}>
            LocalLink
          </span>
          <span className="badge badge-neutral" style={{ fontSize: '0.65rem' }}>LAN</span>
        </div>

        <div className="flex-center gap-2">
          {myInfo.ip && (
            <button
              id="my-ip-pill"
              onClick={handleCopyIp}
              className="btn btn-secondary btn-sm"
              title="Click to copy your campus IP to share with friends"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                gap: 6,
                padding: '4px 10px',
              }}
            >
              <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-sans)', fontWeight: 500 }}>
                {myInfo.username}:
              </span>
              <span>{myInfo.ip}</span>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: copied ? 'var(--color-online)' : 'var(--color-text-muted)',
                  marginLeft: 2,
                }}
              >
                {copied ? '✓' : 'Copy'}
              </span>
            </button>
          )}

          {/* Theme Switcher Toggle */}
          <button
            id="theme-toggle"
            onClick={toggleTheme}
            className="btn btn-ghost btn-icon btn-sm"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
            style={{ width: 32, height: 32 }}
          >
            {theme === 'dark' ? (
              // Sun icon for switching to light
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              // Moon icon for switching to dark
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          <span className="badge badge-accent" style={{ fontSize: '0.7rem' }}>E2EE</span>
          <ConnectionStatus />
        </div>
      </header>

      {/* ── Main area ──────────────────────────────────────────── */}
      <main id="main-content" style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        <PeerList
          activeChat={activePeer?.id ?? null}
          onSelectPeer={handleSelectPeer}
          unreadCounts={unreadCounts}
        />

        <ChatWindow activePeer={activePeer} />

        <FileTransferBar />
      </main>
    </div>
  )
}
