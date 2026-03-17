"use strict";

const { Pool } = require("pg");
const fs   = require("fs");
const path = require("path");

// ── Connection ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ── Schema ────────────────────────────────────────────────────────────────────
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                       TEXT PRIMARY KEY,
        email                    TEXT UNIQUE NOT NULL,
        username                 TEXT UNIQUE NOT NULL,
        password_hash            TEXT NOT NULL,
        verified                 BOOLEAN DEFAULT FALSE,
        verify_token             TEXT,
        reset_token              TEXT,
        reset_expires            BIGINT,
        subscription_status      TEXT DEFAULT 'free',
        stripe_customer_id       TEXT,
        stripe_subscription_id   TEXT,
        subscription_activated_at BIGINT,
        created_at               BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS journal_entries (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seed         INTEGER NOT NULL,
        asset        TEXT,
        tf           TEXT,
        direction    TEXT,
        sl           TEXT,
        tp           TEXT,
        entry_price  DOUBLE PRECISION,
        score        INTEGER,
        result       TEXT,
        grade        TEXT,
        notes        TEXT DEFAULT '',
        created_at   BIGINT NOT NULL,
        UNIQUE(user_id, seed)
      );

      CREATE TABLE IF NOT EXISTS consensus_votes (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seed         INTEGER NOT NULL,
        direction    TEXT,
        sl           DOUBLE PRECISION,
        tp           DOUBLE PRECISION,
        score        INTEGER,
        result       TEXT,
        created_at   BIGINT NOT NULL,
        UNIQUE(user_id, seed)
      );

      CREATE TABLE IF NOT EXISTS practice_sessions (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        date_key     TEXT NOT NULL,
        count        INTEGER DEFAULT 1,
        UNIQUE(user_id, date_key)
      );
    `);
    console.log("[DB] Schema initialised.");
  } finally {
    client.release();
  }
}

// ── Migration: import users.json on first boot ────────────────────────────────
async function migrateFromJSON() {
  const usersFile = path.join(__dirname, "data", "users.json");
  if (!fs.existsSync(usersFile)) return;

  // Check if users table is empty
  const { rows } = await pool.query("SELECT COUNT(*) FROM users");
  if (parseInt(rows[0].count) > 0) return; // already have users, skip

  console.log("[DB] Migrating users from users.json...");
  const users = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  let migrated = 0;

  for (const [id, u] of Object.entries(users)) {
    try {
      await pool.query(
        `INSERT INTO users (id, email, username, password_hash, verified, verify_token,
         reset_token, reset_expires, subscription_status, stripe_customer_id,
         stripe_subscription_id, subscription_activated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id, u.email, u.username, u.passwordHash,
          u.verified || false, u.verifyToken || null,
          u.resetToken || null, u.resetExpires || null,
          u.subscription?.status || "free",
          u.subscription?.stripeCustomerId || null,
          u.subscription?.stripeSubscriptionId || null,
          u.subscription?.activatedAt || null,
          u.createdAt || Date.now(),
        ]
      );
      migrated++;
    } catch (e) {
      console.error(`[DB] Failed to migrate user ${id}:`, e.message);
    }
  }

  // Rename old file so it doesn't re-migrate
  fs.renameSync(usersFile, usersFile + ".migrated");
  console.log(`[DB] Migrated ${migrated} users. Old file renamed to users.json.migrated`);
}

// ── User helpers ──────────────────────────────────────────────────────────────

async function getUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  return rows[0] || null;
}

async function getUserByVerifyToken(token) {
  const { rows } = await pool.query("SELECT * FROM users WHERE verify_token = $1", [token]);
  return rows[0] || null;
}

async function getUserByResetToken(token) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE reset_token = $1 AND reset_expires > $2",
    [token, Date.now()]
  );
  return rows[0] || null;
}

async function getUserByStripeCustomer(customerId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE stripe_customer_id = $1", [customerId]);
  return rows[0] || null;
}

async function usernameExists(username, excludeId = null) {
  const q = excludeId
    ? "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id != $2 LIMIT 1"
    : "SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1";
  const params = excludeId ? [username, excludeId] : [username];
  const { rows } = await pool.query(q, params);
  return rows.length > 0;
}

