const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');
const PeerDiscovery = require('./network/PeerDiscovery');
const TransportManager = require('./network/TransportManager');
const MessageBuffer = require('./protocol/MessageBuffer');
const MessageBuilder = require('./protocol/MessageBuilder');
const { OPCODES } = require('./protocol/constants');
const { generateKeyPair, deriveSharedSecret, encryptMessage, decryptMessage } = require('./crypto');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      const isV4 = net.family === 'IPv4' || net.family === 4;
      if (isV4 && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Deterministic IP comparison for peer-to-peer connection tie-breaking.
 * Strips IPv6-mapped IPv4 prefixes (::ffff:x.x.x.x) and compares numerical octets.
 * Returns >0 if ip1 > ip2, <0 if ip1 < ip2, 0 if equal.
 */
function compareIps(ip1, ip2) {
  if (!ip1 || !ip2) return 0;
  const clean1 = ip1.startsWith('::ffff:') ? ip1.slice(7) : ip1;
  const clean2 = ip2.startsWith('::ffff:') ? ip2.slice(7) : ip2;
  const p1 = clean1.split('.').map(Number);
  const p2 = clean2.split('.').map(Number);
  if (p1.length === 4 && p2.length === 4) {
    for (let i = 0; i < 4; i++) {
      if (p1[i] > p2[i]) return 1;
      if (p1[i] < p2[i]) return -1;
    }
    return 0;
  }
  return clean1.localeCompare(clean2);
}

/**
 * Deterministically selects whether this local node should initiate the outbound
 * TCP connection or wait for the peer's inbound connection.
 * The node with the numerically higher IP initiates the connection.
 * If testing locally on the same IP, the node with the higher TCP port initiates.
 */
function shouldInitiateConnection(remoteIp, remotePort) {
  const localIp = getLocalIp();
  const cmp = compareIps(localIp, remoteIp);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  return TCP_PORT > (remotePort || 9000);
}

// Configuration
const TCP_PORT = 9000;
const UDP_PORT = 9001;
const WS_PORT = 9002; // Distinct from Vite dev port (3000) and TCP/UDP ports (9000/9001)

// Ask for custom username
const username = process.argv[2] || process.env.USERNAME_ARG || process.env.USER_NAME || `User_${Math.floor(Math.random() * 1000)}`;

console.log(`=========================================`);
console.log(` LocalLink E2EE Node Proxy`);
console.log(` User     : ${username}`);
console.log(` Local IP : ${getLocalIp()}`);
console.log(` TCP Port : ${TCP_PORT} (LAN Encrypted Mesh)`);
console.log(` WS Port  : ${WS_PORT} (Browser Local Bridge)`);
console.log(`=========================================`);

// 1. Initialize Network Layers (Aritra's Module)
const transport = new TransportManager(TCP_PORT);
const discovery = new PeerDiscovery(username, TCP_PORT, UDP_PORT);

// 2. Initialize WebSocket Server (Abhinav's Interface)
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`[Proxy] WebSocket Server listening on ws://localhost:${WS_PORT}`);
});

// State Management
const activePeers = new Map(); // ip -> { socket, sessionKey, msgBuffer, sessionId, localKeyPair, name }
const activeTransfers = new Map(); // transferId -> ip
const offlineMessageQueue = new Map(); // ip -> Map(id -> { text, id })
const recentlySentMessageIds = new Map(); // id -> timestamp (TTL 60s to prevent duplicate wire transmission)
let activeWsClient = null; // Single active frontend WebSocket connection

function markMessageSent(id) {
  if (!id) return;
  recentlySentMessageIds.set(id, Date.now());
  if (recentlySentMessageIds.size > 300) {
    const cutoff = Date.now() - 60000;
    for (const [mid, time] of recentlySentMessageIds.entries()) {
      if (time < cutoff) recentlySentMessageIds.delete(mid);
    }
  }
}

