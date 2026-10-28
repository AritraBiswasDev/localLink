/**
 * ChatWindow.jsx
 * Main chat area with minimal aesthetic, E2EE security inspector modal,
 * 50MB file size limit, audio notification chime, and store-and-forward outbox queue.
 */
import { useEffect, useRef, useState } from 'react'
import wsClient, { WS_EVENT } from '../services/wsClient'
import { formatBytes } from '../utils/formatBytes'

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function playNotificationChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(587.33, ctx.currentTime) // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08) // A5
    gain.gain.setValueAtTime(0.06, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.2)
  } catch {}
}

function MessageBubble({ msg, isMine }) {
  const isPending = msg.status === 'pending'

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isMine ? 'flex-end' : 'flex-start',
        padding: '2px 0',
      }}
    >
      <div
        style={{
          maxWidth: '72%',
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: isMine
            ? 'var(--color-accent)'
            : 'var(--color-bg-elevated)',
          border: isMine
            ? '1px solid transparent'
            : '1px solid var(--color-border)',
          opacity: isPending ? 0.85 : 1,
        }}
      >
        <p
          style={{
            fontSize: '0.875rem',
            color: isMine ? '#ffffff' : 'var(--color-text-primary)',
            lineHeight: 1.5,
            margin: 0,
            wordBreak: 'break-word',
          }}
        >
          {msg.text}
        </p>
        <div
          style={{
            fontSize: '0.65rem',
            color: isMine ? 'rgba(255,255,255,0.7)' : 'var(--color-text-muted)',
            marginTop: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 4,
          }}
        >
          <span>{formatTime(msg.ts)}</span>
          {isMine && (
            isPending ? (
              <span
                title="Queued offline — will deliver automatically when peer reconnects"
                style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center' }}
              >
                🕒
              </span>
            ) : (
              <span title="Delivered via encrypted TCP">✓</span>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function TypingBubble() {
  return (
    <div style={{ display: 'flex', padding: '2px 0', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--color-text-muted)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--color-text-muted)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--color-text-muted)' }} />
      </div>
      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>typing…</span>
    </div>
  )
}

function EmptyChat({ peerName }) {
  return (
    <div
      id="empty-chat"
      className="flex-center flex-col gap-2"
      style={{ flex: 1, padding: 24, textAlign: 'center' }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted)',
          marginBottom: 4,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
        {peerName ? `Conversation with ${peerName}` : 'No peer selected'}
      </h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', maxWidth: 260 }}>
        {peerName
          ? 'Messages and transfers are end-to-end encrypted with X25519 & AES-256-GCM.'
          : 'Select a peer from the sidebar or enter a campus IP to start chatting.'}
      </p>
    </div>
  )
}

export default function ChatWindow({ activePeer }) {
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem('locallink_chats')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })
  const [inputValue, setInputValue] = useState('')
  const [typingPeers, setTypingPeers] = useState(new Set())
  const [onlinePeers, setOnlinePeers] = useState(new Set())
  const [showSecurityModal, setShowSecurityModal] = useState(false)
  
  // Persistent outbox for queued messages to offline peers
  const [outbox, setOutbox] = useState(() => {
    try {
      const saved = localStorage.getItem('locallink_outbox')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  const bottomRef = useRef(null)
  const fileInputRef = useRef(null)
  const typingTimeoutRef = useRef(null)
  const isTypingRef = useRef(false)

  const peerId = activePeer?.id
  const peerMessages = (peerId && messages[peerId]) || []
  const isPeerTyping = peerId && typingPeers.has(peerId)
  const isPeerOnline = peerId ? onlinePeers.has(peerId) : false

  // 2. Save chats to local storage
  useEffect(() => {
    if (Object.keys(messages).length > 0) {
      localStorage.setItem('locallink_chats', JSON.stringify(messages))
    }
  }, [messages])

  // 3. Save outbox queue to local storage
  useEffect(() => {
    localStorage.setItem('locallink_outbox', JSON.stringify(outbox))
  }, [outbox])

  // Scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [peerMessages.length, isPeerTyping])

  // Track online peers & auto-flush outbox when peer comes online
  useEffect(() => {
    const unsubAnnounce = wsClient.on(WS_EVENT.PEER_ANNOUNCE, ({ peer }) => {
      if (!peer) return
      setOnlinePeers((prev) => new Set(prev).add(peer.id))

      // Check if there are queued outbox messages waiting to be sent to this peer!
      setOutbox((prevOutbox) => {
        const pending = prevOutbox[peer.id] || []
        if (pending.length > 0) {
          console.log(`[Outbox] Auto-flushing ${pending.length} message(s) to ${peer.id}`)
          pending.forEach((msg) => {
            wsClient.send('CHAT_MESSAGE', { to: peer.id, text: msg.text })
          })

          // Mark status as 'sent' in message history
          setMessages((prevMsgs) => {
            const peerMsgs = prevMsgs[peer.id] || []
            const pendingIds = new Set(pending.map((m) => m.id))
            return {
              ...prevMsgs,
              [peer.id]: peerMsgs.map((m) => (pendingIds.has(m.id) ? { ...m, status: 'sent' } : m)),
            }
          })

          const next = { ...prevOutbox }
          delete next[peer.id]
          return next
        }
        return prevOutbox
      })
    })

    const unsubOffline = wsClient.on(WS_EVENT.PEER_OFFLINE, ({ peerId: offlineId }) => {
      setOnlinePeers((prev) => {
        const next = new Set(prev)
        next.delete(offlineId)
        return next
      })
    })

    return () => {
      unsubAnnounce()
      unsubOffline()
    }
  }, [])

  // Listen for incoming chat messages and typing events
  useEffect(() => {
    const unsubChat = wsClient.on(WS_EVENT.CHAT_MESSAGE, (payload) => {
      const { from, text, ts } = payload
      playNotificationChime()
      setMessages((prev) => ({
        ...prev,
        [from]: [...(prev[from] || []), { from, text, ts: ts ?? Date.now(), id: `${from}-${ts}`, status: 'sent' }],
      }))
    })

    const unsubTypingStart = wsClient.on(WS_EVENT.TYPING_START, ({ from }) => {
      setTypingPeers((prev) => {
        const next = new Set(prev)
        next.add(from)
        return next
      })
    })

    const unsubTypingStop = wsClient.on(WS_EVENT.TYPING_STOP, ({ from }) => {
      setTypingPeers((prev) => {
        const next = new Set(prev)
        next.delete(from)
        return next
      })
    })

    const unsubFileOffer = wsClient.on(WS_EVENT.FILE_OFFER, ({ from, name, size, transferId }) => {
      setMessages((prev) => ({
        ...prev,
        [from]: [
          ...(prev[from] || []),
          {
            from,
            text: `📎 ${name}  ·  ${formatBytes(size)}`,
            ts: Date.now(),
            id: `file-offer-${transferId}`,
            status: 'sent',
          },
        ],
      }))
    })

    return () => {
      unsubChat()
      unsubTypingStart()
      unsubTypingStop()
      unsubFileOffer()
    }
  }, [])

  const handleInputChange = (e) => {
    setInputValue(e.target.value)
    if (!peerId) return

    if (!isTypingRef.current) {
      isTypingRef.current = true
      wsClient.send('TYPING_START', { to: peerId })
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)

    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false
      wsClient.send('TYPING_STOP', { to: peerId })
    }, 2000)
  }

  function handleSend() {
    const text = inputValue.trim()
    if (!text || !peerId) return

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
      isTypingRef.current = false
      wsClient.send('TYPING_STOP', { to: peerId })
    }

    const currentOnline = onlinePeers.has(peerId)
    const status = currentOnline ? 'sent' : 'pending'

    const msg = {
      from: 'me',
      to: peerId,
      text,
      ts: Date.now(),
      id: `me-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status,
    }

    // Optimistically add to messages
    setMessages((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), msg],
    }))

    if (!currentOnline) {
      // Buffer in outbox
      setOutbox((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] || []), msg],
      }))
    }

    // Always deliver to backend proxy (which sends or buffers)
    wsClient.send('CHAT_MESSAGE', { to: peerId, text })
    setInputValue('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // --- FILE TRANSFER WITH 50MB LIMIT ---
  function triggerFileSelect() {
    fileInputRef.current?.click()
  }

  async function handleFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file || !peerId) return
    e.target.value = '' // reset input

    // 50 MB Campus Safety Limit
    const MAX_FILE_SIZE = 50 * 1024 * 1024
    if (file.size > MAX_FILE_SIZE) {
      const warningText = `⚠️ File blocked: "${file.name}" is ${formatBytes(file.size)}. Campus limit is 50 MB to conserve memory.`
      setMessages((prev) => ({
        ...prev,
        [peerId]: [
          ...(prev[peerId] || []),
          { from: 'me', to: peerId, text: warningText, ts: Date.now(), id: `warn-${Date.now()}`, status: 'sent' },
        ],
      }))
      return
    }

    const transferId = `tx-${Date.now()}`
    
    // 1. Send Offer
    wsClient.send('FILE_OFFER', {
      to: peerId,
      transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type
    })

    const msgId = `me-${Date.now()}`
    setMessages((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), { from: 'me', to: peerId, text: `📎 Offering: ${file.name} (Waiting for accept…)`, ts: Date.now(), id: msgId, status: 'sent' }],
    }))

    const updateProgressMsg = (text) => {
      setMessages((prev) => {
        const peerMsgs = prev[peerId] || []
        return {
          ...prev,
          [peerId]: peerMsgs.map(m => m.id === msgId ? { ...m, text } : m)
        }
      })
    }

    // 2. Await Acceptance
    const isAccepted = await new Promise((resolve) => {
      let settled = false
      let timeoutHandle
      let unsubAccept, unsubReject, unsubOffline

      const settle = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutHandle)
        unsubAccept()
        unsubReject()
        unsubOffline()
        resolve(result)
      }

      const handleAccept = (payload) => {
        if (payload.transferId === transferId) settle(true)
      }
      const handleReject = (payload) => {
        if (payload.transferId === transferId) settle(false)
      }
      const handleOffline = ({ peerId: offlinePeer }) => {
        if (offlinePeer === peerId) settle(false)
      }

      unsubAccept  = wsClient.on(WS_EVENT.FILE_ACCEPT,  handleAccept)
      unsubReject  = wsClient.on(WS_EVENT.FILE_REJECT,  handleReject)
      unsubOffline = wsClient.on(WS_EVENT.PEER_OFFLINE, handleOffline)

      timeoutHandle = setTimeout(() => settle(false), 60_000)
    })

    if (!isAccepted) {
      updateProgressMsg(`❌ Transfer rejected or timed out: ${file.name}`)
      return
    }

    updateProgressMsg(`📎 Sending: ${file.name} (0%)`)

    // 3. Stream Chunks
    const CHUNK_SIZE = 256 * 1024 // 256KB
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const blob = file.slice(start, end)
      
      const arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsArrayBuffer(blob)
      })
      
      let binary = ''
      const bytes = new Uint8Array(arrayBuffer)
      const len = bytes.byteLength
      for (let j = 0; j < len; j++) {
        binary += String.fromCharCode(bytes[j])
      }
      const base64Chunk = btoa(binary)

      await wsClient.waitDrained(1 * 1024 * 1024)

      wsClient.send('FILE_CHUNK', {
        to: peerId,
        transferId,
        chunkIndex: i,
        totalChunks,
        data: base64Chunk
      })

      const percent = Math.round(((i + 1) / totalChunks) * 100)
      updateProgressMsg(`📎 Sending: ${file.name} (${percent}%)`)
    }

    await wsClient.waitDrained(0)
    wsClient.send('FILE_COMPLETE', { to: peerId, transferId })
    updateProgressMsg(`✅ Sent: ${file.name}`)
  }

  return (
    <section
      id="chat-area"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-bg-base)',
      }}
    >
      {/* Chat header */}
      {activePeer && (
        <div
          id="chat-header"
          className="flex-between"
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            flexShrink: 0,
          }}
        >
          <div className="flex-center gap-2">
            <span
              className={`status-dot ${isPeerOnline ? 'online' : 'idle'}`}
              style={{ display: 'inline-block' }}
            />
            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text-primary)' }}>
              {activePeer.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
              }}
            >
              {activePeer.ip}
            </span>
            {!isPeerOnline && (
              <span className="badge badge-neutral" style={{ fontSize: '0.65rem' }}>Offline</span>
            )}
          </div>

          <button
            onClick={() => setShowSecurityModal(true)}
            className="btn btn-ghost btn-sm"
            title="Inspect End-to-End Encryption Details"
            style={{ gap: 5, padding: '3px 8px', fontSize: '0.7rem' }}
          >
            <span className="badge badge-accent" style={{ fontSize: '0.65rem' }}>E2EE</span>
            <span style={{ color: 'var(--color-text-muted)' }}>Verified 🔒</span>
          </button>
        </div>
      )}

      {/* Message list */}
      <div
        id="message-list"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {peerMessages.length === 0 ? (
          <EmptyChat peerName={activePeer?.name} />
        ) : (
          peerMessages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} isMine={msg.from === 'me'} />
          ))
        )}
        {isPeerTyping && <TypingBubble />}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      {activePeer && (
        <div
          id="message-input-bar"
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            flexShrink: 0,
          }}
        >
          {/* Hidden File Input */}
          <input type="file" ref={fileInputRef} onChange={handleFileSelect} style={{ display: 'none' }} />
          
          {/* Attachment Button */}
          <button
            className="btn btn-ghost btn-icon"
            onClick={triggerFileSelect}
            title="Send file (max 50 MB)"
            style={{ flexShrink: 0, width: 38, height: 38, color: 'var(--color-text-muted)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <textarea
            id="message-input"
            className="input"
            placeholder={
              isPeerOnline
                ? `Message ${activePeer.name}…`
                : `Message ${activePeer.name} (offline — queued until online)…`
            }
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{
              resize: 'none',
              minHeight: 38,
              maxHeight: 120,
              lineHeight: 1.4,
              overflowY: 'auto',
            }}
          />
          <button
            id="send-button"
            className="btn btn-primary btn-icon"
            onClick={handleSend}
            disabled={!inputValue.trim()}
            title={isPeerOnline ? 'Send message (Enter)' : 'Queue offline message (Enter)'}
            style={{ flexShrink: 0, width: 38, height: 38 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      )}

      {/* E2EE Security Inspector Modal */}
      {showSecurityModal && activePeer && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowSecurityModal(false)}
        >
          <div
            className="animate-fade-in"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 380,
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div className="flex-between">
              <div className="flex-center gap-2">
                <span style={{ fontSize: '1.1rem' }}>🔒</span>
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    End-to-End Encryption
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                    Cryptographic Session Details
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowSecurityModal(false)}
                className="btn btn-ghost btn-sm"
                style={{ padding: '2px 6px' }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                fontSize: '0.75rem',
              }}
            >
              <div className="flex-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Peer Identity</span>
                <span style={{ fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{activePeer.name} ({activePeer.ip})</span>
              </div>
              <div className="flex-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Transport</span>
                <span style={{ fontWeight: 500, fontFamily: 'var(--font-mono)' }}>Raw TCP / Port 9000</span>
              </div>
              <div className="flex-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Key Exchange</span>
                <span style={{ fontWeight: 500, color: 'var(--color-accent-light)' }}>X25519 ECDH (Ephemeral)</span>
              </div>
              <div className="flex-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Payload Cipher</span>
                <span style={{ fontWeight: 500, color: 'var(--color-online)' }}>AES-256-GCM (128-bit Auth Tag)</span>
              </div>
              <div className="flex-between">
                <span style={{ color: 'var(--color-text-muted)' }}>Nonce Rotation</span>
                <span style={{ fontWeight: 500 }}>96-bit Unique Per Packet</span>
              </div>
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', lineHeight: 1.45 }}>
              All chat messages and file chunks are encrypted locally on your machine before passing over the campus LAN. No campus router can inspect or tamper with plaintext data.
            </p>

            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowSecurityModal(false)}
              style={{ alignSelf: 'flex-end' }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
