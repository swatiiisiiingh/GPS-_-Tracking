require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const cors         = require('cors');
const http         = require('http');
const socketIo     = require('socket.io');
const path         = require('path');
const os           = require('os');
const QRCode       = require('qrcode');
const fs           = require('fs');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');

const app    = express();
const server = http.createServer(app);

// Enable Socket.IO CORS to accept connections from separate frontend server
const io     = socketIo(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Enable CORS for Express API endpoints
app.use(cors({
  origin: true,
  credentials: true
}));

// ─── Security: HTTP headers ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled — Google Maps inline scripts need it off
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ─── Security: Rate limiting ───────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute window
  max: 120,                // max 120 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' }
});
app.use('/api/', apiLimiter);

// ─── Basic Auth — Dashboard & API protection ──────────────────────────────────
// Protects: /  (dashboard), /api/* (data APIs)
// Public:   /tracker.html, /socket.io/, /style.css, /tracker-qr.png, /health, /api/config
const DASH_USER = process.env.DASHBOARD_USER || '';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';
const AUTH_ENABLED = DASH_USER.length > 0 && DASH_PASS.length > 0;

function basicAuth(req, res, next) {
  // Allow all OPTIONS requests (CORS preflight) without authentication
  if (req.method === 'OPTIONS') return next();
  if (!AUTH_ENABLED) return next(); // Auth not configured — allow all (dev mode)

  // Always allow these public paths (tracker device + health check)
  const pub = [
    '/health',
    '/tracker.html',
    '/style.css',
    '/tracker-qr.png',
    '/socket.io/',
    '/api/config',          // Google Maps key needed by tracker page
  ];
  if (pub.some(p => req.path === p || req.path.startsWith('/socket.io/'))) {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="NTPC Fleet Dashboard"');
    return res.status(401).send('Authentication required.');
  }

  const b64 = authHeader.slice(6);
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  // Constant-time comparison to prevent timing attacks
  const userOk = user.length === DASH_USER.length &&
    Buffer.from(user).equals(Buffer.from(DASH_USER));
  const passOk = pass.length === DASH_PASS.length &&
    Buffer.from(pass).equals(Buffer.from(DASH_PASS));

  if (userOk && passOk) return next();

  res.set('WWW-Authenticate', 'Basic realm="NTPC Fleet Dashboard"');
  return res.status(401).send('Invalid credentials.');
}

// Apply auth globally — the middleware checks path and allows public routes through
app.use(basicAuth);

// Initialize MS SQL Server if credentials exist
const sql = require('mssql');
const mssqlServer = process.env.MSSQL_SERVER;
const mssqlDatabase = process.env.MSSQL_DATABASE;
const mssqlUser = process.env.MSSQL_USER;
const mssqlPassword = process.env.MSSQL_PASSWORD;
const mssqlPort = parseInt(process.env.MSSQL_PORT) || 1433;
const mssqlEncrypt = process.env.MSSQL_ENCRYPT === 'true';
const mssqlTrustCert = process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true';

let mssqlPool = null;

