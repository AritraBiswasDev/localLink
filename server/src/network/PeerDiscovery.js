const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

/**
 * Calculates subnet broadcast addresses (e.g. 10.97.67.255) for all active
 * network interfaces to ensure Windows Wi-Fi / Hotspot broadcasts are not
 * dropped by the OS or restricted to loopback/default route.
 */
function getBroadcastAddresses() {
  const addresses = new Set(['255.255.255.255']);
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
          const ipParts = net.address.split('.').map(Number);
          const maskParts = net.netmask.split('.').map(Number);
          if (ipParts.length === 4 && maskParts.length === 4) {
            const bcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
            addresses.add(bcastParts.join('.'));
          }
        }
      }
    }
  } catch (e) {
    // Ignore error and fall back to 255.255.255.255
  }
  return Array.from(addresses);
}

class PeerDiscovery extends EventEmitter {
  constructor(username, tcpPort, udpPort = 9001) {
    super();
    this.username = username;
    this.tcpPort = tcpPort;
    this.udpPort = udpPort;
    // Unique identifier for this node — used to filter our own UDP broadcasts without
    // relying on username (which can collide) or TCP port (which can differ across NICs).
    this.nodeId = crypto.randomUUID();
    
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.peers = new Map(); // ip -> peerData
    this.broadcastInterval = null;
  }

  start() {
    this.socket.on('error', (err) => {
      console.error(`UDP Discovery Error:\n${err.stack}`);
      this.socket.close();
    });

    this.socket.on('message', (msg, rinfo) => {
      try {
        const peerInfo = JSON.parse(msg.toString());
        
        // Ignore ourselves: compare by nodeId instead of username+port.
        // Username-based filtering breaks when two peers share the same name (e.g. User_42).
        if (peerInfo.nodeId === this.nodeId) return;

        if (!this.peers.has(rinfo.address)) {
          this.peers.set(rinfo.address, { ...peerInfo, lastSeen: Date.now() });
          this.emit('peerFound', { ip: rinfo.address, ...peerInfo });
        } else {
          // Update last seen & notify if username was announced or changed
          const existing = this.peers.get(rinfo.address);
          existing.lastSeen = Date.now();
          if (peerInfo.username && existing.username !== peerInfo.username) {
            existing.username = peerInfo.username;
            this.emit('peerFound', { ip: rinfo.address, ...peerInfo });
          }
        }
      } catch (err) {
        // Ignore invalid broadcast messages
      }
    });

    this.socket.on('listening', () => {
      this.socket.setBroadcast(true);

      const sendBroadcast = () => {
        const payload = Buffer.from(JSON.stringify({
          username: this.username,
          tcpPort: this.tcpPort,
          nodeId: this.nodeId  // unique self-ID for loopback filtering
        }));

        // Send to 255.255.255.255 and all active subnet broadcast addresses (e.g. 10.97.67.255)
        const targets = getBroadcastAddresses();
        for (const target of targets) {
          this.socket.send(payload, 0, payload.length, this.udpPort, target, (err) => {
            // Silently ignore unreachable network routes on inactive adapters
          });
        }
      };

      // 1. Send immediate announcement as soon as backend turns on!
      sendBroadcast();
      
      // 2. Broadcast presence every 2 seconds
      this.broadcastInterval = setInterval(sendBroadcast, 2000);
      
      // Aritra's Fix: Sweep for offline peers every 5 seconds
      this.ttlInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, peer] of this.peers.entries()) {
          // If haven't seen for 15 seconds, assume they went offline
          if (now - peer.lastSeen > 15000) {
            this.peers.delete(ip);
            this.emit('peerOffline', ip);
          }
        }
      }, 5000);
    });

    this.socket.bind(this.udpPort);
  }

  stop() {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.ttlInterval) clearInterval(this.ttlInterval);
    try {
      this.socket.close();
    } catch(e) {}
  }
}

module.exports = PeerDiscovery;
