const WebSocket = require('ws');
const crypto = require('crypto');
const PeerDiscovery = require('./network/PeerDiscovery');
const TransportManager = require('./network/TransportManager');
const MessageBuffer = require('./protocol/MessageBuffer');
const MessageBuilder = require('./protocol/MessageBuilder');
const { OPCODES } = require('./protocol/constants');
const { generateKeyPair, deriveSharedSecret, encryptMessage, decryptMessage } = require('./crypto');

// Configuration
const TCP_PORT = 9000;
const UDP_PORT = 9001;
const WS_PORT = 9002; // Distinct from Vite dev port (3000) and TCP/UDP ports (9000/9001)

// Ask for custom username
const username = process.argv[2] || `User_${Math.floor(Math.random() * 1000)}`;
console.log(`Starting LocalLink Proxy for: ${username}`);

// 1. Initialize Network Layers (Aritra's Module)
const transport = new TransportManager(TCP_PORT);
const discovery = new PeerDiscovery(username, TCP_PORT, UDP_PORT);

// 2. Initialize WebSocket Server (Abhinav's Interface)
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`[Proxy] WebSocket Server listening on ws://localhost:${WS_PORT}`);
});

// State Management
const activePeers = new Map(); // ip -> { socket, sessionKey, msgBuffer, sessionId, localKeyPair }
const activeTransfers = new Map(); // transferId -> ip
let activeWsClient = null; // Single active frontend WebSocket connection

// Connect Aritra's UDP to Abhinav's Frontend
discovery.on('peerFound', (peerInfo) => {
  // Normalize the IP in case UDP discovery returned an IPv6-mapped address
  const ip = peerInfo.ip;
  console.log(`[Proxy] Found peer: ${peerInfo.username} at ${ip}:${peerInfo.tcpPort}`);
  
  // Notify frontend
  broadcastWS({
    type: 'PEER_ANNOUNCE',
    peer: {
      id: ip,
      ip: ip,
      name: peerInfo.username
    }
  });

  // Automatically attempt TCP connection
  if (!activePeers.has(ip)) {
    transport.connectToPeer(ip, peerInfo.tcpPort);
  }
});

discovery.on('peerOffline', (ip) => {
  console.log(`[Proxy] Peer ${ip} offline (TTL expired)`);
  broadcastWS({ type: 'PEER_OFFLINE', peerId: ip });
});

// Connect Aritra's TCP to Arnav's Protocol and Shobit's Crypto
transport.on('connection', ({ ip, socket, isOutbound }) => {
  console.log(`[Proxy] TCP Connected to ${ip}`);
  
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
  // Immediately re-announce all peers that have COMPLETED the ECDH handshake (sessionKey set).
  // Using activePeers (not discovery.peers) as the source of truth so we never expose a peer
  // that is still mid-handshake and can't receive messages yet.
  for (const [ip, peerState] of activePeers.entries()) {
    if (!peerState.sessionKey) continue; // skip peers still mid-handshake
    const discoveredInfo = discovery.peers.get(ip);
    ws.send(JSON.stringify({
      type: 'PEER_ANNOUNCE',
      peer: {
        id: ip,
        ip: ip,
        name: peerState.name || discoveredInfo?.username || ip
      }
    }));
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
        const { to, text } = msg; // Frontend sends 'to', not 'targetIp'
        const peerState = activePeers.get(to);
        
        if (peerState && peerState.sessionKey) {
          const encryptedPayload = encryptMessage(peerState.sessionKey, Buffer.from(text));
          const packet = MessageBuilder.build(
            OPCODES.CHAT_MESSAGE,
            Math.floor(Date.now() / 1000) % 4294967295, // fit into 32-bit unsigned int
            peerState.sessionId, // Arnav's Fix: Use actual session ID!
            encryptedPayload
          );
          peerState.socket.write(packet);
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
  // Only send to the single active frontend client.
  // Using wss.clients would hit zombie connections and cause duplicate messages.
  if (activeWsClient && activeWsClient.readyState === WebSocket.OPEN) {
    activeWsClient.send(JSON.stringify(data));
  }
}

// Start everything
transport.startServer().then(() => {
  console.log(`[Proxy] TCP Server listening on 0.0.0.0:${TCP_PORT}`);
  discovery.start();
  console.log(`[Proxy] UDP Discovery broadcasting on port ${UDP_PORT}`);
}).catch(console.error);
