"use strict";

const express    = require("express");
const cors       = require("cors");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const fs         = require("fs");
const path       = require("path");
const stripe     = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { Resend } = require("resend");
const db         = require("./db");

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Paths (charts stay as files — they're just cache) ─────────────────────────
const DATA_DIR     = path.join(__dirname, "data");
const DAILY_DIR    = path.join(DATA_DIR, "daily");
const PRACTICE_DIR = path.join(DATA_DIR, "practice");

[DATA_DIR, DAILY_DIR, PRACTICE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Daily reset version (survives within a single deploy) ─────────────────────
const RESET_FILE = path.join(DATA_DIR, "daily-reset.json");

function getResetVersion() {
  try {
    if (fs.existsSync(RESET_FILE)) {
      return JSON.parse(fs.readFileSync(RESET_FILE, "utf8")).version || 0;
    }
  } catch {}
  return 0;
}

function incrementResetVersion() {
  const next = getResetVersion() + 1;
  fs.writeFileSync(RESET_FILE, JSON.stringify({ version: next, lastReset: new Date().toISOString() }), "utf8");
  return next;
}

// ── Middleware ────────────────────────────────────────────────────────────────
// Stripe webhooks need raw body — must come before express.json()
app.post("/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  // Verify user still exists in DB (covers admin deletion, cleanup, etc.)
  db.getUserById(req.user.id).then(user => {
    if (!user) return res.status(401).json({ error: "Account no longer exists" });
    next();
  }).catch(() => res.status(500).json({ error: "Auth check failed" }));
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try { req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET); } catch {}
  }
  next();
}

// ── Player ID helper (logged-in user ID or anon cookie) ──────────────────────
function getPlayerId(req, res) {
  if (req.user) return req.user.id;
  // Parse anon cookie from header
  const cookies = (req.headers.cookie || "").split(";").reduce((acc, c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) acc[k] = v.join("=");
    return acc;
  }, {});
  if (cookies.chartle_anon) return "anon_" + cookies.chartle_anon;
  // Generate new anon ID and set cookie (1 year expiry)
  const anonId = uuid();
  res.cookie("chartle_anon", anonId, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" });
  return "anon_" + anonId;
}

// ── Today's date key ──────────────────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART ENDPOINTS (still file-based — charts are just cache)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/chart/daily
app.get("/api/chart/daily", optionalAuth, (req, res) => {
  const key  = todayKey();
  const file = path.join(DAILY_DIR, `${key}.json`);
  const resetVersion = getResetVersion();

  if (!fs.existsSync(file)) {
    const files = fs.readdirSync(DAILY_DIR)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) {
      return res.status(503).json({
        error: "No chart available yet. The daily chart is fetched at midnight. Try again soon.",
        synthetic: true,
      });
    }
    const latest = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, files[0]), "utf8"));
    return res.json({ ...latest, isFallback: true, resetVersion });
  }

  const chart = JSON.parse(fs.readFileSync(file, "utf8"));
  res.json({ ...chart, resetVersion });
});

// GET /api/chart/practice/:id
app.get("/api/chart/practice/:id", requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const isPaid   = user.subscription_status === "active";
  const FREE_MAX = parseInt(process.env.FREE_PRACTICE_PER_DAY || "3");

  if (!isPaid) {
    const today     = todayKey();
    const usedToday = await db.getPracticeCount(req.user.id, today);

    if (usedToday >= FREE_MAX) {
      return res.status(403).json({
        error: "daily_limit_reached",
        message: `Free accounts get ${FREE_MAX} practice charts per day. Upgrade to get unlimited access.`,
        used: usedToday,
        limit: FREE_MAX,
      });
    }

    await db.incrementPractice(req.user.id, today);
  }

  // Find the practice chart
  const id   = String(req.params.id).padStart(4, "0");
  const file = path.join(PRACTICE_DIR, `${id}.json`);

  if (!fs.existsSync(file)) {
    const files = fs.readdirSync(PRACTICE_DIR).filter(f => f.endsWith(".json"));
    if (files.length === 0) {
      return res.status(503).json({ error: "No practice charts available yet." });
    }
    const random = files[Math.floor(Math.random() * files.length)];
    const chart  = JSON.parse(fs.readFileSync(path.join(PRACTICE_DIR, random), "utf8"));
    return res.json(chart);
  }

  const chart = JSON.parse(fs.readFileSync(file, "utf8"));
  res.json(chart);
});

