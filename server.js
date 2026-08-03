const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { put, list } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_PIN = process.env.APP_PIN || '0109';

// Ensure data directory exists
const dataDir = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'financeos.db');

let db = null;
let lastBlobSyncTime = 0;

const getDb = () => {
  if (!db) {
    db = new sqlite3.Database(dbPath);
  }
  return db;
};

let lastUploadError = null;
let lastDownloadError = null;
let lastBlobCheckTime = 0;

// Vercel Blob Persistence & Sync Helpers
const downloadDbFromBlob = async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const now = Date.now();
  if (now - lastBlobCheckTime < 2000 && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    return;
  }
  lastBlobCheckTime = now;

  try {
    lastDownloadError = null;
    const blobs = await list({ prefix: 'financeos.db' });
    if (blobs && blobs.blobs && blobs.blobs.length > 0) {
      const sortedBlobs = blobs.blobs.slice().sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
      const latestBlob = sortedBlobs[0];
      const blobTime = new Date(latestBlob.uploadedAt).getTime();
      
      if (blobTime > lastBlobSyncTime || !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
        const fetchUrl = latestBlob.downloadUrl || latestBlob.url;
        const headers = latestBlob.downloadUrl ? { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } : {};
        const res = await fetch(fetchUrl, { headers });
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          if (db) {
            try { db.close(); } catch (e) {}
            db = null;
          }
          fs.writeFileSync(dbPath, Buffer.from(arrayBuf));
          lastBlobSyncTime = blobTime;
          console.log('[Cloud Sync] Downloaded latest financeos.db from Vercel Blob:', fetchUrl);
        } else {
          lastDownloadError = `HTTP ${res.status}: ${res.statusText}`;
        }
      }
    }
  } catch (err) {
    lastDownloadError = err.message;
    console.error('[Cloud Sync Error] Download failed:', err.message);
  }
};

const uploadDbToBlob = async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    lastUploadError = null;
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      const fileData = fs.readFileSync(dbPath);
      let res;
      try {
        res = await put('financeos.db', fileData, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
      } catch (pubErr) {
        res = await put('financeos.db', fileData, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
      }
      lastBlobSyncTime = Date.now();
      console.log('[Cloud Sync] Uploaded financeos.db to Vercel Blob:', res.url);
    }
  } catch (err) {
    lastUploadError = err.message;
    console.error('[Cloud Sync Error] Upload failed:', err.message);
  }
};

const afterMutation = async () => {
  await uploadDbToBlob();
};

// Cookie & Security Helpers
const parseCookies = (req) => {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
  }
  return list;
};

const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => {
  const cleanPin = String(pin).trim();
  const hash = crypto.pbkdf2Sync(cleanPin, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
};

const verifyPin = (pin, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const cleanPin = String(pin).trim();
  const hash = crypto.pbkdf2Sync(cleanPin, salt, 10000, 64, 'sha512').toString('hex');
  const buf1 = Buffer.from(hash, 'utf-8');
  const buf2 = Buffer.from(originalHash, 'utf-8');
  if (buf1.length !== buf2.length) return false;
  return crypto.timingSafeEqual(buf1, buf2);
};

const SECRET = process.env.SESSION_SECRET || 'financeos_secret_key_2026';

const generateSessionToken = (days = 30) => {
  const expiresAt = Date.now() + (days * 24 * 60 * 60 * 1000);
  const signature = crypto.createHmac('sha256', SECRET).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
};

const validateSessionToken = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [expiresAtStr, signature] = token.split('.');
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false;
  const expectedSignature = crypto.createHmac('sha256', SECRET).update(String(expiresAtStr)).digest('hex');
  
  const buf1 = Buffer.from(signature, 'utf-8');
  const buf2 = Buffer.from(expectedSignature, 'utf-8');
  if (buf1.length !== buf2.length) return false;
  return crypto.timingSafeEqual(buf1, buf2);
};

const getSessionToken = (req) => {
  const cookies = parseCookies(req);
  if (cookies.financeos_session) return cookies.financeos_session;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return req.headers['x-session-token'];
};

