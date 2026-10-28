/**
 * wsClient.js — LocalLink WebSocket Service
 *
 * Singleton client that bridges the React UI to the local backend proxy.
 * Connects strictly to ws://localhost:9002 (the backend WS server).
 *
 * Features:
 *  - Automatic reconnection with exponential backoff (1s -> 2s -> 4s ... cap 30s)
 *  - Typed event emitter: 'connection', 'PEER_ANNOUNCE', 'PEER_OFFLINE',
 *    'CHAT_MESSAGE', 'FILE_OFFER', 'FILE_CHUNK', 'FILE_COMPLETE'
 *  - send(type, payload) serialises and transmits JSON messages
 *  - WS_STATE enum for connection state tracking
 */

// Connection state enum
export const WS_STATE = Object.freeze({
  CONNECTING:   'CONNECTING',
  OPEN:         'OPEN',
  RECONNECTING: 'RECONNECTING',
  CLOSED:       'CLOSED',
})

// Event type constants
export const WS_EVENT = Object.freeze({
  CONNECTION:    'connection',
  PEER_ANNOUNCE: 'PEER_ANNOUNCE',
  PEER_OFFLINE:  'PEER_OFFLINE',
  PEER_CONNECT_FAILED: 'PEER_CONNECT_FAILED',
  CHAT_MESSAGE:  'CHAT_MESSAGE',
  TYPING_START:  'TYPING_START',
  TYPING_STOP:   'TYPING_STOP',
  FILE_OFFER:    'FILE_OFFER',
  FILE_ACCEPT:   'FILE_ACCEPT',
  FILE_REJECT:   'FILE_REJECT',
  FILE_CHUNK:    'FILE_CHUNK',
  FILE_COMPLETE: 'FILE_COMPLETE',
})

const WS_URL          = 'ws://localhost:9002'
const BACKOFF_BASE_MS = 1_000   // 1 s initial delay
const BACKOFF_MAX_MS  = 30_000  // 30 s maximum delay

class WSClient {
  constructor() {
    this._ws               = null
    this._state            = WS_STATE.CLOSED
    this._attempts         = 0
    this._reconnectTimer   = null
    this._intentionalClose = false
    this._seq              = 0
    this._listeners        = {}
  }

  get state() { return this._state }

  /**
   * Register a listener for an event type.
   * Returns an unsubscribe function.
   */
  on(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = new Set()
    this._listeners[event].add(cb)
    return () => this._listeners[event]?.delete(cb)
  }

  /**
   * Send a typed JSON message to the backend proxy.
   * Silently drops if socket is not OPEN.
   */
  send(type, payload = {}) {
    if (this._state !== WS_STATE.OPEN || !this._ws) {
      console.warn('[wsClient] Cannot send — socket not open. State:', this._state)
      return
    }
    this._ws.send(JSON.stringify({ type, seq: ++this._seq, ...payload }))
  }

  /**
   * Backpressure helper for large file transfers.
   * Waits (non-blocking) until the browser's WebSocket send buffer drains
   * below `maxBuffered` bytes before resolving.
   *
   * Without this, sending 3GB+ of chunks fills the browser's internal WS
   * buffer (limited to ~64-128MB), causing silent chunk drops while
   * FILE_COMPLETE sneaks through, leaving the receiver with a partial file.
   *
   * @param {number} maxBuffered - Max allowed bytes in the send buffer (default 1MB)
   */
  async waitDrained(maxBuffered = 1 * 1024 * 1024) {
    if (!this._ws) return
    while (this._ws.readyState === WebSocket.OPEN && this._ws.bufferedAmount > maxBuffered) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** Open the connection. Safe to call multiple times. */
  connect() {
    if (this._state === WS_STATE.OPEN || this._state === WS_STATE.CONNECTING) return
    this._intentionalClose = false
    this._openSocket()
  }

  /** Permanently close — no reconnect. */
  disconnect() {
    this._intentionalClose = true
    this._clearReconnectTimer()
    if (this._ws) this._ws.close()
    this._setState(WS_STATE.CLOSED)
  }

  // Private

  _openSocket() {
    this._setState(WS_STATE.CONNECTING)
    console.log(`[wsClient] Connecting to ${WS_URL}... (attempt ${this._attempts + 1})`)

    try {
      this._ws = new WebSocket(WS_URL)
    } catch (err) {
      console.error('[wsClient] WebSocket construction failed:', err)
      this._scheduleReconnect()
      return
    }

    this._ws.onopen = () => {
      console.log('[wsClient] Connected.')
      this._attempts = 0
      this._setState(WS_STATE.OPEN)
    }

    this._ws.onmessage = (event) => this._handleMessage(event.data)

    this._ws.onerror = (err) => {
      console.error('[wsClient] Socket error:', err)
    }

    this._ws.onclose = (event) => {
      console.warn(`[wsClient] Disconnected. Code=${event.code} Clean=${event.wasClean}`)
      this._ws = null
      // Do NOT manually emit CONNECTION here — _scheduleReconnect calls _setState(RECONNECTING)
      // and the intentional-close path calls _setState(CLOSED), both of which emit the event.
      // Emitting manually first caused a double-fire: CLOSED → RECONNECTING in quick succession,
      // making ConnectionStatus flicker and firing listeners twice.
      if (!this._intentionalClose) {
        this._scheduleReconnect()
      } else {
        this._setState(WS_STATE.CLOSED)
      }
    }
  }

  _handleMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      console.error('[wsClient] Received non-JSON message:', raw)
      return
    }
    const { type, ...payload } = msg
    if (Object.values(WS_EVENT).includes(type)) {
      this._emit(type, payload)
    } else {
      console.warn('[wsClient] Unknown message type:', type)
    }
  }

  _scheduleReconnect() {
    this._setState(WS_STATE.RECONNECTING)
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this._attempts, BACKOFF_MAX_MS)
    this._attempts++
    console.log(`[wsClient] Reconnecting in ${delay / 1000}s... (attempt ${this._attempts})`)
    this._reconnectTimer = setTimeout(() => this._openSocket(), delay)
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _setState(newState) {
    if (this._state === newState) return
    this._state = newState
    this._emit(WS_EVENT.CONNECTION, { state: newState, connected: newState === WS_STATE.OPEN })
  }

  _emit(event, payload) {
    this._listeners[event]?.forEach((cb) => {
      try { cb(payload) } catch (err) {
        console.error(`[wsClient] Listener error on "${event}":`, err)
      }
    })
  }
}

const wsClient = new WSClient()
export default wsClient