async function initMSSQL() {
  if (!mssqlServer || !mssqlDatabase || !mssqlUser || !mssqlPassword) {
    console.log('   MS SQL Server credentials missing. Persistent data will fall back to SQLite.');
    return;
  }

  const mssqlConfig = {
    user: mssqlUser,
    password: mssqlPassword,
    server: mssqlServer,
    database: mssqlDatabase,
    port: mssqlPort,
    options: {
      encrypt: mssqlEncrypt,
      trustServerCertificate: mssqlTrustCert
    }
  };

  try {
    mssqlPool = await sql.connect(mssqlConfig);
    console.log('   MS SQL Server client connected successfully!');

    // Initialize tables in MS SQL Server if they don't exist
    await mssqlPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='devices' AND xtype='U')
      CREATE TABLE devices (
        id         VARCHAR(100) PRIMARY KEY,
        name       VARCHAR(255),
        os         VARCHAR(100),
        first_seen BIGINT NOT NULL,
        last_seen  BIGINT NOT NULL
      );

      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='location_history' AND xtype='U')
      CREATE TABLE location_history (
        id        INT IDENTITY(1,1) PRIMARY KEY,
        device_id VARCHAR(100) NOT NULL,
        lat       FLOAT NOT NULL,
        lng       FLOAT NOT NULL,
        speed     FLOAT DEFAULT 0,
        heading   FLOAT,
        altitude  FLOAT,
        accuracy  FLOAT,
        timestamp BIGINT NOT NULL,
        nearest_landmark NVARCHAR(255)
      );

      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('location_history') AND name = 'nearest_landmark')
      ALTER TABLE location_history ADD nearest_landmark NVARCHAR(255);

      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='alerts_log' AND xtype='U')
      CREATE TABLE alerts_log (
        id          VARCHAR(100) PRIMARY KEY,
        type        VARCHAR(100) NOT NULL,
        device_id   VARCHAR(100),
        device_name VARCHAR(255),
        message     NVARCHAR(MAX) NOT NULL,
        severity    VARCHAR(50) DEFAULT 'info',
        timestamp   BIGINT NOT NULL
      );

      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_mssql_loc_dev_ts' AND object_id = OBJECT_ID('location_history'))
      CREATE INDEX idx_mssql_loc_dev_ts ON location_history (device_id, timestamp DESC);

      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_mssql_loc_ts' AND object_id = OBJECT_ID('location_history'))
      CREATE INDEX idx_mssql_loc_ts ON location_history (timestamp DESC);

      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_mssql_alert_ts' AND object_id = OBJECT_ID('alerts_log'))
      CREATE INDEX idx_mssql_alert_ts ON alerts_log (timestamp DESC);
    `);
    console.log('   MS SQL Server tables checked/created successfully!');
  } catch (err) {
    console.error('   Failed to connect/initialize MS SQL Server:', err.message);
    mssqlPool = null;
  }
}

const PORT             = process.env.PORT || 3000;
const SERVER_PUBLIC_URL = (process.env.SERVER_PUBLIC_URL || '').replace(/\/$/, '');
const TRACKER_URL       = SERVER_PUBLIC_URL ? `${SERVER_PUBLIC_URL}/tracker.html` : null;
const RETENTION_DAYS    = parseInt(process.env.HISTORY_RETENTION_DAYS) || 90;

// ─── Data / DB paths ──────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'gps_history.db');

// ─── SQLite Database ──────────────────────────────────────────────────────────
let db = null;
let stmtUpsertDevice, stmtInsertLocation, stmtInsertAlert;
const lastDbSaved = {};   // deviceId → { lat, lng, ts } — used for deduplication

function initDatabase() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);

    // WAL mode = much faster writes, safe concurrent reads
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous  = NORMAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id         TEXT PRIMARY KEY,
        name       TEXT,
        os         TEXT,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS location_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT    NOT NULL,
        lat       REAL    NOT NULL,
        lng       REAL    NOT NULL,
        speed     REAL    DEFAULT 0,
        heading   REAL,
        altitude  REAL,
        accuracy  REAL,
        timestamp INTEGER NOT NULL,
        nearest_landmark TEXT
      );

      CREATE TABLE IF NOT EXISTS alerts_log (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        device_id   TEXT,
        device_name TEXT,
        message     TEXT NOT NULL,
        severity    TEXT DEFAULT 'info',
        timestamp   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_loc_dev_ts ON location_history (device_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_loc_ts     ON location_history (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_ts   ON alerts_log (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_dev  ON alerts_log (device_id, timestamp DESC);
    `);

    // Ensure nearest_landmark column exists in SQLite location_history
    try {
      db.exec("ALTER TABLE location_history ADD COLUMN nearest_landmark TEXT");
    } catch (e) {
      // Column probably already exists, ignore
    }

    stmtUpsertDevice = db.prepare(`
      INSERT INTO devices (id, name, os, first_seen, last_seen)
      VALUES (@id, @name, @os, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        os   = excluded.os,
        last_seen = excluded.last_seen
    `);

    stmtInsertLocation = db.prepare(`
      INSERT INTO location_history
        (device_id, lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark)
      VALUES
        (@device_id, @lat, @lng, @speed, @heading, @altitude, @accuracy, @timestamp, @nearest_landmark)
    `);

    stmtInsertAlert = db.prepare(`
      INSERT OR IGNORE INTO alerts_log
        (id, type, device_id, device_name, message, severity, timestamp)
      VALUES
        (@id, @type, @device_id, @device_name, @message, @severity, @timestamp)
    `);

    console.log(`   Database ready  →  ${DB_PATH}`);
    return true;
  } catch (err) {
    db = null;
    console.warn(`\n   ⚠  SQLite unavailable: ${err.message}`);
    console.warn(`   Running in memory-only mode — history will NOT persist.`);
    console.warn(`   Fix: run  npm install  then restart the server.\n`);
    return false;
  }
}

// ─── Daily cleanup — remove records older than RETENTION_DAYS ─────────────────
async function runCleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  if (mssqlPool) {
    try {
      await mssqlPool.request()
        .input('cutoff', sql.BigInt, cutoff)
        .query('DELETE FROM location_history WHERE timestamp < @cutoff');
    } catch (e) { console.error('[MSSQL DB Cleanup]', e.message); }
  }
  if (db) {
    try {
      const r = db.prepare('DELETE FROM location_history WHERE timestamp < ?').run(cutoff);
      if (r.changes > 0)
        console.log(`[DB] Cleanup: removed ${r.changes} records older than ${RETENTION_DAYS} days.`);
    } catch (e) { console.error('[DB Cleanup]', e.message); }
  }
}

// ─── Static file serving ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));
app.use(express.json({ limit: '1mb' }));

// ─── In-memory fleet state ────────────────────────────────────────────────────
let fleet        = {};
let alertHistory = [];
const socketToDevice = {};
const geofenceState  = {};
const MAX_ALERTS = 100;

// ─── NTPC-MUNPL coordinates ───────────────────────────────────────────────────
const PLANT_CENTER    = { lat: 25.1453, lng: 81.9435 };
const GEOFENCE_RADIUS = 1500; // metres