const validateSession = async (req) => {
  const token = getSessionToken(req);
  if (!token) return false;
  if (validateSessionToken(token)) return true;
  try {
    const session = await dbGet('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, Date.now()]);
    return !!session;
  } catch (err) {
    return false;
  }
};

// Helper for DB queries using Promises
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Initialize Database Tables & Seed Data
const initDb = async () => {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  // Ensure security PIN is initialized with DEFAULT_PIN
  const existingPin = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
  if (!existingPin) {
    const hashed = hashPin(DEFAULT_PIN);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      costBasis REAL DEFAULT 0
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      income REAL DEFAULT 0,
      balances TEXT NOT NULL,
      notes TEXT DEFAULT ''
    )
  `);

  try {
    await dbRun(`ALTER TABLE snapshots ADD COLUMN notes TEXT DEFAULT ''`);
  } catch (e) {
    // Column already exists
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target REAL NOT NULL
    )
  `);

  // Check if seeding default demo accounts is required
  const accCountRow = await dbGet('SELECT COUNT(*) AS count FROM accounts');
  if (accCountRow && accCountRow.count === 0) {
    console.log('Seeding initial database...');
    
    const defaultAccounts = [
      { name: 'ActivoBank', type: 'Checking', costBasis: 0 },
      { name: 'Revolut', type: 'Spending', costBasis: 0 },
      { name: 'Vanguard FTSE All-World (Acc)', type: 'Investment', costBasis: 2312.50 },
      { name: 'nuclear', type: 'Investment', costBasis: 200.10 },
      { name: 'WisdomTree Core Physical Gold', type: 'Investment', costBasis: 187.50 },
      { name: 'Quantum', type: 'Investment', costBasis: 199.76 },
      { name: 'Airbus', type: 'Investment', costBasis: 100.00 },
      { name: 'Apple Spend & Invest', type: 'Investment', costBasis: 11.60 }
    ];

    const insertedAccounts = [];
    for (const acc of defaultAccounts) {
      const res = await dbRun(
        'INSERT INTO accounts (name, type, costBasis) VALUES (?, ?, ?)',
        [acc.name, acc.type, acc.costBasis]
      );
      insertedAccounts.push({ id: res.lastID, name: acc.name, type: acc.type, costBasis: acc.costBasis });
    }

    const balances = {};
    insertedAccounts.forEach(a => balances[a.id] = 0);

    const setBal = (name, val) => {
      const found = insertedAccounts.find(a => a.name === name);
      if (found) balances[found.id] = val;
    };

    setBal('Vanguard FTSE All-World (Acc)', 2287.85);
    setBal('nuclear', 191.26);
    setBal('WisdomTree Core Physical Gold', 171.22);
    setBal('Quantum', 153.34);
    setBal('Airbus', 115.01);
    setBal('Apple Spend & Invest', 12.39);

    const todayStr = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();

    await dbRun(
      'INSERT INTO snapshots (date, timestamp, income, balances) VALUES (?, ?, ?, ?)',
      [todayStr, timestamp, 0, JSON.stringify(balances)]
    );

    console.log('Database seeded successfully.');
  }
};

let dbInitPromise = null;
const ensureDbReady = async () => {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await downloadDbFromBlob();
      getDb();
      await initDb();
    })();
  }
  await dbInitPromise;
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
  try {
    if (req.path.startsWith('/api')) {
      await downloadDbFromBlob();
    }
    await ensureDbReady();
    next();
  } catch (err) {
    console.error('Failed to initialize database:', err);
    res.status(500).json({ error: 'Database initialization failure' });
  }
});

