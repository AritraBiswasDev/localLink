/**
 * FileTransferBar.jsx
 * Fixes applied in this version:
 *  - Download is now triggered DIRECTLY in the event handler, NOT inside setTransfers.
 *    React 18 Strict Mode calls state updater functions twice to detect side effects,
 *    which was causing two downloads: one real file and one 0-byte ghost.
 *  - transfersRef mirrors the transfers state so we can read it synchronously
 *    inside the event handler without a stale closure.
 *  - handleAccept/Reject send `to: transfer.from` for correct proxy routing.
 *  - Chunks are assembled into a Blob and downloaded on FILE_COMPLETE.
 */
import { useEffect, useRef, useState } from 'react'
import wsClient, { WS_EVENT } from '../services/wsClient'
import { formatBytes } from '../utils/formatBytes'


const STATUS = Object.freeze({
  PENDING:  'PENDING',
  ACTIVE:   'ACTIVE',
  COMPLETE: 'COMPLETE',
  REJECTED: 'REJECTED',
})

export default function FileTransferBar() {
  const [transfers, setTransfers] = useState([])

  // Mirror of `transfers` state accessible synchronously in event handlers
  // to avoid stale closures and to prevent download inside state updaters.
  const transfersRef = useRef([])
  useEffect(() => { transfersRef.current = transfers }, [transfers])

  // Stores raw chunk Uint8Arrays outside React state (no re-render cost per chunk)
  // Structure: { [transferId]: { [chunkIndex]: Uint8Array } }
  const chunkDataRef = useRef({})

  // Track completed transfers to strictly avoid double download / 0-byte ghost file
  const completedTransfersRef = useRef(new Set())

  useEffect(() => {
    const unsubOffer = wsClient.on(WS_EVENT.FILE_OFFER, ({ from, name, size, mimeType, transferId }) => {
      // Deduplicate offers for the same transferId
      if (transfersRef.current.some((t) => t.transferId === transferId)) {
        return
      }

      chunkDataRef.current[transferId] = {}
      setTransfers((prev) => [
        ...prev.filter((t) => t.transferId !== transferId),
        { transferId, from, name, size, fileType: mimeType || 'application/octet-stream', status: STATUS.PENDING, progress: 0, totalChunks: 0 },
      ])
    })

    const unsubChunk = wsClient.on(WS_EVENT.FILE_CHUNK, ({ transferId, chunkIndex, totalChunks, data }) => {
      if (chunkDataRef.current[transferId] !== undefined) {
        try {
          const binary = atob(data)
          const bytes = new Uint8Array(binary.length)
          for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
          chunkDataRef.current[transferId][chunkIndex] = bytes
        } catch (err) {
          console.error(`[FileTransferBar] Failed to decode chunk ${chunkIndex}:`, err)
        }
      }
      setTransfers((prev) =>
        prev.map((t) =>
          t.transferId === transferId
            ? { ...t, status: STATUS.ACTIVE, totalChunks, progress: totalChunks > 0 ? Math.round(((chunkIndex + 1) / totalChunks) * 100) : 0 }
            : t
        )
      )
    })

    const unsubComplete = wsClient.on(WS_EVENT.FILE_COMPLETE, ({ transferId }) => {
      // Prevent duplicate completion triggers (e.g. from multiple open tabs or repeat packets)
      if (completedTransfersRef.current.has(transferId)) {
        return
      }

      const transfer = transfersRef.current.find((t) => t.transferId === transferId)

      if (transfer) {
        const chunks = chunkDataRef.current[transferId] || {}
        const total = transfer.totalChunks

        try {
          const orderedChunks = []
          for (let i = 0; i < total; i++) {
            if (chunks[i]) orderedChunks.push(chunks[i])
            else console.error(`[FileTransferBar] Missing chunk ${i} for "${transfer.name}"`)
          }

          // Safety guard: only trigger download if chunks actually exist!
          if (orderedChunks.length > 0) {
            completedTransfersRef.current.add(transferId)
            const blob = new Blob(orderedChunks, { type: transfer.fileType })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = transfer.name
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          } else {
            console.warn(`[FileTransferBar] No chunks available to assemble for "${transfer.name}" — skipping 0B download.`)
          }
        } catch (err) {
          console.error('[FileTransferBar] Failed to assemble file:', err)
        }

        delete chunkDataRef.current[transferId]
      }

      // Update state separately — this updater does NO side effects
      setTransfers((prev) =>
        prev.map((t) => (t.transferId === transferId ? { ...t, status: STATUS.COMPLETE, progress: 100 } : t))
      )

      setTimeout(() => {
        setTransfers((prev) => prev.filter((t) => t.transferId !== transferId))
      }, 4000)
    })

    return () => {
      unsubOffer()
      unsubChunk()
      unsubComplete()
    }
  }, [])

  function handleAccept(transfer) {
    wsClient.send('FILE_ACCEPT', { transferId: transfer.transferId, to: transfer.from })
    setTransfers((prev) =>
      prev.map((t) => (t.transferId === transfer.transferId ? { ...t, status: STATUS.ACTIVE } : t))
    )
  }

  function handleReject(transfer) {
    wsClient.send('FILE_REJECT', { transferId: transfer.transferId, to: transfer.from })
    setTransfers((prev) => prev.filter((t) => t.transferId !== transfer.transferId))
    delete chunkDataRef.current[transfer.transferId]
  }

  if (transfers.length === 0) return null

  return (
    <div
      id="file-transfer-bar"
      className="animate-slide-in-up"
      style={{ position: 'absolute', bottom: 80, right: 20, width: 340, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 100 }}
    >
      {transfers.map((t) => (
        <div
          key={t.transferId}
          id={`transfer-${t.transferId}`}
          style={{
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div className="flex-between">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--color-accent-dim)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-light)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
                  {t.name}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                  {formatBytes(t.size)} &middot; from {t.from}
                </div>
              </div>
            </div>
            {t.status === STATUS.COMPLETE && <span className="badge badge-online" style={{ flexShrink: 0 }}>Done ✓</span>}
            {t.status === STATUS.ACTIVE && <span className="badge badge-accent" style={{ flexShrink: 0 }}>{t.progress}%</span>}
          </div>

          {(t.status === STATUS.ACTIVE || t.status === STATUS.COMPLETE) && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${t.progress}%` }} />
            </div>
          )}

          {t.status === STATUS.PENDING && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button id={`accept-${t.transferId}`} className="btn btn-success btn-sm" style={{ flex: 1 }} onClick={() => handleAccept(t)}>Accept</button>
              <button id={`reject-${t.transferId}`} className="btn btn-danger btn-sm" style={{ flex: 1 }} onClick={() => handleReject(t)}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