// GET /api/chart/practice-count
app.get("/api/chart/practice-count", requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const isPaid = user.subscription_status === "active";
  const FREE_MAX = parseInt(process.env.FREE_PRACTICE_PER_DAY || "3");

  if (isPaid) {
    return res.json({ used: 0, limit: null, isPaid: true });
  }

  const used = await db.getPracticeCount(req.user.id, todayKey());
  res.json({ used, limit: FREE_MAX, isPaid: false });
});

// GET /api/chart/pool-size
app.get("/api/chart/pool-size", (req, res) => {
  const count = fs.readdirSync(PRACTICE_DIR).filter(f => f.endsWith(".json")).length;
  res.json({ count });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/signup
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) {
    return res.status(400).json({ error: "Email, username and password are required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  // Check duplicates
  const emailUser = await db.getUserByEmail(email);
  if (emailUser) return res.status(409).json({ error: "Email already registered" });

  const nameTaken = await db.usernameExists(username);
  if (nameTaken) return res.status(409).json({ error: "Username already taken" });

  const id           = uuid();
  const passwordHash = await bcrypt.hash(password, 12);
  const verifyToken  = uuid();

  await db.createUser({ id, email, username, passwordHash, verifyToken });

  // Send verification email
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "noreply@chartle.app",
      to: email,
      subject: "Verify your Chartle account",
      html: `
        <div style="background:#080c18;padding:40px 0;width:100%;">
          <div style="max-width:460px;margin:0 auto;padding:40px 32px;background:#0d1220;border:1px solid rgba(255,255,255,0.06);border-radius:16px;font-family:'Courier New',Courier,monospace;">
            <div style="margin-bottom:32px;">
              <span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#e2e8f0;">CHAR</span><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#00a65a;">TLE</span>
            </div>
            <div style="height:1px;background:linear-gradient(90deg,#00a65a,transparent);margin-bottom:28px;"></div>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 8px;">Welcome, <span style="color:#e2e8f0;font-weight:700;">${username}</span></p>
            <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0 0 28px;">Click below to verify your email and activate your account.</p>
            <a href="${process.env.BASE_URL}/api/auth/verify?token=${verifyToken}"
               style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#00a65a,#00c96b);color:#000;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px;letter-spacing:2px;font-family:'Courier New',Courier,monospace;">
              VERIFY EMAIL
            </a>
            <div style="height:1px;background:rgba(255,255,255,0.04);margin:32px 0 20px;"></div>
            <p style="color:#475569;font-size:11px;line-height:1.6;margin:0;">If you didn't create a Chartle account, you can safely ignore this email.</p>
          </div>
        </div>
      `,
    });
  } catch (e) {
    console.error("Email send failed:", e.message);
  }

  const token = jwt.sign({ id, email: email.toLowerCase(), username }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });

  res.status(201).json({
    token,
    user: {
      id,
      email: email.toLowerCase(),
      username,
      verified: false,
      subscription: { status: "free" },
    },
  });
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = await db.getUserByEmail(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  const token = jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );

  const isAdmin = user.email === (process.env.ADMIN_EMAIL || "").toLowerCase();

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      verified: user.verified,
      isAdmin,
      subscription: {
        status: user.subscription_status,
        stripeCustomerId: user.stripe_customer_id,
        stripeSubscriptionId: user.stripe_subscription_id,
        activatedAt: user.subscription_activated_at,
      },
    },
  });
});