// ─── Network helpers ──────────────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address;
        const parts = ip.split('.').map(Number);
        if (parts.length === 4) {
          // Check if it matches private LAN IP subnets:
          // 192.168.x.x
          // 10.x.x.x
          // 172.16.x.x to 172.31.x.x
          const isPrivate = 
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 10) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
          
          if (isPrivate) {
            // Prioritize Wi-Fi/Ethernet ranges, penalizing virtual adapters like VirtualBox (commonly 192.168.56.x)
            if (parts[0] === 192 && parts[1] === 168 && parts[2] === 56) {
              candidates.push({ ip, priority: 1 }); // low priority for virtual adapters
            } else {
              candidates.push({ ip, priority: 3 }); // high priority for active local LAN
            }
          } else {
            candidates.push({ ip, priority: 2 }); // medium priority for public WAN IPs
          }
        }
      }
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0].ip;
  }
  return 'localhost';
}

// ─── Generate static QR PNG on startup ───────────────────────────────────────
async function generateStaticQR() {
  const url     = TRACKER_URL || `http://${getLocalIP()}:${PORT}/tracker.html`;
  const outPath = path.join(__dirname, 'public', 'tracker-qr.png');
  try {
    await QRCode.toFile(outPath, url, {
      width: 400, margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    console.log(`   QR Code saved  →  ${outPath}`);
    console.log(`   QR encodes URL →  ${url}`);
  } catch (err) {
    console.error('QR generation failed:', err.message);
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).send('OK'));

// ─── Config ───────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  let apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'YOUR_GOOGLE_MAPS_API_KEY') apiKey = '';
  res.json({ googleMapsApiKey: apiKey });
});

// ─── Server info ──────────────────────────────────────────────────────────────
app.get('/api/server-info', (req, res) => {
  const localIP = getLocalIP();
  res.json({
    localIP, port: PORT,
    localTrackerUrl:  `http://${localIP}:${PORT}/tracker.html`,
    localDashUrl:     `http://${localIP}:${PORT}/`,
    publicTrackerUrl: TRACKER_URL,
    publicDashUrl:    SERVER_PUBLIC_URL || null,
    staticQrUrl:      TRACKER_URL ? '/tracker-qr.png' : null
  });
});

