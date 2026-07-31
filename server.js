const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'financeos.db');
const db = new sqlite3.Database(dbPath);

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

initDb().catch(err => {
  console.error('Error initializing database:', err);
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM accounts WHERE id = ?', [id]);
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM goals WHERE id = ?', [id]);
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

    res.json({ success: true, message: 'Backup restored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`FinanceOS Server running on http://localhost:${PORT}`);
});