// GET /api/auth/verify?token=xxx
app.get("/api/auth/verify", async (req, res) => {
  const { token } = req.query;
  const user = await db.getUserByVerifyToken(token);

  if (!user) {
    return res.send(`<html><body style="margin:0;background:#080c18;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Courier New',Courier,monospace;">
      <div style="text-align:center;max-width:400px;padding:40px 32px;background:#0d1220;border:1px solid rgba(255,255,255,0.06);border-radius:16px;">
        <div style="margin-bottom:24px;"><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#e2e8f0;">CHAR</span><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#00a65a;">TLE</span></div>
        <div style="font-size:32px;margin-bottom:16px;">✕</div>
        <h2 style="color:#ff5050;font-size:16px;letter-spacing:1px;margin:0 0 12px;">Invalid or expired link</h2>
        <p style="color:#64748b;font-size:12px;margin:0 0 24px;">This verification link is no longer valid. Please request a new one.</p>
        <a href="${process.env.FRONTEND_URL || "/"}" style="color:#00a65a;font-size:12px;letter-spacing:1px;text-decoration:none;">← BACK TO CHARTLE</a>
      </div>
    </body></html>`);
  }

  await db.updateUser(user.id, { verified: true, verify_token: null });

  const redirectUrl = (process.env.FRONTEND_URL || "/") + "?verified=1";
  res.send(`<html><head><meta http-equiv="refresh" content="2;url=${redirectUrl}"></head><body style="margin:0;background:#080c18;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Courier New',Courier,monospace;">
    <div style="text-align:center;max-width:400px;padding:40px 32px;background:#0d1220;border:1px solid rgba(255,255,255,0.06);border-radius:16px;">
      <div style="margin-bottom:24px;"><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#e2e8f0;">CHAR</span><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#00a65a;">TLE</span></div>
      <div style="font-size:32px;margin-bottom:16px;">✓</div>
      <h2 style="color:#00a65a;font-size:16px;letter-spacing:1px;margin:0 0 12px;">Email Verified</h2>
      <p style="color:#94a3b8;font-size:12px;margin:0 0 24px;">Your account is now active. Redirecting...</p>
    </div>
  </body></html>`);
});

// POST /api/auth/forgot-password
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  res.json({ message: "If that email exists, a reset link has been sent." });

  const user = await db.getUserByEmail(email);
  if (!user) return;

  const resetToken   = uuid();
  const resetExpires = Date.now() + 1000 * 60 * 60; // 1 hour
  await db.updateUser(user.id, { reset_token: resetToken, reset_expires: resetExpires });

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "noreply@chartle.app",
      to: user.email,
      subject: "Reset your Chartle password",
      html: `
        <div style="background:#080c18;padding:40px 0;width:100%;">
          <div style="max-width:460px;margin:0 auto;padding:40px 32px;background:#0d1220;border:1px solid rgba(255,255,255,0.06);border-radius:16px;font-family:'Courier New',Courier,monospace;">
            <div style="margin-bottom:32px;">
              <span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#e2e8f0;">CHAR</span><span style="font-size:22px;font-weight:900;letter-spacing:3px;color:#00a65a;">TLE</span>
            </div>
            <div style="height:1px;background:linear-gradient(90deg,#00a65a,transparent);margin-bottom:28px;"></div>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 8px;">Password Reset</p>
            <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0 0 28px;">Click below to choose a new password. This link expires in 1 hour.</p>
            <a href="${process.env.BASE_URL}/reset-password?token=${resetToken}"
               style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#00a65a,#00c96b);color:#000;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px;letter-spacing:2px;font-family:'Courier New',Courier,monospace;">
              RESET PASSWORD
            </a>
            <div style="height:1px;background:rgba(255,255,255,0.04);margin:32px 0 20px;"></div>
            <p style="color:#475569;font-size:11px;line-height:1.6;margin:0;">If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
        </div>
      `,
    });
  } catch (e) { console.error("Password reset email failed:", e.message); }
});