// ─── QR Code (generates dynamically) ───────────────────────────
app.get('/api/qr-code', async (req, res) => {
  let url = req.query.url;
  if (!url) {
    url = TRACKER_URL || `http://${getLocalIP()}:${PORT}/tracker.html`;
  }
  try {
    const buffer = await QRCode.toBuffer(url, {
      width: 400, margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('QR generation failed: ' + err.message);
  }
});

// ─── Live fleet endpoints ─────────────────────────────────────────────────────
app.get('/api/alerts',      (req, res) => res.json(alertHistory));
app.get('/api/fleet',       (req, res) => res.json(fleet));
app.get('/api/fleet-stats', (req, res) => {
  const ids = Object.keys(fleet);
  let moving = 0, idle = 0, offline = 0;
  for (const id of ids) {
    const t = fleet[id];
    if (!t.active) { offline++; continue; }
    if ((t.currentLocation?.speed || 0) > 2) moving++;
    else idle++;
  }
  res.json({
    total: ids.length, moving, idle, offline,
    insideGeofence:  ids.filter(id => fleet[id].isInsideGeofence).length,
    outsideGeofence: ids.filter(id => !fleet[id].isInsideGeofence && fleet[id].currentLocation).length,
    alertCount: alertHistory.length,
    geofenceRadiusM: GEOFENCE_RADIUS,
    plantCenter: PLANT_CENTER
  });
});

// ─── History: location records for a device + date range ─────────────────────
app.get('/api/history/:deviceId', async (req, res) => {
  if (!db && !mssqlPool) return res.status(503).json({ error: 'Database not available — running in memory-only mode.' });
  const { deviceId } = req.params;
  // Validate deviceId — alphanumeric, dashes, underscores only
  if (!/^[\w\-]{1,100}$/.test(deviceId)) return res.status(400).json({ error: 'Invalid deviceId.' });
  const from  = Math.max(0, parseInt(req.query.from) || (Date.now() - 86400000));
  const to    = Math.min(Date.now() + 60000, parseInt(req.query.to) || Date.now()); // no future dates beyond 1 min
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50000), 200000);

  try {
    let points = [];
    if (mssqlPool) {
      const result = await mssqlPool.request()
        .input('device_id', sql.VarChar, deviceId)
        .input('from', sql.BigInt, from)
        .input('to', sql.BigInt, to)
        .input('limit', sql.Int, limit)
        .query(`
          SELECT TOP (@limit) lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark
          FROM   location_history
          WHERE  device_id = @device_id AND timestamp BETWEEN @from AND @to
          ORDER  BY timestamp ASC
        `);
      points = result.recordset || [];
    } else {
      points = db.prepare(`
        SELECT lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark
        FROM   location_history
        WHERE  device_id = ? AND timestamp BETWEEN ? AND ?
        ORDER  BY timestamp ASC
        LIMIT  ?
      `).all(deviceId, from, to, limit);
    }

    let totalDist = 0, maxSpeed = 0;
    for (let i = 0; i < points.length; i++) {
      if ((points[i].speed || 0) > maxSpeed) maxSpeed = points[i].speed || 0;
      if (i > 0) totalDist += haversineKm(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
    }
    const durationMs = points.length > 1
      ? points[points.length - 1].timestamp - points[0].timestamp : 0;

    res.json({
      deviceId, from, to,
      count: points.length,
      points,
      stats: {
        totalDistanceKm: parseFloat(totalDist.toFixed(3)),
        maxSpeedKmh:     parseFloat(maxSpeed.toFixed(1)),
        durationMs,
        firstPoint: points[0]?.timestamp || null,
        lastPoint:  points[points.length - 1]?.timestamp || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── History export: GeoJSON or CSV ──────────────────────────────────────────
app.get('/api/history/:deviceId/export', async (req, res) => {
  if (!db && !mssqlPool) return res.status(503).json({ error: 'Database not available.' });
  const { deviceId } = req.params;
  if (!/^[\w\-]{1,100}$/.test(deviceId)) return res.status(400).json({ error: 'Invalid deviceId.' });
  const from   = Math.max(0, parseInt(req.query.from) || (Date.now() - 86400000));
  const to     = Math.min(Date.now() + 60000, parseInt(req.query.to) || Date.now());
  const format = ['geojson', 'csv'].includes((req.query.format || '').toLowerCase())
    ? req.query.format.toLowerCase() : 'geojson';

  try {
    let points = [];
    let deviceName = deviceId;

    if (mssqlPool) {
      const pointsResult = await mssqlPool.request()
        .input('device_id', sql.VarChar, deviceId)
        .input('from', sql.BigInt, from)
        .input('to', sql.BigInt, to)
        .query(`
          SELECT lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark
          FROM   location_history
          WHERE  device_id = @device_id AND timestamp BETWEEN @from AND @to
          ORDER  BY timestamp ASC
        `);
      points = pointsResult.recordset || [];

      const deviceResult = await mssqlPool.request()
        .input('device_id', sql.VarChar, deviceId)
        .query('SELECT name FROM devices WHERE id = @device_id');
      if (deviceResult.recordset[0]?.name) {
        deviceName = deviceResult.recordset[0].name;
      }
    } else {
      points = db.prepare(`
        SELECT lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark
        FROM   location_history
        WHERE  device_id = ? AND timestamp BETWEEN ? AND ?
        ORDER  BY timestamp ASC
      `).all(deviceId, from, to);

      const device = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId);
      if (device?.name) deviceName = device.name;
    }

    deviceName = deviceName.replace(/[^a-z0-9_\-]/gi, '_');

    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${deviceName}_history.csv"`);
      const lines = [
        'timestamp_ms,datetime_utc,lat,lng,nearest_landmark,speed_kmh,heading_deg,altitude_m,accuracy_m',
        ...points.map(p =>
          `${p.timestamp},${new Date(p.timestamp).toISOString()},${p.lat},${p.lng},"${(p.nearest_landmark || '').replace(/"/g, '""')}",${p.speed ?? 0},${p.heading ?? ''},${p.altitude ?? ''},${p.accuracy ?? ''}`
        )
      ];
      return res.send(lines.join('\n'));
    }

    // GeoJSON
    res.set('Content-Type', 'application/geo+json');
    res.set('Content-Disposition', `attachment; filename="${deviceName}_history.geojson"`);
    
    const features = [];
    
    // Add LineString feature
    features.push({
      type: 'Feature',
      properties: {
        deviceId, deviceName,
        from, to,
        pointCount:  points.length,
        exportedAt:  new Date().toISOString(),
        system:      'NTPC-MUNPL GPS Fleet Tracker',
        dataType:    'route_path'
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map(p => [p.lng, p.lat, p.altitude || 0])
      }
    });

    // Add Point features with landmark info
    points.forEach(p => {
      features.push({
        type: 'Feature',
        properties: {
          timestamp: p.timestamp,
          datetime: new Date(p.timestamp).toISOString(),
          speedKmh: p.speed ?? 0,
          heading: p.heading,
          altitude: p.altitude,
          accuracy: p.accuracy,
          nearestLandmark: p.nearest_landmark || ''
        },
        geometry: {
          type: 'Point',
          coordinates: [p.lng, p.lat, p.altitude || 0]
        }
      });
    });

    res.json({
      type: 'FeatureCollection',
      features
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── All registered devices with stats ───────────────────────────────────────
app.get('/api/devices', async (req, res) => {
  if (!db && !mssqlPool) return res.json([]);
  try {
    if (mssqlPool) {
      const result = await mssqlPool.request().query(`
        SELECT d.id, d.name, d.os, d.first_seen, d.last_seen,
               COUNT(l.id)          AS total_points,
               ROUND(MAX(l.speed),1) AS max_speed_kmh
        FROM   devices d
        LEFT JOIN location_history l ON d.id = l.device_id
        GROUP  BY d.id, d.name, d.os, d.first_seen, d.last_seen
        ORDER  BY d.last_seen DESC
      `);
      return res.json(result.recordset);
    } else {
      const rows = db.prepare(`
        SELECT d.id, d.name, d.os, d.first_seen, d.last_seen,
               COUNT(l.id)          AS total_points,
               ROUND(MAX(l.speed),1) AS max_speed_kmh
        FROM   devices d
        LEFT JOIN location_history l ON d.id = l.device_id
        GROUP  BY d.id
        ORDER  BY d.last_seen DESC
      `).all();
      return res.json(rows);
    }
  } catch (e) { res.json([]); }
});

// ─── Database statistics ──────────────────────────────────────────────────────
app.get('/api/db-stats', async (req, res) => {
  if (!db && !mssqlPool) return res.json({ available: false });
  try {
    if (mssqlPool) {
      const statsResult = await mssqlPool.request().query(`
        SELECT 
          (SELECT COUNT(*) FROM location_history) AS total_points,
          (SELECT COUNT(*) FROM devices) AS total_devices,
          (SELECT COUNT(*) FROM alerts_log) AS total_alerts,
          (SELECT MIN(timestamp) FROM location_history) AS oldest
      `);
      const row = statsResult.recordset[0] || {};
      return res.json({
        available: true,
        total_points: row.total_points || 0,
        total_devices: row.total_devices || 0,
        total_alerts: row.total_alerts || 0,
        oldest: row.oldest || null,
        size_bytes: 0
      });
    } else {
      const total_points  = db.prepare('SELECT COUNT(*) c FROM location_history').get().c;
      const total_devices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
      const total_alerts  = db.prepare('SELECT COUNT(*) c FROM alerts_log').get().c;
      const oldest        = db.prepare('SELECT MIN(timestamp) t FROM location_history').get().t;
      const size_bytes    = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
      return res.json({ available: true, total_points, total_devices, total_alerts, oldest, size_bytes });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Haversine ────────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const haversineM = (a, b, c, d) => haversineKm(a, b, c, d) * 1000;

// ─── Plant Landmarks for NTPC-MUNPL ──────────────────────────────────────────
const PLANT_LANDMARKS = [
  { name: 'Main Entrance Gate', lat: 25.1440, lng: 81.9405 },
  { name: 'Administrative Building', lat: 25.1448, lng: 81.9420 },
  { name: 'Stage-1 Power Block (Unit 1 & 2)', lat: 25.1462, lng: 81.9432 },
  { name: 'Coal Handling Plant (CHP)', lat: 25.1475, lng: 81.9440 },
  { name: 'Cooling Towers Area', lat: 25.1479, lng: 81.9455 },
  { name: 'Switchyard & Substation', lat: 25.1470, lng: 81.9468 },
  { name: 'Raw Water Reservoir', lat: 25.1455, lng: 81.9480 },
  { name: 'Ash Handling Plant (AHP)', lat: 25.1435, lng: 81.9470 },
  { name: 'Service Workshops', lat: 25.1431, lng: 81.9450 },
  { name: 'FGD System Area', lat: 25.1436, lng: 81.9432 },
  { name: 'DM Water Plant', lat: 25.1450, lng: 81.9440 }
];

function getNearestLandmark(lat, lng) {
  if (lat == null || lng == null) return '';
  let nearest = null;
  let minDistance = Infinity;

  // 1. Check distance to predefined plant landmarks
  for (const landmark of PLANT_LANDMARKS) {
    const distM = haversineM(lat, lng, landmark.lat, landmark.lng);
    if (distM < minDistance) {
      minDistance = distM;
      nearest = landmark;
    }
  }

  // 2. Format output
  if (nearest && minDistance <= 1500) {
    return `Near ${nearest.name} (~${Math.round(minDistance)}m)`;
  }

  // 3. Fallback: distance from Plant Center
  const distCenterKm = haversineKm(lat, lng, PLANT_CENTER.lat, PLANT_CENTER.lng);
  return `Outside Plant (~${distCenterKm.toFixed(2)}km from Plant Centre)`;
}

// ─── Alert system ─────────────────────────────────────────────────────────────
function pushAlert(type, deviceId, deviceName, message, severity = 'info') {
  const alert = {
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    type, deviceId, deviceName, message, severity,
    timestamp: Date.now()
  };
  alertHistory.unshift(alert);
  if (alertHistory.length > MAX_ALERTS) alertHistory.pop();
  io.emit('new_alert', alert);
  console.log(`[${severity.toUpperCase()}] ${message}`);

  // Persist to DB
  if (db && stmtInsertAlert) {
    try {
      stmtInsertAlert.run({
        id: alert.id, type: alert.type,
        device_id:   alert.deviceId,
        device_name: alert.deviceName,
        message:     alert.message,
        severity:    alert.severity,
        timestamp:   alert.timestamp
      });
    } catch (e) { /* non-critical */ }
  }

  if (mssqlPool) {
    mssqlPool.request()
      .input('id', sql.VarChar, alert.id)
      .input('type', sql.VarChar, alert.type)
      .input('device_id', sql.VarChar, alert.deviceId)
      .input('device_name', sql.VarChar, alert.deviceName)
      .input('message', sql.NVarChar, alert.message)
      .input('severity', sql.VarChar, alert.severity)
      .input('timestamp', sql.BigInt, alert.timestamp)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM alerts_log WHERE id = @id)
        INSERT INTO alerts_log (id, type, device_id, device_name, message, severity, timestamp)
        VALUES (@id, @type, @device_id, @device_name, @message, @severity, @timestamp)
      `).catch(err => {
        console.error('[MSSQL Alert Insert Error]', err.message);
      });
  }

  return alert;
}

// ─── Geofence check ───────────────────────────────────────────────────────────
function checkGeofence(deviceId, tracker) {
  const loc = tracker.currentLocation;
  if (!loc) return;
  const distM   = haversineM(loc.lat, loc.lng, PLANT_CENTER.lat, PLANT_CENTER.lng);
  const isInside = distM <= GEOFENCE_RADIUS;
  tracker.geofenceDistanceM = Math.round(distM);
  tracker.isInsideGeofence  = isInside;
  const name = tracker.deviceInfo?.device || `Device-${deviceId.substring(0, 6)}`;
  if (geofenceState[deviceId] === undefined) { geofenceState[deviceId] = isInside; return; }
  if (isInside && !geofenceState[deviceId]) {
    geofenceState[deviceId] = true;
    pushAlert('geofence_restored', deviceId, name,
      `${name} re-entered the MUNPL plant boundary (${Math.round(distM)}m from centre).`, 'success');
  } else if (!isInside && geofenceState[deviceId]) {
    geofenceState[deviceId] = false;
    pushAlert('geofence_breach', deviceId, name,
      `⚠ BREACH: ${name} exited plant boundary — ${Math.round(distM)}m from centre!`, 'danger');
  }
}

// ─── Inactivity monitor ───────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let updated = false;
  for (const id in fleet) {
    const tracker = fleet[id];
    if (tracker.active && now - tracker.lastSeen > 30000) {
      tracker.active = false; updated = true;
      const name = tracker.deviceInfo?.device || id;
      pushAlert('signal_lost', id, name, `${name} signal lost — no data for 30+ seconds.`, 'warning');
    }
    if (now - tracker.lastSeen > 600000) {
      delete fleet[id];
      delete geofenceState[id];
      updated = true;
    }
  }
  if (updated) io.emit('dashboard_update', fleet);
}, 10000);

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Connection: ${socket.id}`);
  socket.emit('init_state', fleet);
  socket.emit('alert_history', alertHistory);

  socket.on('register_tracker', (deviceData) => {
    if (!deviceData?.id) return;
    const devId = deviceData.id;
    socketToDevice[socket.id] = devId;
    const name = deviceData.device || `Device-${devId.substring(0, 6)}`;

    if (!fleet[devId]) {
      fleet[devId] = {
        id: devId, active: true, deviceInfo: deviceData,
        currentLocation: null, routeHistory: [],
        totalDistance: 0, maxSpeed: 0,
        tripStartTime: Date.now(), lastSeen: Date.now(),
        geofenceDistanceM: null, isInsideGeofence: true
      };
      pushAlert('device_connected', devId, name,
        `${name} connected and transmitting live position.`, 'info');
    } else {
      Object.assign(fleet[devId], { active: true, deviceInfo: deviceData, lastSeen: Date.now() });
    }

    // Persist device registration
    if (db && stmtUpsertDevice) {
      try { stmtUpsertDevice.run({ id: devId, name, os: deviceData.os || null, now: Date.now() }); }
      catch (e) { /* non-critical */ }
    }

    if (mssqlPool) {
      const now = Date.now();
      mssqlPool.request()
        .input('id', sql.VarChar, devId)
        .input('name', sql.VarChar, name)
        .input('os', sql.VarChar, deviceData.os || null)
        .input('now', sql.BigInt, now)
        .query(`
          MERGE devices AS target
          USING (SELECT @id AS id) AS source
          ON (target.id = source.id)
          WHEN MATCHED THEN
            UPDATE SET name = @name, os = @os, last_seen = @now
          WHEN NOT MATCHED THEN
            INSERT (id, name, os, first_seen, last_seen)
            VALUES (@id, @name, @os, @now, @now);
        `).catch(err => {
          console.error('[MSSQL Device Upsert Error]', err.message);
        });
    }

    io.emit('device_status', { active: true, info: deviceData, id: devId });
    io.emit('dashboard_update', fleet);
  });

  socket.on('location_update', (data) => {
    if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
    const devId = data.deviceInfo?.id || socket.id;
    socketToDevice[socket.id] = devId;

    if (!fleet[devId]) {
      fleet[devId] = {
        id: devId, active: true,
        deviceInfo: data.deviceInfo || { id: devId, device: 'Transmitter', os: 'Unknown', battery: null },
        currentLocation: null, routeHistory: [],
        totalDistance: 0, maxSpeed: 0,
        tripStartTime: Date.now(), lastSeen: Date.now(),
        geofenceDistanceM: null, isInsideGeofence: true
      };
    }

    const tracker = fleet[devId];
    const prevLoc = tracker.currentLocation;
    tracker.active   = true;
    tracker.lastSeen = Date.now();
    const nearestLandmark = getNearestLandmark(data.lat, data.lng);
    tracker.currentLocation = {
      lat: data.lat, lng: data.lng,
      accuracy: data.accuracy || 0, speed: data.speed ?? 0,
      heading: data.heading ?? null, altitude: data.altitude ?? null,
      timestamp: data.timestamp || Date.now(),
      nearestLandmark: nearestLandmark
    };
    if (data.deviceInfo) tracker.deviceInfo = data.deviceInfo;
    if (tracker.currentLocation.speed > (tracker.maxSpeed || 0))
      tracker.maxSpeed = tracker.currentLocation.speed;

    let shouldAdd = true;
    if (prevLoc) {
      const dist = haversineKm(prevLoc.lat, prevLoc.lng, data.lat, data.lng);
      if (dist >= 0.002) { tracker.totalDistance += dist; }
      else {
        const last = tracker.routeHistory[tracker.routeHistory.length - 1];
        if (last && Date.now() - last.timestamp < 15000) shouldAdd = false;
      }
    }
    if (shouldAdd) {
      tracker.routeHistory.push({
        lat: data.lat, lng: data.lng,
        timestamp: data.timestamp || Date.now(),
        speed: data.speed || 0
      });
      if (tracker.routeHistory.length > 5000) tracker.routeHistory.shift();
    }

    // ── Persist to DB (smart deduplication) ───────────────────────────
    // Only save if: GPS accuracy is acceptable AND (moved ≥10 m OR ≥30 s elapsed)
    const acc = data.accuracy;
    if (acc == null || acc <= 100) {           // null means unknown (simulated), ≤100m is usable
      const last = lastDbSaved[devId];
      const ts   = data.timestamp || Date.now();
      const moved = last ? haversineM(last.lat, last.lng, data.lat, data.lng) >= 10 : true;
      const aged  = last ? (ts - last.ts) >= 30000 : true;
      if (moved || aged) {
        if (db && stmtInsertLocation) {
          try {
            stmtInsertLocation.run({
              device_id: devId,
              lat: data.lat, lng: data.lng,
              speed:    data.speed    || 0,
              heading:  data.heading  ?? null,
              altitude: data.altitude ?? null,
              accuracy: data.accuracy ?? null,
              timestamp: ts,
              nearest_landmark: nearestLandmark
            });
          } catch (e) { /* non-critical */ }
        }
        if (mssqlPool) {
          mssqlPool.request()
            .input('device_id', sql.VarChar, devId)
            .input('lat', sql.Float, data.lat)
            .input('lng', sql.Float, data.lng)
            .input('speed', sql.Float, data.speed || 0)
            .input('heading', sql.Float, data.heading ?? null)
            .input('altitude', sql.Float, data.altitude ?? null)
            .input('accuracy', sql.Float, data.accuracy ?? null)
            .input('timestamp', sql.BigInt, ts)
            .input('nearest_landmark', sql.NVarChar, nearestLandmark)
            .query(`
              INSERT INTO location_history (device_id, lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark)
              VALUES (@device_id, @lat, @lng, @speed, @heading, @altitude, @accuracy, @timestamp, @nearest_landmark)
            `).catch(err => {
              console.error('[MSSQL Location Insert Error]', err.message);
            });
        }
        lastDbSaved[devId] = { lat: data.lat, lng: data.lng, ts };
      }
    }

    checkGeofence(devId, tracker);
    io.emit('dashboard_update', fleet);
  });

  socket.on('reset_route', (deviceId) => {
    const resetOne = (id) => {
      if (!fleet[id]) return;
      const t = fleet[id];
      t.routeHistory = []; t.totalDistance = 0; t.maxSpeed = 0; t.tripStartTime = Date.now();
      if (t.currentLocation)
        t.routeHistory.push({ lat: t.currentLocation.lat, lng: t.currentLocation.lng, timestamp: Date.now(), speed: t.currentLocation.speed || 0 });
    };
    if (deviceId) resetOne(deviceId);
    else Object.keys(fleet).forEach(resetOne);
    io.emit('dashboard_update', fleet);
  });

  socket.on('disconnect', () => {
    const devId = socketToDevice[socket.id];
    console.log(`Disconnected: ${socket.id} (${devId ? fleet[devId]?.deviceInfo?.device || devId : 'dashboard client'})`);
    delete socketToDevice[socket.id];
  });
});

// ─── Restore persisted state from DB on startup ──────────────────────────────
async function restoreStateFromDB() {
  // Restore alert history (last 100 records)
  try {
    let rows = [];
    if (mssqlPool) {
      const result = await mssqlPool.request().query(
        'SELECT TOP 100 id, type, device_id AS deviceId, device_name AS deviceName, message, severity, timestamp FROM alerts_log ORDER BY timestamp DESC'
      );
      rows = result.recordset || [];
    } else if (db) {
      rows = db.prepare(
        'SELECT id, type, device_id AS deviceId, device_name AS deviceName, message, severity, timestamp FROM alerts_log ORDER BY timestamp DESC LIMIT 100'
      ).all();
    }
    if (rows.length > 0) {
      alertHistory = rows; // already sorted DESC by timestamp
      console.log(`   Restored ${rows.length} alerts from database.`);
    }
  } catch (e) { console.warn('   Could not restore alert history:', e.message); }

  // Restore last known position for each device
  try {
    let devices = [];
    if (mssqlPool) {
      const result = await mssqlPool.request().query(
        'SELECT id, name, os, first_seen, last_seen FROM devices ORDER BY last_seen DESC'
      );
      devices = result.recordset || [];
    } else if (db) {
      devices = db.prepare(
        'SELECT id, name, os, first_seen, last_seen FROM devices ORDER BY last_seen DESC'
      ).all();
    }

    for (const dev of devices) {
      let lastLoc = null;
      if (mssqlPool) {
        const r = await mssqlPool.request()
          .input('id', sql.VarChar, dev.id)
          .query('SELECT TOP 1 lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark FROM location_history WHERE device_id = @id ORDER BY timestamp DESC');
        lastLoc = r.recordset[0] || null;
      } else if (db) {
        lastLoc = db.prepare(
          'SELECT lat, lng, speed, heading, altitude, accuracy, timestamp, nearest_landmark FROM location_history WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1'
        ).get(dev.id);
      }

      fleet[dev.id] = {
        id: dev.id, active: false,
        deviceInfo: { id: dev.id, device: dev.name || dev.id, os: dev.os || 'Unknown', battery: null },
        currentLocation: lastLoc ? {
          lat: lastLoc.lat, lng: lastLoc.lng,
          speed: lastLoc.speed || 0, heading: lastLoc.heading || null,
          altitude: lastLoc.altitude || null, accuracy: lastLoc.accuracy || null,
          timestamp: lastLoc.timestamp,
          nearestLandmark: lastLoc.nearest_landmark || null
        } : null,
        routeHistory: lastLoc ? [{ lat: lastLoc.lat, lng: lastLoc.lng, timestamp: lastLoc.timestamp, speed: lastLoc.speed || 0 }] : [],
        totalDistance: 0, maxSpeed: 0,
        tripStartTime: Date.now(), lastSeen: dev.last_seen || Date.now(),
        geofenceDistanceM: null, isInsideGeofence: true
      };
      if (lastLoc) checkGeofence(dev.id, fleet[dev.id]);
    }
    if (devices.length > 0)
      console.log(`   Restored ${devices.length} device(s) last-known position from database.`);
  } catch (e) { console.warn('   Could not restore device positions:', e.message); }
}

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  const localIP = getLocalIP();
  const line    = '═'.repeat(60);

  // Init DB first so it's ready before printing URLs
  initDatabase();
  await initMSSQL();
  await restoreStateFromDB();
  await generateStaticQR();

  // Daily cleanup (run once now, then every 24 h)
  runCleanup();
  setInterval(runCleanup, 86400000);

  console.log(`\n${line}`);
  console.log(`   NTPC-MUNPL GPS TRACKING SYSTEM  ·  PORT ${PORT}`);
  console.log(line);
  console.log(`   Local Dashboard  →  http://localhost:${PORT}`);
  console.log(`   Local LAN        →  http://${localIP}:${PORT}`);
  if (TRACKER_URL) {
    console.log(`\n   ✅  PUBLIC SERVER CONFIGURED`);
    console.log(`   📱  TRACKER URL  →  ${TRACKER_URL}`);
    console.log(`   🖥️   DASHBOARD    →  ${SERVER_PUBLIC_URL}`);
    console.log(`   📄  QR IMAGE     →  ${SERVER_PUBLIC_URL}/tracker-qr.png`);
  } else {
    console.log(`\n   ⚠  SERVER_PUBLIC_URL not set in .env`);
    console.log(`   Tracker LAN URL  →  http://${localIP}:${PORT}/tracker.html`);
  }
  if (AUTH_ENABLED) {
    console.log(`\n   🔐  DASHBOARD AUTH ENABLED  (user: ${DASH_USER})`);
    console.log(`   📱  Tracker page is public — no login required for devices.`);
  } else {
    console.log(`\n   ⚠  DASHBOARD_USER / DASHBOARD_PASSWORD not set — dashboard is OPEN.`);
    console.log(`   Set these in .env to protect the fleet dashboard from public access.`);
  }
  console.log(line + '\n');
});

// ─── Clean shutdown ───────────────────────────────────────────────────────────
process.on('SIGINT',  () => { if (db) db.close(); process.exit(0); });
process.on('SIGTERM', () => { if (db) db.close(); process.exit(0); });
process.once('SIGUSR2', () => { if (db) db.close(); process.kill(process.pid, 'SIGUSR2'); });
