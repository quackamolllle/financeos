const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

const { put, list } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'financeos.db');
const db = new sqlite3.Database(dbPath);

// Vercel Blob Persistence & Sync Helpers
let lastBlobSyncTime = 0;

const downloadDbFromBlob = async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const blobs = await list({ prefix: 'financeos.db' });
    if (blobs && blobs.blobs && blobs.blobs.length > 0) {
      const latestBlob = blobs.blobs[0];
      const blobTime = new Date(latestBlob.uploadedAt).getTime();
      
      if (blobTime > lastBlobSyncTime || !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
        const res = await fetch(latestBlob.url);
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          fs.writeFileSync(dbPath, Buffer.from(arrayBuf));
          lastBlobSyncTime = blobTime;
        }
      }
    }
  } catch (err) {
    console.error('[Cloud Sync Error] Download failed:', err.message);
  }
};

const uploadDbToBlob = async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      const fileData = fs.readFileSync(dbPath);
      await put('financeos.db', fileData, {
        access: 'public',
        addRandomSuffix: false,
      });
      lastBlobSyncTime = Date.now();
    }
  } catch (err) {
    console.error('[Cloud Sync Error] Upload failed:', err.message);
  }
};

const afterMutation = () => {
  uploadDbToBlob().catch(err => console.error('[Sync Error]', err.message));
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
  const session = await dbGet('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, Date.now()]);
  return !!session;
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper for DB queries using Promises
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
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

  if (process.env.APP_PIN) {
    const existing = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    if (!existing) {
      const hashed = hashPin(process.env.APP_PIN);
      await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);
    }
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

  // Migration: add notes column if missing (existing databases)
  try {
    await dbRun(`ALTER TABLE snapshots ADD COLUMN notes TEXT DEFAULT ''`);
  } catch (e) {
    // Column already exists, ignore
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target REAL NOT NULL
    )
  `);

  // Check if seeding is required for accounts
  const accCountRow = await dbGet('SELECT COUNT(*) AS count FROM accounts');
  if (accCountRow && accCountRow.count === 0) {
    console.log('Seeding database...');
    
    // Seed Accounts
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

    // Seed Initial Snapshot
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

const dbInitPromise = initDb().catch(err => {
  console.error('Error initializing database:', err);
});

app.use(async (req, res, next) => {
  await dbInitPromise;
  if (req.path.startsWith('/api')) {
    await downloadDbFromBlob();
  }
  next();
});

// --- AUTHENTICATION & SECURITY ENDPOINTS ---

app.get('/api/auth/status', async (req, res) => {
  try {
    const pinRow = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    const pinSet = !!pinRow;
    if (!pinSet) {
      return res.json({ pinSet: false, authenticated: false });
    }
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
    const existing = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    if (existing) {
      return res.status(400).json({ error: 'PIN is already set. Use change PIN instead.' });
    }
    const hashed = hashPin(pin);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    await dbRun('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)', [token, now, expiresAt]);

    afterMutation();

    const maxAgeSec = 30 * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `financeos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin, remember } = req.body;
    if (!pin) {
      return res.status(400).json({ error: 'PIN is required.' });
    }
    const pinRow = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
    if (!pinRow) {
      return res.status(400).json({ error: 'No PIN configured yet.' });
    }

    const isValid = verifyPin(pin, pinRow.value);
    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect Security PIN.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const days = remember !== false ? 30 : 1;
    const expiresAt = now + days * 24 * 60 * 60 * 1000;
    await dbRun('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)', [token, now, expiresAt]);

    const maxAgeSec = days * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `financeos_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
    afterMutation();
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
      afterMutation();
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
    if (!pinRow || !verifyPin(currentPin, pinRow.value)) {
      return res.status(400).json({ error: 'Current PIN is incorrect.' });
    }

    const hashed = hashPin(newPin);
    await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)", [hashed]);
    afterMutation();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Middleware enforcing PIN authentication on all data API routes
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path.startsWith('/api/auth')) return next();

  const pinRow = await dbGet("SELECT value FROM settings WHERE key = 'pin_hash'");
  if (!pinRow) {
    return res.status(401).json({ error: 'PIN setup required', code: 'PIN_SETUP_REQUIRED' });
  }

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
    afterMutation();
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
    afterMutation();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM accounts WHERE id = ?', [id]);
    afterMutation();
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
    afterMutation();
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
    afterMutation();
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
    afterMutation();
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
    afterMutation();
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
    afterMutation();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM goals WHERE id = ?', [id]);
    afterMutation();
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

    afterMutation();
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