// POST /api/auth/reset-password
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password required" });
  if (password.length < 8)  return res.status(400).json({ error: "Password must be at least 8 characters" });

  const user = await db.getUserByResetToken(token);
  if (!user) return res.status(400).json({ error: "Invalid or expired reset token" });

  const passwordHash = await bcrypt.hash(password, 12);
  await db.updateUser(user.id, { password_hash: passwordHash, reset_token: null, reset_expires: null });

  res.json({ message: "Password updated successfully" });
});

// ─────────────────────────────────────────────────────────────────────────────
// USER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/user/me
app.get("/api/user/me", requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id:           user.id,
    email:        user.email,
    username:     user.username,
    verified:     user.verified,
    isAdmin:      user.email === (process.env.ADMIN_EMAIL || "").toLowerCase(),
    subscription: {
      status: user.subscription_status,
      stripeCustomerId: user.stripe_customer_id,
      stripeSubscriptionId: user.stripe_subscription_id,
      activatedAt: user.subscription_activated_at,
    },
    createdAt:    user.created_at,
  });
});

// PATCH /api/user/me — update username or password
app.patch("/api/user/me", requireAuth, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const updates = {};

  if (username && username !== user.username) {
    const taken = await db.usernameExists(username, user.id);
    if (taken) return res.status(409).json({ error: "Username already taken" });
    updates.username = username;
  }

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: "Current password required" });
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    updates.password_hash = await bcrypt.hash(newPassword, 12);
  }

  if (Object.keys(updates).length > 0) {
    await db.updateUser(user.id, updates);
  }

  res.json({ message: "Profile updated successfully" });
});

// DELETE /api/user/me — delete account
app.delete("/api/user/me", requireAuth, async (req, res) => {
  const { password } = req.body;
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Incorrect password" });

  // Cancel Stripe subscription if active
  if (user.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(user.stripe_subscription_id);
    } catch (e) { console.error("Stripe cancel failed:", e.message); }
  }

  await db.deleteUser(req.user.id); // cascades to journal + consensus
  res.json({ message: "Account deleted" });
});

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL ENDPOINTS (NEW — replaces localStorage)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/journal — all entries for the logged-in user
app.get("/api/journal", requireAuth, async (req, res) => {
  const entries = await db.getJournalEntries(req.user.id);
  res.json(entries);
});

// GET /api/journal/:seed — single entry
app.get("/api/journal/:seed", requireAuth, async (req, res) => {
  const entry = await db.getJournalEntry(req.user.id, parseInt(req.params.seed));
  res.json(entry); // null if not found
});

// POST /api/journal — create or update an entry
app.post("/api/journal", requireAuth, async (req, res) => {
  const { seed, asset, tf, direction, sl, tp, entryPrice, score, result, grade, notes } = req.body;
  if (!seed) return res.status(400).json({ error: "seed is required" });

  await db.upsertJournalEntry(req.user.id, {
    seed, asset, tf, direction, sl, tp, entryPrice, score, result, grade, notes: notes || "",
  });

  res.json({ ok: true });
});

