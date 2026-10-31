<div align="center">

# LocalLink

> **Secure, zero-configuration peer-to-peer chat and file transfer for your local network.**  
> No cloud. No accounts. No internet. Just your LAN.

<br>

![Tech](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)
![Tech](https://img.shields.io/badge/Node.js-TCP%20Proxy-339933?style=flat-square&logo=node.js)
![Security](https://img.shields.io/badge/E2EE-X25519%20%2B%20AES--256--GCM-6366f1?style=flat-square&logo=shield)
![Protocol](https://img.shields.io/badge/Protocol-Custom%20Binary-22d3ee?style=flat-square)

</div>

---

## Table of Contents

|   #    | Section                                                         |   #    | Section                                            |
| :----: | :-------------------------------------------------------------- | :----: | :------------------------------------------------- |
| **01** | [What is LocalLink?](#what-is-locallink)                        | **07** | [Getting Started](#getting-started)                |
| **02** | [Features](#features)                                           | **08** | [Running the App](#running-the-app)                |
| **03** | [Architecture Overview](#architecture-overview)                 | **09** | [Module Reference](#module-reference)              |
| **04** | [Security & Encryption (E2EE)](#security--encryption-e2ee)       | **10** | [Known Limitations](#known-limitations)            |
| **05** | [Binary Protocol Specification](#binary-protocol-specification) | **11** | [Port Reference](#port-reference)                  |
| **06** | [Project Structure](#project-structure)                         |        |                                                    |

---

## What is LocalLink?

LocalLink is a **LAN-native**, **end-to-end encrypted** messaging and file transfer application. It runs entirely on your local network — no internet connection, no relay servers, no data ever leaving your machine.

It works by combining:

- **UDP broadcast** for zero-config peer discovery (like mDNS, but simpler)
- **TCP** for reliable, ordered message and file delivery
- **X25519 ECDH + AES-256-GCM** for end-to-end encryption on every connection
- **A local WebSocket proxy** that bridges the React frontend to the TCP/UDP layer
- **React + Vite** for a modern, real-time chat UI

The LAN is treated as a **hostile network**. All payloads are encrypted before they leave the machine, and every connection is independently authenticated.

---

## Features

| Feature                    | Details                                                         |
| :------------------------- | :-------------------------------------------------------------- |
| 🔍 **Auto peer discovery** | UDP broadcast — peers appear automatically, no IP entry needed  |
| 💬 **Real-time chat**        | Encrypted TCP messages with optimistic local rendering          |
| ⌨️ **Typing indicators**    | Live "is typing…" bubbles, debounced to one packet per session  |
| 📎 **File transfer**        | Chunked (256 KB/chunk), base64-encoded, with Accept/Reject UI   |
| 🔒 **E2EE**                 | X25519 key exchange + AES-256-GCM per connection                |
| 🆔 **Session integrity**    | 32-byte session ID validated on every packet                    |
| 📶 **Auto-reconnect**       | WS client reconnects with exponential backoff (1 s → 30 s cap)  |
| 🟢 **Connection status**    | Live badge: Connected / Connecting / Reconnecting / Offline     |
| 🔔 **Unread badges**        | WhatsApp-style unread count per peer in the sidebar             |
| 💾 **Persistent history**   | Chat history saved to `localStorage` per session                |
| 🛡️ **DoS protection**       | 100 MB max payload enforced in the message parser               |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                           Your Machine                           │
│                                                                  │
│   ┌────────────────────────┐        ┌────────────────────────┐   │
│   │     React Frontend     │◄──WS──►│  Node.js Proxy Server  │   │
│   │     (Vite, :3000)      │        │  (:9002 WS)            │   │
│   │                        │        │  (:9000 TCP)           │   │
│   │                        │        │  (:9001 UDP)           │   │
│   └────────────────────────┘        └───────────┬────────────┘   │
│                                                 │                │
│                                 ┌───────────────┘                │
└─────────────────────────────────┼────────────────────────────────┘
                                  │ LAN
                  ┌───────────────┼───────────────┐
                  │               │               │
              TCP :9000  UDP :9001 broadcast  TCP :9000
                  │               │               │
            ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
            │  Peer A   │   │  Peer B   │   │  Peer C   │
            └───────────┘   └───────────┘   └───────────┘
```

### Data Flow

```
Sending a message:

  React UI
    │  JSON over WebSocket (plaintext, localhost only)
    ▼
  Node.js Proxy (index.js)
    │  Encrypt with AES-256-GCM using peer's session key
    │  Wrap in 42-byte binary header
    ▼
  TCP Socket → LAN → Peer's TCP Server
    │  Unwrap header, decrypt payload
    ▼
  Peer's Node.js Proxy
    │  JSON over WebSocket (plaintext, localhost only)
    ▼
  Peer's React UI
```

The WebSocket between the browser and the local proxy is **localhost-only** and carries plaintext JSON. All encryption/decryption happens in the Node.js proxy before anything touches the network.

---

## Security & Encryption (E2EE)

Every TCP connection gets its own independent, ephemeral encrypted session.

### Key Exchange — X25519 ECDH

When a TCP connection is established, the **initiator** (outbound connector) sends a `HANDSHAKE_INIT` packet containing its **X25519 public key** (DER/SPKI format). The **responder** replies with `HANDSHAKE_ACK` containing its own public key.

Both sides compute the same **32-byte shared secret** using `crypto.diffieHellman()`. This shared secret becomes the **AES-256 session key**.

```
Initiator                                Responder
    │                                        │
    │──────── HANDSHAKE_INIT (pubKey) ──────►│
    │                                        │  derives shared secret
    │                                        │
    │◄─────── HANDSHAKE_ACK (pubKey) ────────│
    │                                        │
    │  derives shared secret                 │
    │                                        │
    │════════ AES-256-GCM encrypted ═════════│
```

Key pairs are **ephemeral** — generated fresh on each TCP connection. Forward secrecy is provided naturally: compromising one session key does not expose any other session.

### Payload Encryption — AES-256-GCM

Every payload (chat message, file chunk, typing indicator) is encrypted before transmission:

```
encryptMessage(sessionKey, plaintext):
  nonce      = crypto.randomBytes(12)   // 96-bit, unique per message
  ciphertext = AES-256-GCM.encrypt(plaintext, key=sessionKey, iv=nonce)
  authTag    = cipher.getAuthTag()      // 128-bit GCM auth tag

  wire format: [ nonce (12B) | ciphertext | authTag (16B) ]
```

- **Nonce** is freshly generated per message using `crypto.randomBytes` — nonce reuse is impossible
- **Auth tag** is verified on decryption — any tampering causes `decryptMessage` to throw and the packet is silently dropped

### Session ID Integrity

After the handshake, a **32-byte random Session ID** is established (generated by the responder, sent in the `HANDSHAKE_ACK`). Every subsequent packet from that session must carry this Session ID in its header. The proxy validates it on every message:

```javascript
if (!msg.sessionId.equals(peerState.sessionId)) {
  console.warn(`Dropped message from ${ip}: Invalid Session ID! Possible hijack attempt.`);
  return;
}
```

This prevents session hijacking if a third party sends crafted packets that happen to reach the right TCP port.

### Threat Model

| Threat                       | Mitigation                                                                                                                    |
| :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| Passive eavesdropping on LAN | AES-256-GCM encryption on all TCP payloads                                                                                    |
| MITM (active)                | Not mitigated — no PKI or certificate pinning. Trust is established per-connection on first contact. Future work: TOFU (trust-on-first-use) fingerprinting. |
| Session hijacking            | 32-byte random Session ID verified per packet                                                                                 |
| OOM / DoS via giant packet   | 100 MB payload length cap in `MessageBuffer`                                                                                  |
| Replay attacks               | GCM auth tag + unique nonces make replays detectable; no explicit sequence number replay window                               |

---

## Binary Protocol Specification

All TCP messages use a **custom length-prefixed binary protocol** with a fixed 42-byte header.

### Header Layout

```
Offset   Size   Field
──────  ──────  ───────────────────────────────────────────────
  0      1 B    PROTOCOL_VERSION  (currently: 0x01)
  1      1 B    OPCODE
  2      4 B    PAYLOAD_LENGTH    (Big Endian uint32)
  6      4 B    SEQUENCE_NUM      (Big Endian uint32)
 10     32 B    SESSION_ID
───────────────────────────────────────────────────────────────
 42      n B    PAYLOAD           (encrypted, length from header)
```

Total message size = **42 + PAYLOAD_LENGTH** bytes.

### Opcodes

| Opcode           |  Hex   |       Direction       | Description                          |
| :--------------- | :----: | :-------------------: | :----------------------------------- |
| `HANDSHAKE_INIT` | `0x01` | Initiator → Responder | Public key exchange initiation       |
| `HANDSHAKE_ACK`  | `0x02` | Responder → Initiator | Public key + session ID confirmation |
| `PEER_ANNOUNCE`  | `0x10` |    Internal / UDP     | Peer presence (UDP, not TCP)         |
| `PEER_OFFLINE`   | `0x11` |       Internal        | Peer TTL expiry                      |
| `CHAT_MESSAGE`   | `0x20` |     Bidirectional     | Encrypted chat message               |
| `FILE_OFFER`     | `0x30` |   Sender → Receiver   | File metadata offer                  |
| `FILE_ACCEPT`    | `0x31` |   Receiver → Sender   | Accept file offer                    |
| `FILE_REJECT`    | `0x32` |   Receiver → Sender   | Reject file offer                    |
| `FILE_CHUNK`     | `0x33` |   Sender → Receiver   | Encrypted file data chunk            |
| `FILE_COMPLETE`  | `0x34` |   Sender → Receiver   | Transfer complete signal             |
| `TYPING_START`   | `0x40` |     Bidirectional     | Peer started typing                  |
| `TYPING_STOP`    | `0x41` |     Bidirectional     | Peer stopped typing                  |

### Stream Framing

`MessageBuffer` handles TCP stream reassembly correctly. It accumulates raw bytes in a growing buffer, checks if `buffer.length >= 42` (minimum for a header), reads `PAYLOAD_LENGTH` from the header, then waits until `buffer.length >= 42 + PAYLOAD_LENGTH` before emitting the `message` event. This correctly handles both split packets and multiple coalesced packets in a single `data` event.

---

## Project Structure

```
localLink/
├── package.json              # Workspace root (npm workspaces)
│
├── server/                   # Node.js backend proxy
│   ├── package.json          # Only depends on 'ws'
│   └── src/
│       ├── index.js          # Main entry point — wires all modules together
│       ├── crypto.js         # X25519 ECDH + AES-256-GCM implementation
│       │
│       ├── network/
│       │   ├── PeerDiscovery.js    # UDP broadcast peer discovery + TTL
│       │   ├── TransportManager.js # TCP server + outbound connections
│       │   └── test.js             # Integration test for network layer
│       │
│       └── protocol/
│           ├── constants.js        # Protocol version, header size, opcodes
│           ├── MessageBuffer.js    # TCP stream reassembly (length-prefixed)
│           ├── MessageBuilder.js   # Header + payload packet construction
│           ├── StreamController.js # [deprecated] Disk-file streaming utility
│           └── test.js             # Protocol layer test (chunking, backpressure)
│
└── client/                   # React frontend (Vite)
    ├── index.html
    ├── vite.config.js        # Dev server on :3000, strictPort
    └── src/
        ├── main.jsx          # React entry point
        ├── App.jsx           # Root layout: TopBar, PeerList, ChatWindow, FileTransferBar
        ├── index.css         # LocalLink design system (CSS variables, glassmorphism)
        │
        ├── services/
        │   └── wsClient.js   # Singleton WS client with auto-reconnect + typed events
        │
        ├── components/
        │   ├── ConnectionStatus.jsx  # Live WS state badge in topbar
        │   ├── PeerList.jsx          # Sidebar: discovered peers + unread badges
        │   ├── ChatWindow.jsx        # Message list, input bar, file send flow
        │   └── FileTransferBar.jsx   # Floating panel: incoming file accept/reject + progress
        │
        └── utils/
            └── formatBytes.js        # Shared byte-size formatter (B / KB / MB / GB)
```

---

## Getting Started

### Prerequisites

- **Node.js** v20+ (uses `crypto.randomUUID`, `node --watch`)
- npm v9+

### Installation

```bash
# Clone the repo
git clone https://github.com/yourname/localLink.git
cd localLink

# Install all dependencies (client + server) in one command
npm install
```

---

## Running the App

LocalLink requires **two processes** running simultaneously on each machine: the backend proxy and the frontend dev server.

### Option A — Run both with one command (from repo root)

```bash
npm run dev
```

This uses npm workspaces to start both `client` (Vite on `:3000`) and `server` (Node proxy on `:9000/:9001/:9002`) in parallel.

### Option B — Run each manually

**Terminal 1 — Backend proxy:**
```bash
cd server
node src/index.js YourName
```
Replace `YourName` with your display name. If omitted, a random name like `User_482` is used.

```
Starting LocalLink Proxy for: YourName
[Proxy] TCP Server listening on 0.0.0.0:9000
[Proxy] UDP Discovery broadcasting on port 9001
[Proxy] WebSocket Server listening on ws://localhost:9002
```

**Terminal 2 — Frontend:**
```bash
cd client
npm run dev
```

Then open **http://localhost:3000** in your browser.

### Multi-machine setup

Run the same two commands on each machine on the same LAN (same Wi-Fi or Ethernet switch). Peers will appear automatically within ~3 seconds of the first UDP broadcast cycle.

> **Firewall note:** Make sure TCP port `9000` and UDP port `9001` are allowed through your OS firewall for the app to work across machines. Within the same machine, everything goes through `127.0.0.1` and no firewall rules are needed.

### Running tests

```bash
# Protocol layer test (MessageBuffer + StreamController chunking)
cd server
npm run test:protocol

# Network layer test (UDP discovery + TCP PING/PONG between two instances)
npm run test:network -- Alice 9000 9001 &
npm run test:network -- Bob   9002 9003
```

---

## Module Reference

### `server/src/index.js` — Main Proxy

The central orchestrator. It:
- Wires `PeerDiscovery` (UDP) → `TransportManager` (TCP) → `MessageBuffer` / `MessageBuilder` → `crypto` → WebSocket frontend
- Manages `activePeers` map: `ip → { socket, sessionKey, msgBuffer, sessionId, localKeyPair }`
- Manages `activeTransfers` map: `transferId → ip` (for routing FILE_ACCEPT/REJECT back to sender)
- Handles the full ECDH handshake lifecycle
- Routes decrypted TCP messages to the React frontend over WebSocket

### `server/src/crypto.js`

| Export                                         | Description                                                             |
| :--------------------------------------------- | :---------------------------------------------------------------------- |
| `generateKeyPair()`                            | Generates an ephemeral X25519 key pair (DER format)                     |
| `deriveSharedSecret(privKey, peerPubKey)`      | ECDH → 32-byte shared secret                                            |
| `encryptMessage(sessionKey, plaintext)`        | AES-256-GCM encrypt. Returns `[nonce(12B) + ciphertext + authTag(16B)]` |
| `decryptMessage(sessionKey, encryptedPayload)` | AES-256-GCM decrypt. Throws on auth failure                             |

### `server/src/network/PeerDiscovery.js`

UDP-based LAN peer discovery using subnet broadcast (`255.255.255.255`).

- Broadcasts `{ username, tcpPort, nodeId }` every **3 seconds**
- Filters own broadcasts using `nodeId` (a `crypto.randomUUID()` generated at startup)
- Sweeps for offline peers every **5 seconds** — if a peer hasn't been seen in **15 seconds**, emits `peerOffline`
- Events: `peerFound(peerInfo)`, `peerOffline(ip)`

### `server/src/network/TransportManager.js`

Manages all TCP sockets.

- `startServer()` — binds TCP server on `0.0.0.0:9000`
- `connectToPeer(ip, port)` — dials outbound TCP; pre-connection errors handled with a `once` listener that is removed on successful connect
- `socket.setNoDelay(true)` — Nagle's algorithm disabled for real-time responsiveness
- `socket.setKeepAlive(true, 5000)` — detects silently dead connections
- `normalizeIp(ip)` — strips IPv6-mapped prefix (`::ffff:x.x.x.x → x.x.x.x`) for consistent map keys

### `server/src/protocol/MessageBuffer.js`

Stateful TCP stream reassembler. Accepts raw `Buffer` chunks via `.push(data)` and emits complete `message` events with parsed header fields (`protocolVersion`, `opcode`, `sequenceNum`, `sessionId`, `payload`). Handles all fragmentation and coalescing cases automatically.

### `server/src/protocol/MessageBuilder.js`

Static packet factory. `MessageBuilder.build(opcode, sequenceNum, sessionId, payload)` produces a complete binary packet ready to write to a TCP socket.

### `client/src/services/wsClient.js`

Singleton WebSocket client with:

- **Auto-reconnect** — exponential backoff starting at 1 s, capped at 30 s
- **Typed event system** — `on(eventType, callback)` returns an unsubscribe function
- **`send(type, payload)`** — silently drops if socket is not open
- **`waitDrained(maxBuffered)`** — async backpressure helper for large file transfers; prevents the browser's WS send buffer from overflowing during multi-GB transfers
- **States**: `CONNECTING → OPEN → RECONNECTING → CLOSED`

### `client/src/components/ChatWindow.jsx`

Main chat area. Handles:
- Displaying per-peer message history (persisted to `localStorage`)
- Sending chat messages and typing indicators
- The complete file send flow: select → offer → await accept/reject (60 s timeout, PEER_OFFLINE cancellation) → chunk → complete
- Base64-encodes each 256 KB chunk client-side; backpressure via `wsClient.waitDrained()`

### `client/src/components/FileTransferBar.jsx`

Floating panel that handles the **receiver side** of file transfers:
- Shows incoming file offers with Accept / Reject buttons
- Assembles base64 chunks into a `Blob` in memory (no disk writes until complete)
- Triggers browser download via `URL.createObjectURL` + programmatic `<a>` click
- Download is triggered directly in the event handler (not inside `setState`) to avoid React 18 Strict Mode double-invocation creating ghost downloads

### `client/src/components/PeerList.jsx`

Sidebar listing all active LAN peers. Updates reactively on `PEER_ANNOUNCE` / `PEER_OFFLINE` WebSocket events. Shows unread message count badges (cleared when peer is selected).

---

## Known Limitations

| Limitation                           | Detail                                                                                                                                                   |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No MITM protection**               | Key exchange has no PKI or certificate pinning. A network-level attacker could intercept the ECDH handshake. Future fix: TOFU fingerprint display + user verification. |
| **Chat history keyed by IP**         | If a peer's IP changes (DHCP renewal), their chat history is orphaned. A proper fix requires a persistent identity layer (e.g., public key fingerprint as peer ID).    |
| **Single frontend instance**         | The proxy tracks only one active WebSocket client. Multiple browser tabs on the same machine will compete; only the last one to connect is "active".   |
| **No message delivery confirmation** | Messages are sent over TCP (so they arrive if the connection is live), but there is no application-level ACK or read receipt.                           |
| **File transfer lives in RAM**       | The receiver assembles the entire file in browser memory before downloading. Very large files (multiple GB) may exhaust RAM.                            |

---

## Port Reference

|  Port  | Protocol             | Purpose                                            |
| :----: | :------------------- | :------------------------------------------------- |
| `3000` | HTTP / WS (Vite HMR) | React frontend dev server                          |
| `9000` | TCP                  | Encrypted peer-to-peer messaging and file transfer |
| `9001` | UDP                  | LAN peer discovery broadcasts                      |
| `9002` | WebSocket            | Local proxy ↔ browser bridge (localhost only)      |