async function createUser({ id, email, username, passwordHash, verifyToken }) {
  await pool.query(
    `INSERT INTO users (id, email, username, password_hash, verify_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, email.toLowerCase(), username, passwordHash, verifyToken, Date.now()]
  );
}

async function updateUser(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    vals.push(val);
    i++;
  }
  vals.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

async function deleteUser(id) {
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}

// ── Practice session helpers ──────────────────────────────────────────────────

async function getPracticeCount(userId, dateKey) {
  const { rows } = await pool.query(
    "SELECT count FROM practice_sessions WHERE user_id = $1 AND date_key = $2",
    [userId, dateKey]
  );
  return rows[0]?.count || 0;
}

async function incrementPractice(userId, dateKey) {
  await pool.query(
    `INSERT INTO practice_sessions (user_id, date_key, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, date_key) DO UPDATE SET count = practice_sessions.count + 1`,
    [userId, dateKey]
  );
}

// ── Journal helpers ───────────────────────────────────────────────────────────

async function getJournalEntries(userId) {
  const { rows } = await pool.query(
    `SELECT seed, asset, tf, direction, sl, tp, entry_price, score, result, grade, notes, created_at
     FROM journal_entries WHERE user_id = $1 ORDER BY seed DESC`,
    [userId]
  );
  return rows.map(r => ({
    seed: r.seed, asset: r.asset, tf: r.tf, direction: r.direction,
    sl: r.sl, tp: r.tp, entryPrice: r.entry_price,
    score: r.score, result: r.result, grade: r.grade,
    notes: r.notes, savedAt: r.created_at,
  }));
}

async function getJournalEntry(userId, seed) {
  const { rows } = await pool.query(
    "SELECT * FROM journal_entries WHERE user_id = $1 AND seed = $2",
    [userId, seed]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    seed: r.seed, asset: r.asset, tf: r.tf, direction: r.direction,
    sl: r.sl, tp: r.tp, entryPrice: r.entry_price,
    score: r.score, result: r.result, grade: r.grade,
    notes: r.notes, savedAt: r.created_at,
  };
}

async function upsertJournalEntry(userId, entry) {
  await pool.query(
    `INSERT INTO journal_entries (user_id, seed, asset, tf, direction, sl, tp, entry_price, score, result, grade, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, seed) DO UPDATE SET
       asset=$3, tf=$4, direction=$5, sl=$6, tp=$7, entry_price=$8,
       score=$9, result=$10, grade=$11, notes=$12, created_at=$13`,
    [userId, entry.seed, entry.asset, entry.tf, entry.direction,
     entry.sl, entry.tp, entry.entryPrice,
     entry.score, entry.result, entry.grade, entry.notes, Date.now()]
  );
}

// ── Consensus helpers ─────────────────────────────────────────────────────────

async function submitConsensus(userId, vote) {
  await pool.query(
    `INSERT INTO consensus_votes (user_id, seed, direction, sl, tp, score, result, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, seed) DO NOTHING`,
    [userId, vote.seed, vote.direction, vote.sl, vote.tp, vote.score, vote.result, Date.now()]
  );
}

async function getConsensusPool(seed) {
  const { rows } = await pool.query(
    "SELECT direction, sl, tp, score, result FROM consensus_votes WHERE seed = $1",
    [seed]
  );
  return rows;
}

async function hasVotedConsensus(userId, seed) {
  const { rows } = await pool.query(
    "SELECT 1 FROM consensus_votes WHERE user_id = $1 AND seed = $2 LIMIT 1",
    [userId, seed]
  );
  return rows.length > 0;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await initSchema();
  await migrateFromJSON();
}

module.exports = {
  pool, init,
  getUserById, getUserByEmail, getUserByVerifyToken, getUserByResetToken,
  getUserByStripeCustomer, usernameExists,
  createUser, updateUser, deleteUser,
  getPracticeCount, incrementPractice,
  getJournalEntries, getJournalEntry, upsertJournalEntry,
  submitConsensus, getConsensusPool, hasVotedConsensus,
};