// DELETE /api/journal/:seed — delete a single entry
app.delete("/api/journal/:seed", requireAuth, async (req, res) => {
  const seed = parseInt(req.params.seed);
  const deleted = await db.deleteJournalEntry(req.user.id, seed);
  res.json({ ok: true, deleted });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAILY SCORE ENDPOINTS — server-side tracking of daily attempts
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/daily-score/:seed — check if player has already played today
app.get("/api/daily-score/:seed", optionalAuth, async (req, res) => {
  const seed = parseInt(req.params.seed);
  const playerId = getPlayerId(req, res);
  const score = await db.getDailyScore(playerId, seed);
  res.json({ played: !!score, score });
});

// POST /api/daily-score — save daily score when trade completes
app.post("/api/daily-score", optionalAuth, async (req, res) => {
  const { seed, direction, sl, tp, scoreData, visibleFuture } = req.body;
  if (!seed || !direction) return res.status(400).json({ error: "seed and direction required" });
  const playerId = getPlayerId(req, res);
  await db.saveDailyScore(playerId, seed, { direction, sl, tp, scoreData, visibleFuture });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSENSUS ENDPOINTS (NEW — replaces localStorage)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/consensus/:seed — get the pool for a day
app.get("/api/consensus/:seed", optionalAuth, async (req, res) => {
  const seed = parseInt(req.params.seed);
  const pool = await db.getConsensusPool(seed);
  const playerId = getPlayerId(req, res);
  const hasVoted = await db.hasVotedConsensus(playerId, seed);
  res.json({ pool, hasVoted });
});

// POST /api/consensus — submit a vote
app.post("/api/consensus", optionalAuth, async (req, res) => {
  const { seed, direction, sl, tp, score, result } = req.body;
  if (!seed || !direction) return res.status(400).json({ error: "seed and direction required" });
  const playerId = getPlayerId(req, res);
  await db.submitConsensus(playerId, { seed, direction, sl, tp, score, result });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!adminEmail || req.user.email !== adminEmail) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// GET /api/admin/users?q=search
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  const users = await db.searchUsers(q);
  res.json(users);
});

// DELETE /api/admin/users/:id
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = req.params.id;

  // Prevent deleting yourself
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "Cannot delete your own admin account" });
  }

  const target = await db.getUserById(targetId);
  if (!target) return res.status(404).json({ error: "User not found" });

  // Cancel Stripe subscription if active
  if (target.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(target.stripe_subscription_id);
    } catch (e) { console.error("Stripe cancel failed:", e.message); }
  }

  await db.deleteUser(targetId);
  console.log(`[ADMIN] Deleted user ${target.email} (${targetId})`);
  res.json({ ok: true, message: `User ${target.email} deleted` });
});

// POST /api/admin/users/:id/cancel-subscription
app.post("/api/admin/users/:id/cancel-subscription", requireAuth, requireAdmin, async (req, res) => {
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  // Cancel on Stripe if exists
  if (target.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(target.stripe_subscription_id);
    } catch (e) { console.error("Stripe cancel failed:", e.message); }
  }

  await db.updateUser(target.id, { subscription_status: "cancelled" });
  console.log(`[ADMIN] Cancelled subscription for ${target.email} (${target.id})`);
  res.json({ ok: true, message: `Subscription cancelled for ${target.email}` });
});