function flushOfflineMessages(ip, peerState) {
  if (offlineMessageQueue.has(ip) && peerState.sessionKey && peerState.sessionId && peerState.socket && !peerState.socket.destroyed) {
    const queueMap = offlineMessageQueue.get(ip);
    const items = Array.from(queueMap.values());
    if (items.length > 0) {
      console.log(`[Proxy] Flushing ${items.length} offline queued message(s) to ${ip}`);
      for (const item of items) {
        const text = item.text || item;
        const id = item.id;

        // If this message was already sent over TCP recently, acknowledge to frontend without duplicate wire packet
        if (id && recentlySentMessageIds.has(id)) {
          broadcastWS({
            type: 'MESSAGE_SENT',
            to: ip,
            id,
            text
          });
          continue;
        }

        const encryptedPayload = encryptMessage(peerState.sessionKey, Buffer.from(text));
        const packet = MessageBuilder.build(
          OPCODES.CHAT_MESSAGE,
          Math.floor(Date.now() / 1000) % 4294967295,
          peerState.sessionId,
          encryptedPayload
        );
        peerState.socket.write(packet);
        if (id) markMessageSent(id);

        broadcastWS({
          type: 'MESSAGE_SENT',
          to: ip,
          id,
          text
        });
      }
    }
    offlineMessageQueue.delete(ip);
  }
}

// Connect Aritra's UDP to Abhinav's Frontend
discovery.on('peerFound', (peerInfo) => {
  // Normalize the IP in case UDP discovery returned an IPv6-mapped address
  const ip = peerInfo.ip;
  console.log(`[Proxy] Found peer: ${peerInfo.username} at ${ip}:${peerInfo.tcpPort}`);
  
  // Notify frontend immediately with username
  broadcastWS({
    type: 'PEER_ANNOUNCE',
    peer: {
      id: ip,
      ip: ip,
      name: peerInfo.username
    }
  });

  // Automatically attempt TCP connection only if we are the designated initiator
  if (!activePeers.has(ip) && !transport.pendingSockets.has(ip) && !transport.activeSockets.has(ip)) {
    if (shouldInitiateConnection(ip, peerInfo.tcpPort)) {
      console.log(`[Proxy] Initiating mesh TCP connection to ${ip}:${peerInfo.tcpPort} (higher IP tie-breaker)`);
      transport.connectToPeer(ip, peerInfo.tcpPort);
    } else {
      console.log(`[Proxy] Awaiting inbound mesh TCP connection from ${ip}:${peerInfo.tcpPort} (lower IP tie-breaker)`);
    }
  }
});

// Periodic heartbeat from UDP discovery ensures auto-reconnect if a socket dropped
discovery.on('peerHeartbeat', (peerInfo) => {
  const ip = peerInfo.ip;
  if (!activePeers.has(ip) && !transport.pendingSockets.has(ip) && !transport.activeSockets.has(ip)) {
    if (shouldInitiateConnection(ip, peerInfo.tcpPort)) {
      console.log(`[Proxy] Auto-reconnecting mesh TCP connection to ${peerInfo.username} at ${ip}:${peerInfo.tcpPort}`);
      transport.connectToPeer(ip, peerInfo.tcpPort);
    }
  }
});

discovery.on('peerOffline', (ip) => {
  console.log(`[Proxy] Peer ${ip} offline (TTL expired)`);
  broadcastWS({ type: 'PEER_OFFLINE', peerId: ip });
});

