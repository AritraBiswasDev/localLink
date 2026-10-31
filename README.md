<div align="center">

# LocalLink

> **Secure, zero-configuration peer-to-peer chat and file transfer for your local network.**  
> No cloud. No accounts. No internet. Just your LAN.

<br>

![Tech](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)
![Tech](https://img.shields.io/badge/Node.js-TCP%20Proxy-339933?style=flat-square&logo=node.js)
![Security](https://img.shields.io/badge/E2EE-X25519%20%2B%20AES--256--GCM-6366f1?style=flat-square&logo=shield)
![Protocol](https://img.shields.io/badge/Protocol-Custom%20Binary%20(42B)-22d3ee?style=flat-square)
![Offline](https://img.shields.io/badge/Offline-Store%20%26%20Forward-10b981?style=flat-square)

</div>

---

## Table of Contents

|   #    | Section                                                                                      |   #    | Section                                                                |
| :----: | :------------------------------------------------------------------------------------------- | :----: | :--------------------------------------------------------------------- |
| **01** | [What is LocalLink?](#what-is-locallink)                                                     | **08** | [Project Structure](#project-structure)                                |
| **02** | [Features](#features)                                                                        | **09** | [Getting Started & Installation](#getting-started--installation)        |
| **03** | [Architecture Overview](#architecture-overview)                                              | **10** | [Running the Application](#running-the-application)                    |
| **04** | [Security & Encryption (E2EE)](#security--encryption-e2ee)                                    | **11** | [Module Reference](#module-reference)                                  |
| **05** | [Binary Protocol Specification](#binary-protocol-specification)                              | **12** | [Known Limitations](#known-limitations)                                |
| **06** | [Store-and-Forward Outbox & Offline Messaging](#store-and-forward-outbox--offline-messaging) | **13** | [Port Reference](#port-reference)                                      |
| **07** | [File Transfer Protocol & Safety Controls](#file-transfer-protocol--safety-controls)          |        |                                                                        |

---

## What is LocalLink?

LocalLink is a **LAN-native**, **zero-trust**, **end-to-end encrypted** messaging and file transfer application. It runs entirely on your local network — no internet connection, no relay servers, and zero data leaving your premises.

It operates by combining:

- **Subnet-directed UDP broadcast** for zero-config peer discovery across subnets, hotspots, and local routers.
- **Deterministic P2P TCP Mesh** with IP numerical tie-breaking to prevent simultaneous cross-connect race conditions.
- **X25519 ECDH + AES-256-GCM** for end-to-end encryption on every peer connection.
- **Store-and-Forward Outbox** with `localStorage` and proxy-level persistence for offline message delivery.
- **A local Node.js WebSocket bridge** that connects the React browser client to raw TCP/UDP networking.
- **React 19 + Vite** for a modern, responsive, distraction-free chat UI with light/dark themes.

The LAN is treated as a **hostile network**. All payloads are encrypted before transmission over TCP, nonces are never reused, and every connection is independently authenticated with a 32-byte session ID.

---

## Features

| Feature                                | Details                                                                                                              |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| 🔍 **Subnet Peer Discovery**           | UDP broadcast across calculated subnet masks (e.g. `10.97.67.255`, `255.255.255.255`) every 2 seconds.               |
| ⚖️ **Deterministic P2P Tie-Breaker**   | Numerical IP comparison prevents simultaneous connection collisions and socket disconnect loops.                     |
| 💬 **End-to-End Encrypted Chat**       | Ephemeral X25519 key exchange + AES-256-GCM with unique 96-bit nonces per packet.                                   |
| 🕒 **Store-and-Forward Outbox**        | Messages typed while a peer is offline queue with `🕒` and automatically flush when the peer reconnects.              |
| ✓ **Genuine Delivery Acks**            | Single checkmark (`✓`) is confirmed strictly when the proxy writes the encrypted packet into the TCP socket.         |
| 📥 **Inbox Buffering on Reload**        | Incoming messages received while the React UI is reconnecting are buffered and delivered immediately on UI mount.     |
| 👥 **Persistent Offline Peers**        | Offline peers remain in the sidebar with an idle dot and "Offline" indicator; contact list persists across reloads.   |
| 🔎 **Smart Search & Direct IP Connect** | Search contacts or enter any campus/LAN IP directly with keyboard shortcut (`Ctrl+K` or `/`).                        |
| 📎 **Controlled File Transfers**       | 256 KB chunk streaming with progress bars, Accept/Reject prompts, and browser memory assembly.                       |
| 🛡️ **50 MB Campus Safety Limit**       | Enforces a strict 50 MB limit per file to conserve local RAM and network buffers.                                    |
| ✕ **Offline File Transfer Guard**      | Attachment button disables when peer is offline; failed or blocked transfers display a bold red cross (`✕`).         |
| 🚫 **0-Byte Ghost Download Guard**     | Synchronous ref tracking prevents React 18 Strict Mode double-invocation from creating empty ghost files.            |
| 🔒 **E2EE Security Inspector**         | Visual verification modal displaying current session key status, algorithm details, and peer endpoints.             |
| 🗑️ **Single-Chat History Clearing**     | Trash button in header with confirmation modal clears history for that specific peer only.                           |
| ⌨️ **Live Typing Indicators**          | Real-time "typing…" bubbles debounced to avoid network spam.                                                         |
| 🔔 **Audio Notification Chimes**       | Synthesized dual-tone sine wave chime via Web Audio API on incoming messages.                                        |
| 🌓 **Light & Dark Theme**              | Instant theme switcher persisted to `localStorage`.                                                                  |

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
                                  │ LAN / Wi-Fi / Hotspot
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
Sending a chat message:

  React UI (ChatWindow.jsx)
    │  Optimistically renders message with status: 'pending' (🕒)
    │  Saves to localStorage outbox ('locallink_outbox')
    │  Sends JSON over WebSocket to localhost:9002
    ▼
  Node.js Proxy (server/src/index.js)
    │  If peer is offline: queues in offlineMessageQueue until PEER_CONNECTED
    │  If peer is online: encrypts plaintext with AES-256-GCM using peer's sessionKey
    │  Constructs 42-byte binary protocol packet with peer's sessionId
    ▼
  TCP Socket (TransportManager.js) → LAN → Peer's TCP Server (:9000)
    │  Local proxy broadcasts MESSAGE_SENT to UI → UI updates status to 'sent' (✓)
    ▼
  Peer's Node.js Proxy
    │  Reassembles TCP stream in MessageBuffer.js
    │  Verifies 32-byte Session ID matches active authenticated session
    │  Decrypts AES-256-GCM payload with peer sessionKey
    │  Buffers in inboxBuffer if frontend UI is momentarily reconnecting
    │  Sends JSON CHAT_MESSAGE over WebSocket to localhost:9002
    ▼
  Peer's React UI
    │  Renders message bubble, deduplicates identical packets, plays audio chime
    │  Persists message to localStorage ('locallink_chats')
```

---

## Security & Encryption (E2EE)

Every peer-to-peer TCP connection negotiates an independent, ephemeral session key.

### Key Exchange — X25519 ECDH

When a TCP connection is established, the connection initiator sends a `HANDSHAKE_INIT` packet containing its **X25519 public key** (DER/SPKI format). The responder generates a random 32-byte Session ID and returns a `HANDSHAKE_ACK` packet containing its public key and the Session ID.

Both peers compute the identical **32-byte shared secret** using `crypto.diffieHellman()`. This secret is used directly as the **AES-256-GCM session key**.

```
Initiator (Higher IP)                  Responder (Lower IP)
    │                                          │
    │───────── HANDSHAKE_INIT (pubKey) ────────►│
    │                                          │  Computes shared secret
    │                                          │  Generates 32B random Session ID
    │                                          │
    │◄──── HANDSHAKE_ACK (pubKey, sessionId) ──│
    │                                          │
    │  Computes shared secret                  │
    │  Stores Session ID                       │
    │                                          │
    │══════════ AES-256-GCM Encrypted ═════════│
```

- **Ephemeral Keys**: Key pairs are generated fresh per connection. Compromising one session key does not compromise past or future sessions.
- **Deterministic Initiator**: Connection collisions are prevented by comparing numerical IP octets (`compareIps`). Only the peer with the higher IP opens the outbound TCP socket; the lower-IP peer passively listens.

### Payload Encryption — AES-256-GCM

Every message, file chunk, and typing event is encrypted before transmission:

```
encryptMessage(sessionKey, plaintext):
  nonce      = crypto.randomBytes(12)   // 96-bit unique IV (NEVER reused)
  ciphertext = AES-256-GCM.encrypt(plaintext, key=sessionKey, iv=nonce)
  authTag    = cipher.getAuthTag()      // 128-bit (16 bytes) authentication tag

  Wire Format: [ nonce (12B) | ciphertext | authTag (16B) ]
```

- **Nonce Freshness**: A fresh 12-byte random nonce is generated for every single packet.
- **Authentication Tag**: The 16-byte GCM tag authenticates ciphertext integrity. Any tampering causes decryption to fail and the packet is immediately dropped.

### Session ID Validation

Every post-handshake packet must include the negotiated 32-byte Session ID in bytes 10–41 of the header:

```javascript
if (!msg.sessionId.equals(peerState.sessionId)) {
  console.warn(`[Proxy] Dropped message from ${ip}: Invalid Session ID! Possible hijack attempt.`);
  return;
}
```

---

## Binary Protocol Specification

All TCP traffic uses a custom length-prefixed binary protocol with a fixed **42-byte header**.

### Header Layout

```
Offset   Size   Field             Type / Description
──────  ──────  ────────────────  ───────────────────────────────────────────
  0      1 B    PROTOCOL_VERSION  Version byte (current: 0x01)
  1      1 B    OPCODE            Operation identifier (e.g. 0x20 for CHAT)
  2      4 B    PAYLOAD_LENGTH    Big-Endian uint32 (length of following payload)
  6      4 B    SEQUENCE_NUM      Big-Endian uint32 timestamp/sequence counter
 10     32 B    SESSION_ID        32-byte cryptographic session identifier
─────────────────────────────────────────────────────────────────────────────
 42      n B    PAYLOAD           Encrypted payload (length specified in header)
```

Total packet size = **42 + PAYLOAD_LENGTH** bytes.

### Defined Opcodes

| Opcode           |  Hex   |         Flow          | Purpose                                                     |
| :--------------- | :----: | :-------------------: | :---------------------------------------------------------- |
| `HANDSHAKE_INIT` | `0x01` | Initiator → Responder | Ephemeral X25519 public key exchange initiation             |
| `HANDSHAKE_ACK`  | `0x02` | Responder → Initiator | Public key acknowledgment + Session ID confirmation         |
| `PEER_ANNOUNCE`  | `0x10` |     Bidirectional     | Direct encrypted username exchange after handshake          |
| `PEER_OFFLINE`   | `0x11` |    Internal Proxy     | Emitted when peer UDP broadcast expires (15s TTL)           |
| `CHAT_MESSAGE`   | `0x20` |     Bidirectional     | Encrypted UTF-8 text message                                |
| `FILE_OFFER`     | `0x30` |   Sender → Receiver   | File transfer request with name, size, mimeType, transferId |
| `FILE_ACCEPT`    | `0x31` |   Receiver → Sender   | Approval to begin streaming file chunks                     |
| `FILE_REJECT`    | `0x32` |   Receiver → Sender   | Rejection of file transfer offer                            |
| `FILE_CHUNK`     | `0x33` |   Sender → Receiver   | Encrypted 256 KB file chunk with index and totalChunks      |
| `FILE_COMPLETE`  | `0x34` |   Sender → Receiver   | Notification that all file chunks have finished sending     |
| `TYPING_START`   | `0x40` |     Bidirectional     | Live notification that user started typing                  |
| `TYPING_STOP`    | `0x41` |     Bidirectional     | Live notification that user stopped typing                  |

### Stream Framing & MessageBuffer

Because TCP is a continuous byte stream, packets may be fragmented or coalesced. [`MessageBuffer.js`](server/src/protocol/MessageBuffer.js) buffers raw incoming bytes, reads `PAYLOAD_LENGTH` from offset 2, and enforces a **100 MB maximum payload cap** for memory safety before emitting a complete `message` event.

---

## Store-and-Forward Outbox & Offline Messaging

LocalLink provides seamless offline messaging without centralized servers:

1. **Queuing Offline Messages**:
   - If a peer is offline or currently disconnecting, sending a message adds it to `localStorage` (`locallink_outbox`) and the backend proxy (`offlineMessageQueue`).
   - The UI immediately renders the message bubble with an offline pending indicator: `🕒`.
2. **Reconnection & Automatic Flush**:
   - When the peer comes back online and completes the ECDH handshake, the proxy emits `PEER_CONNECTED`.
   - The outbox flushes all queued messages over the newly authenticated encrypted TCP session.
3. **Genuine Delivery Confirmation**:
   - When the proxy successfully writes the packet to the TCP socket, it broadcasts `MESSAGE_SENT` to the browser.
   - The message status in `ChatWindow.jsx` flips from `🕒` to `✓`, and the message is cleared from the outbox.
4. **Inbox Buffering**:
   - If peer messages arrive while your browser tab is reloading or reconnecting to WebSocket (`:9002`), the Node proxy holds them in `inboxBuffer` (up to 500 messages) and pushes them the instant the browser WebSocket reconnects.

---

## File Transfer Protocol & Safety Controls

LocalLink includes end-to-end encrypted file sharing built directly on top of the binary TCP stream:

### 1. 50 MB Campus Safety Limit
Files larger than 50 MB (`50 * 1024 * 1024` bytes) are blocked immediately at the UI layer with a clear warning:
> `⚠️ File blocked: "file.ext" is 64.2 MB. Campus limit is 50 MB to conserve memory.`

### 2. Live Connection Requirement & Offline Guard
Because file transfers stream in active chunks, **files cannot be queued offline**.
- When a peer is offline, the paperclip attachment icon is visually dimmed (`opacity: 0.45`, `cursor: not-allowed`) with tooltip `"File transfer unavailable while peer is offline"`.
- If an offline file send is attempted, it immediately displays an error bubble stamped with a bold red cross (`✕`):
  > `❌ Cannot send "file.ext": [Peer] is offline. Live connection required for transfers.`

### 3. Chunk Streaming & Flow Control
- **Chunk Size**: Files are sliced into **256 KB** chunks and base64-encoded.
- **Handshake Flow**: Sender emits `FILE_OFFER` → Receiver accepts via `FILE_ACCEPT` → Sender streams `FILE_CHUNK` (0 to N) → Sender emits `FILE_COMPLETE`.
- **WebSocket Backpressure**: The sender awaits `wsClient.waitDrained(1 * 1024 * 1024)` before pushing the next chunk, preventing browser WebSocket buffer overflows.
- **Ghost Download Guard**: Receivers track completed transfer IDs in a synchronous ref (`completedTransfersRef`) and invoke browser download directly in the `FILE_COMPLETE` handler (never inside React state updaters) to eliminate React 18 Strict Mode double-download bugs.

---

## Project Structure

```
localLink/
├── package.json              # Workspace root (npm workspaces: client, server)
├── README.md                 # Project documentation
│
├── server/                   # Node.js backend proxy
│   ├── package.json          # Server package configuration (depends on 'ws')
│   ├── test/
│   │   └── crypto.test.js    # Node native test runner suite for ECDH & AES-256-GCM
│   └── src/
│       ├── index.js          # Main proxy orchestrator, tie-breaker, & WS bridge
│       ├── crypto.js         # X25519 ECDH + AES-256-GCM encryption engine
│       │
│       ├── network/
│       │   ├── PeerDiscovery.js    # UDP broadcast discovery + subnet calculation
│       │   ├── TransportManager.js # TCP mesh server + socket lifecycle manager
│       │   └── test.js             # Network integration test
│       │
│       └── protocol/
│           ├── constants.js        # 42-byte header size, opcodes, protocol version
│           ├── MessageBuffer.js    # TCP stream reassembly & 100MB DoS protection
│           ├── MessageBuilder.js   # Binary packet builder
│           ├── StreamController.js # Disk-file streaming utility
│           └── test.js             # Protocol chunking and backpressure tests
│
└── client/                   # React 19 + Vite frontend
    ├── index.html            # Web entry point
    ├── vite.config.js        # Vite config on :3000
    ├── package.json          # Frontend dependencies (React 19, Tailwind v4)
    └── src/
        ├── main.jsx          # React DOM root
        ├── App.jsx           # App shell, topbar, theme sync, active peer state
        ├── index.css         # Minimal dark/light design system
        │
        ├── services/
        │   └── wsClient.js   # Singleton WebSocket client with auto-reconnect & typed events
        │
        ├── components/
        │   ├── ChatWindow.jsx        # Messages, outbox sync, file sender, clear chat modal
        │   ├── ConnectionStatus.jsx  # Live topbar connection indicator
        │   ├── FileTransferBar.jsx   # Receiver floating bar with Accept/Reject & progress
        │   └── PeerList.jsx          # Sidebar: smart search, direct IP connect, offline peers
        │
        └── utils/
            └── formatBytes.js        # Byte size formatter (B, KB, MB, GB)
```

---

## Getting Started & Installation

### Prerequisites

- **Node.js**: v20+ recommended (Node 18+ supported; uses `crypto.diffieHellman` and `crypto.randomUUID`)
- **npm**: v9+
- **Network**: Local Wi-Fi, Ethernet switch, or mobile Wi-Fi Hotspot (no internet connection needed)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourname/localLink.git
cd localLink

# Install all dependencies for both client and server
npm install
```

---

## Running the Application

LocalLink runs two lightweight processes per device: the Node.js backend proxy and the React frontend dev server.

### Option A — Run both concurrently (from repository root)

```bash
npm run dev
```

### Option B — Run each manually in separate terminals

**Terminal 1 — Node.js Backend Proxy:**
```bash
cd server
node src/index.js YourUsername
```
*(If username is omitted, a random handle like `User_482` will be assigned).*

```text
=========================================
 LocalLink E2EE Node Proxy
 User     : YourUsername
 Local IP : 10.97.67.203
 TCP Port : 9000 (LAN Encrypted Mesh)
 WS Port  : 9002 (Browser Local Bridge)
=========================================
[Proxy] WebSocket Server listening on ws://localhost:9002
[Proxy] TCP Server listening on 0.0.0.0:9000
[Proxy] UDP Discovery broadcasting on port 9001
```

**Terminal 2 — React Frontend:**
```bash
cd client
npm run dev
```

Open your browser to **http://localhost:3000**.

### Connecting Across Campus or Hotspots

1. **Same Wi-Fi / Hotspot**: Simply launch LocalLink on both machines. UDP discovery broadcasts will automatically discover the other peer within 2 seconds.
2. **Direct IP Connect**: If UDP broadcast is disabled by router AP isolation, press `Ctrl+K` or click the search bar in the sidebar, type your peer's local IP address (e.g. `10.97.67.45`), and press **Enter** to initiate a direct TCP connection.

### Running Automated Tests

```bash
# Run unit tests for ECDH key exchange & AES-256-GCM encryption
node --test server/test/crypto.test.js

# Run protocol layer tests
npm run test:protocol --workspace=server

# Run client linter (Oxlint)
npm run lint --workspace=client

# Build production client bundle
npm run build --workspace=client
```

---

## Module Reference

### `server/src/index.js` — Core Proxy
- Orchestrates UDP discovery, TCP mesh connections, cryptographic handshake, and WebSocket forwarding.
- Implements `compareIps(myIp, peerIp)` and `shouldInitiateConnection()` to break P2P connection ties deterministically.
- Maintains `activePeers`, `offlineMessageQueue`, `recentlySentMessageIds`, and `inboxBuffer`.

### `server/src/crypto.js` — Cryptographic Primitives
- `generateKeyPair()`: Generates ephemeral X25519 key pair in DER format.
- `deriveSharedSecret(privateKey, peerPublicKey)`: Computes 32-byte shared secret via ECDH.
- `encryptMessage(sessionKey, plaintext)`: Returns `[nonce (12B) | ciphertext | authTag (16B)]`.
- `decryptMessage(sessionKey, encryptedPayload)`: Verifies auth tag and decrypts ciphertext; throws on tampering.

### `server/src/network/PeerDiscovery.js` — UDP Discovery
- Computes directed subnet broadcast addresses (`getBroadcastAddresses`) across all non-internal IPv4 interfaces.
- Emits `peerFound`, `peerHeartbeat`, and `peerOffline` (15s TTL).

### `server/src/network/TransportManager.js` — TCP Transport
- Binds TCP server to `0.0.0.0:9000` with `TCP_NODELAY` and `setKeepAlive(true, 5000)`.
- Protects healthy established connections from redundant inbound/outbound collision teardowns.

### `client/src/components/ChatWindow.jsx` — Chat Area
- Renders decrypted messages with timestamps, statuses (`pending 🕒`, `sent ✓`, `failed ✕`).
- Manages store-and-forward outbox queue with `localStorage` persistence.
- Handles file selection, 50 MB limit validation, Accept/Reject promises, and chunk streaming.
- Provides modal dialog to clear single-chat history.

### `client/src/components/PeerList.jsx` — Contacts Sidebar
- Displays discovered LAN peers with online/offline indicators and unread count badges.
- Retains discovered contacts in `localStorage` under `locallink_known_peers`.
- Provides smart search and direct IP input with `Ctrl+K` keyboard shortcut.

### `client/src/components/FileTransferBar.jsx` — File Receiver
- Renders floating notifications for incoming file offers with Accept / Reject controls.
- Reassembles raw chunks into an in-memory `Blob` and triggers clean downloads.

---

## Known Limitations

| Area                          | Current State & Behavior                                                                                                                                                 |
| :---------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity Verification**     | Ephemeral keys provide forward secrecy but lack centralized PKI. Active MITM on local network is not cryptographically authenticated without manual fingerprint verification. |
| **IP-Keyed History**          | Chat histories are organized by peer IP address. If a DHCP lease changes a peer's IP address, past history remains attached to the previous IP.                          |
| **In-Memory File Assembly**   | Incoming file chunks are assembled as a `Blob` in browser RAM before disk write. The 50 MB safety limit protects against memory exhaustion.                              |
| **Inter-VLAN Campus Routers** | Some enterprise / university networks isolate subnets with firewalls that drop all inter-student TCP/UDP traffic between hostel blocks. Hotspot or same-router connection is recommended in those environments. |

---

## Port Reference

|  Port  | Protocol  |         Scope         | Description                                          |
| :----: | :-------- | :-------------------: | :--------------------------------------------------- |
| `3000` | HTTP / WS |       Localhost       | Vite development server hosting the React UI         |
| `9000` | TCP       |    LAN (`0.0.0.0`)    | Raw length-prefixed encrypted peer-to-peer transport |
| `9001` | UDP       |     LAN Broadcast     | Subnet peer discovery beacons                        |
| `9002` | WebSocket | Localhost (`127.0.0.1`) | Local IPC bridge between browser and Node.js proxy   |
