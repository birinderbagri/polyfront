// Polyfront relay server.
//
// One small process that does two jobs:
//   1. Serves the WebGL build (Builds/WebGL) so people can play in a browser.
//   2. Relays online matches over WebSockets at /relay. One player hosts (their game runs the match);
//      everyone else joins with a 5-letter room code. The relay only forwards bytes between them, so
//      web, Windows and Android players can all share a room.
//
// Usage:  npm install  &&  npm start           (http://localhost:8080)
// Env:    PORT (default 8080), WEB_ROOT (default ./public if present, else ../Builds/WebGL), MAX_ROOMS (default 500),
//         MAX_PLAYERS (default 150: about 0.8 of a CPU core and 6 GB/hour of traffic at full load)

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
// A deployed copy carries the web build in ./public; in the project it's the Unity build output.
const WEB_ROOT = path.resolve(__dirname, process.env.WEB_ROOT ||
  (fs.existsSync(path.join(__dirname, "public")) ? "public" : "../Builds/WebGL"));
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
// Past its capacity a relay lags every match, so it turns newcomers away instead.
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 150;
let playerCount = 0;
const FULL = "The server is full right now. Try again in a few minutes.";
const MAX_PEERS = 15;
const MAX_BINARY = 64 * 1024;
const MAX_TEXT = 4 * 1024;
const PROTOCOL_VERSION = 1;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EVERYONE = 0xffff;

// ---- Static files ---------------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(file) {
  // "WebGL.wasm.unityweb" / "WebGL.wasm.gz" -> type of the inner extension.
  let name = file;
  if (name.endsWith(".unityweb") || name.endsWith(".gz") || name.endsWith(".br")) name = name.replace(/\.(unityweb|gz|br)$/, "");
  return MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
}