// Connect Aritra's TCP to Arnav's Protocol and Shobit's Crypto
transport.on('connection', ({ ip, socket, isOutbound }) => {
  console.log(`[Proxy] TCP Connected to ${ip}`);
  
  // Protect existing authenticated sessions from collision teardowns
  if (activePeers.has(ip)) {
    const existing = activePeers.get(ip);
    if (existing && existing.sessionKey && existing.socket && !existing.socket.destroyed) {
      console.log(`[Proxy] Active secure session already established with ${ip}. Closing redundant incoming socket.`);
      socket.removeAllListeners();
      socket.destroy();
      return;
    }
    if (existing && existing.socket && existing.socket !== socket) {
      console.log(`[Proxy] Closing old unauthenticated socket for ${ip}`);
      existing.socket.removeAllListeners();
      existing.socket.destroy();
    }
  }

  const localKeyPair = generateKeyPair();
  
  const msgBuffer = new MessageBuffer();
  activePeers.set(ip, { socket, sessionKey: null, msgBuffer, sessionId: null, localKeyPair, name: null });

  // Pipe Aritra's raw data into Arnav's buffer
  socket.on('data', (data) => {
    msgBuffer.push(data);
  });

  // Handle Arnav's perfectly parsed messages
  msgBuffer.on('message', (msg) => {
    const peerState = activePeers.get(ip);
    
    // ECDH Handshake Logic (Shobit's crypto)
    if (msg.opcode === OPCODES.HANDSHAKE_INIT) {
      peerState.sessionKey = deriveSharedSecret(peerState.localKeyPair.privateKey, msg.payload);
      
      // Arnav's Fix: Generate a secure 32-byte Session ID for this connection
      peerState.sessionId = crypto.randomBytes(32);
      
      // Send ACK back
      const ackMsg = MessageBuilder.build(
        OPCODES.HANDSHAKE_ACK,
        0,
        peerState.sessionId, // Send the newly generated session ID
        peerState.localKeyPair.publicKey
      );
      socket.write(ackMsg);
      console.log(`[Proxy] Handshake completed with ${ip}`);

      // Exchange username over encrypted channel
      const namePayload = encryptMessage(peerState.sessionKey, Buffer.from(JSON.stringify({ username })));
      const namePacket = MessageBuilder.build(
        OPCODES.PEER_ANNOUNCE,
        0,
        peerState.sessionId,
        namePayload
      );
      socket.write(namePacket);
      
      broadcastWS({
        type: 'PEER_CONNECTED',
        peer: {
          id: ip,
          ip: ip,
          name: peerState.name || discovery.peers.get(ip)?.username || ip,
          isOnline: true
        }
      });

      flushOfflineMessages(ip, peerState);
      return;
    }

    if (msg.opcode === OPCODES.HANDSHAKE_ACK) {
      peerState.sessionKey = deriveSharedSecret(peerState.localKeyPair.privateKey, msg.payload);
      
      // Arnav's Fix: Store the Session ID provided by the peer
      peerState.sessionId = msg.sessionId;
      console.log(`[Proxy] Handshake ACK received from ${ip}`);

      // Exchange username over encrypted channel
      const namePayload = encryptMessage(peerState.sessionKey, Buffer.from(JSON.stringify({ username })));
      const namePacket = MessageBuilder.build(
        OPCODES.PEER_ANNOUNCE,
        0,
        peerState.sessionId,
        namePayload
      );
      socket.write(namePacket);

      broadcastWS({
        type: 'PEER_CONNECTED',
        peer: {
          id: ip,
          ip: ip,
          name: peerState.name || discovery.peers.get(ip)?.username || ip,
          isOnline: true
        }
      });

      flushOfflineMessages(ip, peerState);
      return;
    }

    // Decrypt standard messages
    if (!peerState.sessionKey || !peerState.sessionId) {
      console.warn(`[Proxy] Received encrypted message from ${ip} but handshake is not complete.`);
      return;
    }
    
    // Arnav's Fix: Enforce Session ID matches!
    if (!msg.sessionId.equals(peerState.sessionId)) {
      console.warn(`[Proxy] Dropped message from ${ip}: Invalid Session ID! Possible hijack attempt.`);
      return;
    }

    try {
      const plaintext = decryptMessage(peerState.sessionKey, msg.payload);
      
      // Route decrypted message to Abhinav's frontend
      if (msg.opcode === OPCODES.PEER_ANNOUNCE) {
        let peerName = ip;
        try {
          const parsed = JSON.parse(plaintext.toString());
          if (parsed && parsed.username) peerName = parsed.username;
        } catch {
          peerName = plaintext.toString() || ip;
        }
        peerState.name = peerName;
        console.log(`[Proxy] Direct peer announced name: ${peerName} (${ip})`);
        broadcastWS({
          type: 'PEER_ANNOUNCE',
          peer: {
            id: ip,
            ip: ip,
            name: peerName
          }
        });
      } else if (msg.opcode === OPCODES.CHAT_MESSAGE) {
        broadcastWS({
          type: 'CHAT_MESSAGE',
          from: ip, // The frontend expects 'from', not 'sender'
          text: plaintext.toString(),
          ts: Date.now() // Frontend uses this for message timestamps
        });
      } else if (msg.opcode === OPCODES.TYPING_START) {
        broadcastWS({ type: 'TYPING_START', from: ip });
      } else if (msg.opcode === OPCODES.TYPING_STOP) {
        broadcastWS({ type: 'TYPING_STOP', from: ip });
      } else if ([OPCODES.FILE_OFFER, OPCODES.FILE_ACCEPT, OPCODES.FILE_REJECT, OPCODES.FILE_CHUNK, OPCODES.FILE_COMPLETE].includes(msg.opcode)) {
        const payloadObj = JSON.parse(plaintext.toString());
        
        if (msg.opcode === OPCODES.FILE_OFFER && payloadObj.transferId) {
          activeTransfers.set(payloadObj.transferId, ip);
        }
        
        let type = '';
        if (msg.opcode === OPCODES.FILE_OFFER) type = 'FILE_OFFER';
        else if (msg.opcode === OPCODES.FILE_ACCEPT) type = 'FILE_ACCEPT';
        else if (msg.opcode === OPCODES.FILE_REJECT) type = 'FILE_REJECT';
        else if (msg.opcode === OPCODES.FILE_CHUNK) type = 'FILE_CHUNK';
        else if (msg.opcode === OPCODES.FILE_COMPLETE) type = 'FILE_COMPLETE';

        broadcastWS({ ...payloadObj, type, from: ip });
      }
    } catch (err) {
      console.error(`[Proxy] Failed to decrypt message from ${ip}:`, err.message);
    }
  });

  if (isOutbound) {
    // Initiate Handshake if we connected out
    const initMsg = MessageBuilder.build(
      OPCODES.HANDSHAKE_INIT,
      0,
      Buffer.alloc(32, 0), // Dummy session ID until ACK provides the real one
      localKeyPair.publicKey
    );
    socket.write(initMsg);
  }
});