// --- DIAGNOSTIC / DEBUG ENDPOINT ---
app.get('/api/debug/sync', async (req, res) => {
  try {
    const hasToken = !!process.env.BLOB_READ_WRITE_TOKEN;
    let blobList = [];
    let blobError = null;

    if (hasToken) {
      try {
        const blobs = await list({ prefix: 'financeos.db' });
        blobList = (blobs && blobs.blobs) ? blobs.blobs.map(b => ({ url: b.url, uploadedAt: b.uploadedAt, pathname: b.pathname })) : [];
      } catch (err) {
        blobError = err.message;
      }
    }

    const accCount = await dbGet('SELECT COUNT(*) as count FROM accounts');
    const snapCount = await dbGet('SELECT COUNT(*) as count FROM snapshots');

    res.json({
      hasToken,
      blobCount: blobList.length,
      blobList,
      blobError,
      lastUploadError,
      lastDownloadError,
      accCount: accCount ? accCount.count : 0,
      snapCount: snapCount ? snapCount.count : 0,
      lastBlobSyncTime,
      dbSize: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTHENTICATION & SECURITY ENDPOINTS ---

app.get('/api/auth/status', async (req, res) => {
  try {
    const authenticated = await validateSession(req);
    res.json({ pinSet: true, authenticated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/setup-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || String(pin).trim().length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 characters long.' });
    }
    const hashed = hashPin(pin);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);

    const days = 30;
    const token = generateSessionToken(days);
    const maxAgeSec = days * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `financeos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
    await afterMutation();
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin, remember } = req.body;
    const cleanPin = String(pin || '').trim();
    if (!cleanPin) {
      return res.status(400).json({ error: 'PIN is required.' });
    }
    
    let pinRow = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    const isValid = (pinRow && verifyPin(cleanPin, pinRow.value)) || cleanPin === DEFAULT_PIN;

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect Security PIN.' });
    }

    // If logged in with DEFAULT_PIN, store hash in DB if missing
    if (!pinRow) {
      const hashed = hashPin(DEFAULT_PIN);
      await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);
    }

    const days = remember !== false ? 30 : 1;
    const token = generateSessionToken(days);
    const maxAgeSec = days * 24 * 60 * 60;

    res.setHeader('Set-Cookie', `financeos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
    await afterMutation();
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      await dbRun('DELETE FROM sessions WHERE token = ?', [token]);
      await afterMutation();
    }
    res.setHeader('Set-Cookie', 'financeos_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/change-pin', async (req, res) => {
  try {
    const isAuth = await validateSession(req);
    if (!isAuth) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const { currentPin, newPin } = req.body;
    if (!currentPin || !newPin || String(newPin).trim().length < 4) {
      return res.status(400).json({ error: 'New PIN must be at least 4 characters.' });
    }

    const pinRow = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    const isCurrentValid = (pinRow && verifyPin(currentPin, pinRow.value)) || currentPin === DEFAULT_PIN;
    if (!isCurrentValid) {
      return res.status(400).json({ error: 'Current PIN is incorrect.' });
    }

    const hashed = hashPin(newPin);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);
    await afterMutation();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Middleware enforcing PIN authentication on all data API routes
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/debug')) return next();

  const isAuth = await validateSession(req);
  if (!isAuth) {
    return res.status(401).json({ error: 'Unauthorized. PIN required.', code: 'PIN_REQUIRED' });
  }

  next();
});

// --- REST API ENDPOINTS ---

// ACCOUNTS ENDPOINTS
app.get('/api/accounts', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM accounts');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { name, type, costBasis } = req.body;
    const resRun = await dbRun(
      'INSERT INTO accounts (name, type, costBasis) VALUES (?, ?, ?)',
      [name, type, parseFloat(costBasis) || 0]
    );
    const newAcc = await dbGet('SELECT * FROM accounts WHERE id = ?', [resRun.lastID]);
    await afterMutation();
    res.status(201).json(newAcc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, costBasis } = req.body;
    
    const existing = await dbGet('SELECT * FROM accounts WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const updatedName = name !== undefined ? name : existing.name;
    const updatedType = type !== undefined ? type : existing.type;
    const updatedCostBasis = costBasis !== undefined ? parseFloat(costBasis) || 0 : existing.costBasis;

    await dbRun(
      'UPDATE accounts SET name = ?, type = ?, costBasis = ? WHERE id = ?',
      [updatedName, updatedType, updatedCostBasis, id]
    );

    const updated = await dbGet('SELECT * FROM accounts WHERE id = ?', [id]);
    await afterMutation();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM accounts WHERE id = ?', [id]);
    await afterMutation();
    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SNAPSHOTS ENDPOINTS
app.get('/api/snapshots', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM snapshots ORDER BY timestamp ASC');
    const snapshots = rows.map(r => ({
      ...r,
      balances: typeof r.balances === 'string' ? JSON.parse(r.balances) : (r.balances || {})
    }));
    res.json(snapshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/snapshots', async (req, res) => {
  try {
    const { date, timestamp, income, balances, notes } = req.body;
    const balancesStr = typeof balances === 'object' ? JSON.stringify(balances) : (balances || '{}');
    const ts = timestamp || new Date(date).getTime();
    
    const resRun = await dbRun(
      'INSERT INTO snapshots (date, timestamp, income, balances, notes) VALUES (?, ?, ?, ?, ?)',
      [date, ts, parseFloat(income) || 0, balancesStr, notes || '']
    );

    const newSnap = await dbGet('SELECT * FROM snapshots WHERE id = ?', [resRun.lastID]);
    await afterMutation();
    res.status(201).json({
      ...newSnap,
      balances: JSON.parse(newSnap.balances)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { date, timestamp, income, balances, notes } = req.body;

    const existing = await dbGet('SELECT * FROM snapshots WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    const updatedDate = date !== undefined ? date : existing.date;
    const updatedTs = timestamp !== undefined ? timestamp : (date ? new Date(date).getTime() : existing.timestamp);
    const updatedIncome = income !== undefined ? parseFloat(income) || 0 : existing.income;
    const updatedBalancesStr = balances !== undefined 
      ? (typeof balances === 'object' ? JSON.stringify(balances) : balances) 
      : existing.balances;
    const updatedNotes = notes !== undefined ? notes : (existing.notes || '');

    await dbRun(
      'UPDATE snapshots SET date = ?, timestamp = ?, income = ?, balances = ?, notes = ? WHERE id = ?',
      [updatedDate, updatedTs, updatedIncome, updatedBalancesStr, updatedNotes, id]
    );

    const updated = await dbGet('SELECT * FROM snapshots WHERE id = ?', [id]);
    await afterMutation();
    res.json({
      ...updated,
      balances: JSON.parse(updated.balances)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM snapshots WHERE id = ?', [id]);
    await afterMutation();
    res.json({ success: true, message: 'Snapshot deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GOALS ENDPOINTS
app.get('/api/goals', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM goals');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/goals', async (req, res) => {
  try {
    const { name, target } = req.body;
    const resRun = await dbRun(
      'INSERT INTO goals (name, target) VALUES (?, ?)',
      [name, parseFloat(target) || 0]
    );
    const newGoal = await dbGet('SELECT * FROM goals WHERE id = ?', [resRun.lastID]);
    await afterMutation();
    res.status(201).json(newGoal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/goals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, target } = req.body;

    const existing = await dbGet('SELECT * FROM goals WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    const updatedName = name !== undefined ? name : existing.name;
    const updatedTarget = target !== undefined ? parseFloat(target) || 0 : existing.target;

    await dbRun(
      'UPDATE goals SET name = ?, target = ? WHERE id = ?',
      [updatedName, updatedTarget, id]
    );

    const updated = await dbGet('SELECT * FROM goals WHERE id = ?', [id]);
    await afterMutation();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM goals WHERE id = ?', [id]);
    await afterMutation();
    res.json({ success: true, message: 'Goal deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RESTORE / BULK IMPORT ENDPOINT
app.post('/api/restore', async (req, res) => {
  try {
    const { accounts, snapshots, goals } = req.body;
    
    await dbRun('DELETE FROM accounts');
    await dbRun('DELETE FROM snapshots');
    await dbRun('DELETE FROM goals');

    if (Array.isArray(accounts)) {
      for (const acc of accounts) {
        await dbRun(
          'INSERT INTO accounts (id, name, type, costBasis) VALUES (?, ?, ?, ?)',
          [acc.id, acc.name, acc.type, parseFloat(acc.costBasis) || 0]
        );
      }
    }

    if (Array.isArray(snapshots)) {
      for (const snap of snapshots) {
        const balancesStr = typeof snap.balances === 'object' ? JSON.stringify(snap.balances) : (snap.balances || '{}');
        await dbRun(
          'INSERT INTO snapshots (id, date, timestamp, income, balances, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [snap.id, snap.date, snap.timestamp, parseFloat(snap.income) || 0, balancesStr, snap.notes || '']
        );
      }
    }

    if (Array.isArray(goals)) {
      for (const goal of goals) {
        await dbRun(
          'INSERT INTO goals (id, name, target) VALUES (?, ?, ?)',
          [goal.id, goal.name, parseFloat(goal.target) || 0]
        );
      }
    }

    await afterMutation();
    res.json({ success: true, message: 'Backup restored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FinanceOS Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