function encodingFor(file, head) {
  if (file.endsWith(".br")) return "br";
  if (file.endsWith(".gz")) return "gzip";
  // Builds with "decompression fallback" use .unityweb; tell the browser when it is gzip so it
  // decompresses natively (faster). Brotli .unityweb can't be sniffed reliably, so it is left to the loader.
  if (file.endsWith(".unityweb") && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  return null;
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const file = path.join(WEB_ROOT, urlPath);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      const missingBuild = urlPath === "/index.html" && !fs.existsSync(WEB_ROOT);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(missingBuild ? `No web build found at ${WEB_ROOT}. Build it in Unity with ArenaFPS > Build > Web (WebGL).` : "Not found");
      return;
    }
    // Build files named by their content hash never change, so browsers may keep them. Everything else is
    // re-checked on each visit (a cheap 304 when unchanged), so an update never mixes old and new files.
    const hashed = /[0-9a-f]{32}/i.test(path.basename(file));
    const lastModified = stat.mtime.toUTCString();
    if (!hashed && req.headers["if-modified-since"] === lastModified) {
      res.writeHead(304, { "Cache-Control": "no-cache", "Last-Modified": lastModified });
      return res.end();
    }
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    const headers = {
      "Content-Type": contentTypeFor(file),
      "Content-Length": stat.size,
      "Last-Modified": lastModified,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    };
    const encoding = encodingFor(file, head);
    if (encoding) headers["Content-Encoding"] = encoding;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- Rooms ------------------------------------------------------------------------------------------

/** code -> { code, host, peers: Map<peerId, socket>, nextPeer, info, created } */
const rooms = new Map();

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function sendJson(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function cleanInfo(info, fallbackName) {
  info = info && typeof info === "object" ? info : {};
  const text = (v, max) => String(v == null ? "" : v).replace(/[<>]/g, "").slice(0, max);
  return {
    name: text(info.name || fallbackName, 40),
    map: text(info.map, 30),
    mode: text(info.mode, 30),
    players: Math.max(0, Math.min(64, Number(info.players) || 0)),
    max: Math.max(1, Math.min(64, Number(info.max) || 8)),
  };
}

function leaveRoom(socket) {
  const room = socket.room;
  if (!room) return;
  socket.room = null;
  if (socket.isHost) {
    rooms.delete(room.code);
    playerCount -= 1 + room.peers.size;
    for (const peer of room.peers.values()) {
      sendJson(peer, { type: "host-left" });
      peer.room = null;
      peer.close(4000, "The host left the match.");
    }
    console.log(`room ${room.code} closed (host left)`);
    return;
  }
  room.peers.delete(socket.peerId);
  playerCount--;
  sendJson(room.host, { type: "peer-left", peer: socket.peerId });
  console.log(`room ${room.code}: peer ${socket.peerId} left`);
}

function handleControl(socket, text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return sendJson(socket, { type: "error", message: "Malformed message." });
  }
  switch (m.type) {
    case "host": {
      if (socket.room) return sendJson(socket, { type: "error", message: "Already in a room." });
      if (m.version !== PROTOCOL_VERSION) return sendJson(socket, { type: "error", message: "Game version mismatch. Update your game." });
      if (rooms.size >= MAX_ROOMS || playerCount >= MAX_PLAYERS) return sendJson(socket, { type: "error", message: FULL });
      let code = typeof m.room === "string" ? m.room.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) : "";
      if (!code || rooms.has(code)) code = newCode();
      if (!code) return sendJson(socket, { type: "error", message: "Could not create a room." });
      const room = { code, host: socket, peers: new Map(), nextPeer: 1, info: cleanInfo(m.info, `${m.name || "Player"}'s match`), created: Date.now() };
      rooms.set(code, room);
      socket.room = room;
      socket.isHost = true;
      socket.peerId = 0;
      playerCount++;
      sendJson(socket, { type: "hosted", room: code, peer: 0 });
      console.log(`room ${code} opened by ${String(m.name || "?").slice(0, 16)}`);
      return;
    }
    case "join": {
      if (socket.room) return sendJson(socket, { type: "error", message: "Already in a room." });
      if (m.version !== PROTOCOL_VERSION) return sendJson(socket, { type: "error", message: "Game version mismatch. Update your game." });
      const code = String(m.room || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return sendJson(socket, { type: "error", message: `No match with code ${code}. Check the code with your host.` });
      if (room.peers.size >= MAX_PEERS) return sendJson(socket, { type: "error", message: "That match is full." });
      if (playerCount >= MAX_PLAYERS) return sendJson(socket, { type: "error", message: FULL });
      const peer = room.nextPeer++;
      room.peers.set(peer, socket);
      socket.room = room;
      socket.isHost = false;
      socket.peerId = peer;
      playerCount++;
      sendJson(socket, { type: "joined", room: code, peer });
      sendJson(room.host, { type: "peer-joined", peer });
      console.log(`room ${code}: peer ${peer} joined (${String(m.name || "?").slice(0, 16)})`);
      return;
    }
    case "list": {
      const list = [];
      for (const room of rooms.values()) {
        if (room.info.players >= room.info.max) continue;
        list.push({ room: room.code, ...room.info });
        if (list.length >= 50) break;
      }
      return sendJson(socket, { type: "rooms", rooms: list });
    }
    case "info": {
      if (socket.room && socket.isHost) socket.room.info = cleanInfo(m.info, socket.room.info.name);
      return;
    }
    case "kick": {
      if (!socket.room || !socket.isHost) return;
      const target = socket.room.peers.get(Number(m.peer));
      if (!target) return;
      sendJson(target, { type: "kicked", message: String(m.message || "Removed by the host.").slice(0, 200) });
      setTimeout(() => target.close(4001, "Removed by the host."), 200);
      return;
    }
    default:
      return sendJson(socket, { type: "error", message: "Unknown request." });
  }
}

function handleBinary(socket, data) {
  const room = socket.room;
  if (!room) return;
  if (socket.isHost) {
    // First two bytes: target peer (little endian), 0xFFFF = every client.
    if (data.length < 2) return;
    const target = data[0] | (data[1] << 8);
    const payload = data.subarray(2);
    if (target === EVERYONE) {
      for (const peer of room.peers.values()) if (peer.readyState === peer.OPEN) peer.send(payload);
    } else {
      const peer = room.peers.get(target);
      if (peer && peer.readyState === peer.OPEN) peer.send(payload);
    }
    return;
  }
  // From a client: prefix the sender's id and pass it to the host.
  if (room.host.readyState !== room.host.OPEN) return;
  const framed = Buffer.allocUnsafe(data.length + 2);
  framed[0] = socket.peerId & 0xff;
  framed[1] = (socket.peerId >> 8) & 0xff;
  data.copy(framed, 2);
  room.host.send(framed);
}

// ---- Server -----------------------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const cpu = process.cpuUsage();
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: playerCount, maxPlayers: MAX_PLAYERS, uptime: Math.round(process.uptime()), cpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(3) }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BINARY });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/relay") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.room = null;
  socket.on("pong", () => (socket.isAlive = true));
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      handleBinary(socket, data);
    } else {
      const text = data.toString();
      if (text.length <= MAX_TEXT) handleControl(socket, text);
    }
  });
  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

// Drop connections that stop answering pings (closed laptops, lost Wi-Fi).
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`Polyfront server on http://localhost:${PORT}  (relay: ws://localhost:${PORT}/relay)`);
  console.log(fs.existsSync(WEB_ROOT) ? `Serving the web build from ${WEB_ROOT}` : `No web build at ${WEB_ROOT} yet; relay only.`);
});