transport.on('disconnected', (ip) => {
  console.log(`[Proxy] TCP Disconnected from ${ip}`);
  activePeers.delete(ip);
  broadcastWS({ type: 'PEER_OFFLINE', peerId: ip }); // Frontend expects peerId
});

transport.on('connectError', ({ ip, error }) => {
  console.warn(`[Proxy] TCP Connection to ${ip} failed: ${error}`);
  broadcastWS({
    type: 'PEER_CONNECT_FAILED',
    ip,
    error: error || 'Connection failed'
  });
});

// Connect Abhinav's Frontend to Arnav's Protocol and Aritra's TCP
wss.on('connection', (ws) => {
  console.log('[Proxy] Frontend React UI connected via WebSocket.');

  // Track the most recently connected client as the only active one.
  // This naturally handles hot-reloads and reconnects without terminating
  // old connections (which would trigger an infinite reconnect storm).
  activeWsClient = ws;

  ws.on('close', () => {
    if (activeWsClient === ws) activeWsClient = null;
  });

  // Send local client info (username and detected local IP)
  ws.send(JSON.stringify({
    type: 'MY_INFO',
    username,
    ip: getLocalIp()
  }));
  // Immediately re-announce all peers that have COMPLETED the ECDH handshake (sessionKey set).
  // Also announce any peers discovered via UDP that are pending connection.
  const announcedIps = new Set();
  for (const [ip, peerState] of activePeers.entries()) {
    if (!peerState.sessionKey) continue;
    announcedIps.add(ip);
    const discoveredInfo = discovery.peers.get(ip);
    ws.send(JSON.stringify({
      type: 'PEER_CONNECTED',
      peer: {
        id: ip,
        ip: ip,
        name: peerState.name || discoveredInfo?.username || ip,
        isOnline: true
      }
    }));
  }

  for (const [ip, peerInfo] of discovery.peers.entries()) {
    if (!announcedIps.has(ip)) {
      ws.send(JSON.stringify({
        type: 'PEER_ANNOUNCE',
        peer: {
          id: ip,
          ip: ip,
          name: peerInfo.username || ip,
          isOnline: false
        }
      }));
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'CONNECT_PEER') {
        const targetIp = (msg.ip || '').trim();
        if (!targetIp) return;
        console.log(`[Proxy] Direct TCP connection requested to: ${targetIp}`);
        const existing = activePeers.get(targetIp);
        if (existing && existing.sessionKey) {
          broadcastWS({
            type: 'PEER_ANNOUNCE',
            peer: {
              id: targetIp,
              ip: targetIp,
              name: existing.name || discovery.peers.get(targetIp)?.username || targetIp
            }
          });
        } else {
          transport.connectToPeer(targetIp, TCP_PORT);
        }
      } else if (msg.type === 'CHAT_MESSAGE') {
        const { to, text, id } = msg; // Frontend sends 'to', 'text', 'id'
        const peerState = activePeers.get(to);
        
        // If this message was already sent over TCP recently, acknowledge to frontend without sending duplicate packet
        if (id && recentlySentMessageIds.has(id)) {
          broadcastWS({
            type: 'MESSAGE_SENT',
            to,
            id,
            text
          });
          return;
        }

        if (peerState && peerState.sessionKey && peerState.sessionId && !peerState.socket.destroyed) {
          const encryptedPayload = encryptMessage(peerState.sessionKey, Buffer.from(text));
          const packet = MessageBuilder.build(
            OPCODES.CHAT_MESSAGE,
            Math.floor(Date.now() / 1000) % 4294967295, // fit into 32-bit unsigned int
            peerState.sessionId, // Arnav's Fix: Use actual session ID!
            encryptedPayload
          );
          peerState.socket.write(packet);
          if (id) markMessageSent(id);
          broadcastWS({
            type: 'MESSAGE_SENT',
            to,
            id,
            text
          });
        } else {
          console.log(`[Proxy] Peer ${to} not connected right now. Queueing message for reconnection.`);
          if (!offlineMessageQueue.has(to)) offlineMessageQueue.set(to, new Map());
          const key = id || `temp-${Date.now()}-${Math.random()}`;
          offlineMessageQueue.get(to).set(key, { text, id });
          if (!activePeers.has(to) && !transport.pendingSockets.has(to)) {
            transport.connectToPeer(to, TCP_PORT);
          }
        }
      } else if (['TYPING_START', 'TYPING_STOP'].includes(msg.type)) {
        const { to } = msg;
        const peerState = activePeers.get(to);
        if (peerState && peerState.sessionKey) {
          const opcode = msg.type === 'TYPING_START' ? OPCODES.TYPING_START : OPCODES.TYPING_STOP;
          const encryptedPayload = encryptMessage(peerState.sessionKey, Buffer.from(''));
          const packet = MessageBuilder.build(opcode, Math.floor(Date.now() / 1000) % 4294967295, peerState.sessionId, encryptedPayload);
          peerState.socket.write(packet);
        }
      } else if (['FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK', 'FILE_COMPLETE'].includes(msg.type)) {
        const { type, to, ...rest } = msg;
        
        // Find the target IP. Abhinav's frontend doesn't send 'to' for ACCEPT/REJECT, so we look it up!
        const targetIp = to || activeTransfers.get(rest.transferId);
        const peerState = activePeers.get(targetIp);

        if (peerState && peerState.sessionKey) {
          let opcode;
          if (type === 'FILE_OFFER') opcode = OPCODES.FILE_OFFER;
          else if (type === 'FILE_ACCEPT') opcode = OPCODES.FILE_ACCEPT;
          else if (type === 'FILE_REJECT') opcode = OPCODES.FILE_REJECT;
          else if (type === 'FILE_CHUNK') opcode = OPCODES.FILE_CHUNK;
          else if (type === 'FILE_COMPLETE') opcode = OPCODES.FILE_COMPLETE;

          const encryptedPayload = encryptMessage(peerState.sessionKey, Buffer.from(JSON.stringify(rest)));
          const packet = MessageBuilder.build(opcode, Math.floor(Date.now() / 1000) % 4294967295, peerState.sessionId, encryptedPayload);
          peerState.socket.write(packet);
        }
      }
    } catch (err) {
      console.error('[Proxy] Error handling WS message:', err);
    }
  });
});

function broadcastWS(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Start everything
transport.startServer().then(() => {
  console.log(`[Proxy] TCP Server listening on 0.0.0.0:${TCP_PORT}`);
  discovery.start();
  console.log(`[Proxy] UDP Discovery broadcasting on port ${UDP_PORT}`);
}).catch(console.error);
