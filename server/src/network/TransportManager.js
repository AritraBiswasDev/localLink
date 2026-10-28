const net = require('net');
const { EventEmitter } = require('events');

/**
 * Strips IPv6-mapped IPv4 prefix (::ffff:x.x.x.x -> x.x.x.x)
 * This prevents keys in activePeers from mismatching between
 * outbound (pure IPv4) and inbound (IPv6-mapped) connections.
 */
function normalizeIp(ip) {
  if (!ip) return ip;
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

class TransportManager extends EventEmitter {
  constructor(port = 9000) {
    super();
    this.port = port;
    this.server = null;
    this.activeSockets = new Map(); // ip -> net.Socket
    this.pendingSockets = new Map(); // ip -> net.Socket
  }

  startServer() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this._handleNewSocket(socket);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      // Bind strictly to 0.0.0.0 to listen on the LAN
      this.server.listen(this.port, '0.0.0.0', () => {
        resolve(this.port);
      });
    });
  }

  connectToPeer(ip, port) {
    const normIp = normalizeIp(ip);
    if (this.activeSockets.has(normIp)) {
      return this.activeSockets.get(normIp);
    }
    if (this.pendingSockets.has(normIp)) {
      return this.pendingSockets.get(normIp);
    }

    const socket = new net.Socket();
    this.pendingSockets.set(normIp, socket);

    // Pre-connection error handler: covers the window between socket creation and
    // successful connect. Removed once connected so only _handleNewSocket's handler
    // remains — avoiding a double-fire of _cleanupSocket on post-connection errors.
    const preConnectError = (err) => {
      console.error(`TCP connection error to ${normIp}:`, err.message);
      this.pendingSockets.delete(normIp);
      this.emit('connectError', { ip: normIp, error: err.message });
      socket.destroy();
    };
    socket.once('error', preConnectError);

    socket.connect(port, normIp, () => {
      this.pendingSockets.delete(normIp);
      // Hand off to _handleNewSocket which registers its own error/close listeners.
      socket.removeListener('error', preConnectError);
      this._handleNewSocket(socket, normIp);
    });

    return socket;
  }

  _handleNewSocket(socket, knownIp = null) {
    // Disable Nagle's algorithm for real-time responsiveness
    socket.setNoDelay(true);

    // Keep-alives detect silently dead connections without a hard timeout.
    socket.setKeepAlive(true, 5000);

    const ip = normalizeIp(knownIp || socket.remoteAddress);
    this.pendingSockets.delete(ip);

    // If an existing socket already exists for this IP, close and clean it up cleanly
    if (this.activeSockets.has(ip)) {
      const oldSocket = this.activeSockets.get(ip);
      if (oldSocket && oldSocket !== socket) {
        console.log(`[TransportManager] Replacing duplicate active TCP socket for ${ip}`);
        oldSocket.removeAllListeners();
        oldSocket.destroy();
      }
    }

    this.activeSockets.set(ip, socket);

    socket.on('data', (data) => {
      // Pass the raw byte stream up to Arnav's MessageBuffer
      this.emit('data', { ip, data });
    });

    socket.on('error', (err) => {
      console.error(`Socket error from ${ip}:`, err.message);
      this._cleanupSocket(ip, socket);
    });

    socket.on('close', () => {
      this._cleanupSocket(ip, socket);
    });

    this.emit('connection', { ip, socket, isOutbound: knownIp !== null });
  }

  _cleanupSocket(ip, closingSocket) {
    if (this.activeSockets.has(ip)) {
      const currentSocket = this.activeSockets.get(ip);
      // Only clean up if the socket closing is actually the active one
      if (closingSocket && currentSocket !== closingSocket) {
        return; // It's an old/duplicate socket closing, ignore
      }
      
      if (!currentSocket.destroyed) {
        currentSocket.destroy();
      }
      this.activeSockets.delete(ip);
      this.emit('disconnected', ip);
    }
  }

  stopServer() {
    if (this.server) {
      this.server.close();
    }
    for (const [ip, socket] of this.activeSockets.entries()) {
      this._cleanupSocket(ip);
    }
  }
}

module.exports = TransportManager;