// POST /api/admin/reset-daily — reset all daily data (consensus + practice usage + daily attempts)
app.post("/api/admin/reset-daily", requireAuth, requireAdmin, async (req, res) => {
  const d = new Date();
  const todaySeed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const today = todayKey();

  const consensusCleared = await db.clearConsensus(todaySeed);
  const practiceCleared = await db.clearPracticeSessions(today);
  const scoresCleared = await db.clearDailyScores(todaySeed);
  const newVersion = incrementResetVersion();

  console.log(`[ADMIN] Reset daily: consensus=${consensusCleared}, practice=${practiceCleared}, scores=${scoresCleared}, resetVersion=${newVersion}`);
  res.json({
    ok: true,
    message: `Reset v${newVersion}: cleared ${consensusCleared} consensus, ${practiceCleared} practice, ${scoresCleared} daily scores. All users can replay.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/stripe/checkout
app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.stripe_customer_id) {
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer:   user.stripe_customer_id,
        return_url: process.env.FRONTEND_URL || "http://localhost:3000",
      });
      return res.json({ url: portal.url });
    } catch (e) { console.error("Portal failed:", e.message); }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 "subscription",
      payment_method_types: ["card"],
      customer_email:       user.email,
      line_items: [{
        price:    process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}?subscribed=true`,
      cancel_url:  `${process.env.FRONTEND_URL || "http://localhost:3000"}?cancelled=true`,
      metadata: { userId: req.user.id },
      automatic_tax: { enabled: false },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/stripe/portal
app.post("/api/stripe/portal", requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user?.stripe_customer_id) {
    return res.status(400).json({ error: "No active subscription found" });
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: process.env.FRONTEND_URL || "http://localhost:3000",
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(500).json({ error: "Failed to open billing portal" });
  }
});

// POST /api/stripe/webhook
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error("Webhook signature failed:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId  = session.metadata?.userId;
      if (userId) {
        await db.updateUser(userId, {
          subscription_status:       "active",
          stripe_customer_id:        session.customer,
          stripe_subscription_id:    session.subscription,
          subscription_activated_at: Date.now(),
        });
        console.log(`✓ Subscription activated for user ${userId}`);
      }
      break;
    }

    case "customer.subscription.deleted":
    case "customer.subscription.paused": {
      const sub  = event.data.object;
      const user = await db.getUserByStripeCustomer(sub.customer);
      if (user) {
        await db.updateUser(user.id, { subscription_status: "cancelled" });
        console.log(`✗ Subscription cancelled for user ${user.id}`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub  = event.data.object;
      const user = await db.getUserByStripeCustomer(sub.customer);
      if (user) {
        await db.updateUser(user.id, { subscription_status: sub.status });
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const user    = await db.getUserByStripeCustomer(invoice.customer);
      if (user) {
        await db.updateUser(user.id, { subscription_status: "past_due" });
      }
      break;
    }
  }

  res.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA CATCH-ALL — serve index.html for any non-API route
// ─────────────────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON
// ─────────────────────────────────────────────────────────────────────────────
const cron = require("node-cron");
const { fetchAndSaveDailyChart, fetchAndSavePracticeChart } = require("./cron");

cron.schedule("1 0 * * *", async () => {
  console.log("[CRON] Fetching daily chart...");
  try {
    await fetchAndSaveDailyChart();
    console.log("[CRON] Daily chart saved.");
  } catch (e) {
    console.error("[CRON] Daily chart failed:", e.message);
  }
});

cron.schedule("0 * * * *", async () => {
  const count = fs.readdirSync(PRACTICE_DIR).filter(f => f.endsWith(".json")).length;
  if (count >= 5000) return;
  console.log(`[CRON] Adding practice chart (pool: ${count}/5000)...`);
  try {
    await fetchAndSavePracticeChart();
  } catch (e) {
    console.error("[CRON] Practice chart failed:", e.message);
  }
});

// Twice daily (6am, 6pm) — delete unverified accounts older than 24 hours
cron.schedule("0 6,18 * * *", async () => {
  try {
    const deleted = await db.deleteExpiredUnverified(24 * 60 * 60 * 1000);
    if (deleted > 0) console.log(`[CRON] Cleaned up ${deleted} expired unverified accounts.`);
  } catch (e) {
    console.error("[CRON] Unverified cleanup failed:", e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START — init DB, then listen
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🟢 Chartle server running on port ${PORT}`);
      console.log(`   Frontend: http://localhost:${PORT}`);
      console.log(`   API:      http://localhost:${PORT}/api\n`);

      // Fetch daily chart on startup if today's doesn't exist
      const todayFile = path.join(DAILY_DIR, `${todayKey()}.json`);
      if (!fs.existsSync(todayFile)) {
        console.log("[STARTUP] No daily chart for today — fetching now...");
        // Chart is being regenerated (redeploy wiped it, or new day)
        // Clear ALL stale daily data BEFORE fetching the new chart
        const d = new Date();
        const todaySeed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        const today = todayKey();

        (async () => {
          try {
            const cc = await db.clearConsensus(todaySeed);
            const pc = await db.clearPracticeSessions(today);
            const sc = await db.clearDailyScores(todaySeed);
            const rv = incrementResetVersion();
            console.log(`[STARTUP] Cleared stale data: ${cc} consensus, ${pc} practice, ${sc} scores, resetVersion=${rv}`);
          } catch (e) {
            console.error("[STARTUP] Clear stale data failed:", e.message);
          }
          try {
            await fetchAndSaveDailyChart();
            console.log("[STARTUP] Daily chart ready.");
          } catch (e) {
            console.error("[STARTUP] Daily chart fetch failed:", e.message);
          }
        })();
      }
    });
  })
  .catch(e => {
    console.error("❌ Failed to initialise database:", e.message);
    process.exit(1);
  });
