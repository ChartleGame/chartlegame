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

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, "data");
const DAILY_DIR    = path.join(DATA_DIR, "daily");
const PRACTICE_DIR = path.join(DATA_DIR, "practice");
const USERS_FILE   = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE= path.join(DATA_DIR, "sessions.json"); // practice usage tracking

// Ensure directories exist
[DATA_DIR, DAILY_DIR, PRACTICE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Simple JSON file DB helpers ───────────────────────────────────────────────
function readJSON(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { return fallback; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function getUsers()   { return readJSON(USERS_FILE, {}); }
function saveUsers(u) { writeJSON(USERS_FILE, u); }

function getSessions()   { return readJSON(SESSIONS_FILE, {}); }
function saveSessions(s) { writeJSON(SESSIONS_FILE, s); }

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
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try { req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET); } catch {}
  }
  next();
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
// CHART ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/chart/daily
// Returns today's pre-fetched chart. No auth required.
app.get("/api/chart/daily", optionalAuth, (req, res) => {
  const key  = todayKey();
  const file = path.join(DAILY_DIR, `${key}.json`);

  if (!fs.existsSync(file)) {
    // Fallback: return most recent available daily chart
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
    return res.json({ ...latest, isFallback: true });
  }

  const chart = JSON.parse(fs.readFileSync(file, "utf8"));
  res.json(chart);
});

// GET /api/chart/practice/:id
// Returns a practice chart. Requires auth. Free users: 3/day. Paid: unlimited.
app.get("/api/chart/practice/:id", requireAuth, (req, res) => {
  const users    = getUsers();
  const user     = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  const isPaid   = user.subscription?.status === "active";
  const FREE_MAX = parseInt(process.env.FREE_PRACTICE_PER_DAY || "3");

  if (!isPaid) {
    // Check today's usage
    const sessions  = getSessions();
    const today     = todayKey();
    const userKey   = `${req.user.id}:${today}`;
    const usedToday = sessions[userKey] || 0;

    if (usedToday >= FREE_MAX) {
      return res.status(403).json({
        error: "daily_limit_reached",
        message: `Free accounts get ${FREE_MAX} practice charts per day. Upgrade to get unlimited access.`,
        used: usedToday,
        limit: FREE_MAX,
      });
    }

    // Increment counter
    sessions[userKey] = usedToday + 1;
    saveSessions(sessions);
  }

  // Find the practice chart
  const id   = String(req.params.id).padStart(4, "0");
  const file = path.join(PRACTICE_DIR, `${id}.json`);

  if (!fs.existsSync(file)) {
    // Return a random available chart
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
// Returns how many practice charts the user has used today
app.get("/api/chart/practice-count", requireAuth, (req, res) => {
  const users  = getUsers();
  const user   = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  const isPaid = user.subscription?.status === "active";
  const FREE_MAX = parseInt(process.env.FREE_PRACTICE_PER_DAY || "3");

  if (isPaid) {
    return res.json({ used: 0, limit: null, isPaid: true });
  }

  const sessions = getSessions();
  const today    = todayKey();
  const userKey  = `${req.user.id}:${today}`;
  const used     = sessions[userKey] || 0;

  res.json({ used, limit: FREE_MAX, isPaid: false });
});

// GET /api/chart/pool-size
// Returns how many practice charts are in the pool (admin info)
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
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const users = getUsers();

  // Check duplicates
  const emailExists    = Object.values(users).some(u => u.email === email.toLowerCase());
  const usernameExists = Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase());
  if (emailExists)    return res.status(409).json({ error: "Email already registered" });
  if (usernameExists) return res.status(409).json({ error: "Username already taken" });

  const id           = uuid();
  const passwordHash = await bcrypt.hash(password, 12);
  const verifyToken  = uuid();

  users[id] = {
    id,
    email: email.toLowerCase(),
    username,
    passwordHash,
    verifyToken,
    verified: false,
    createdAt: Date.now(),
    subscription: { status: "free" },
  };
  saveUsers(users);

  // Send verification email
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "noreply@tradle.app",
      to: email,
      subject: "Verify your Tradle account",
      html: `
        <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #00a65a; letter-spacing: 2px;">TRADLE</h2>
          <p>Welcome, <strong>${username}</strong>!</p>
          <p>Click the link below to verify your email address:</p>
          <a href="${process.env.BASE_URL}/api/auth/verify?token=${verifyToken}"
             style="display:inline-block;margin:20px 0;padding:12px 24px;background:#00a65a;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;letter-spacing:1px;">
            VERIFY EMAIL
          </a>
          <p style="color:#666;font-size:12px;">If you didn't create a Tradle account, ignore this email.</p>
        </div>
      `,
    });
  } catch (e) {
    console.error("Email send failed:", e.message);
    // Don't fail signup if email fails — just log it
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

  const users = getUsers();
  const user  = Object.values(users).find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  const token = jwt.sign(
    { id: user.id, email: user.email, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      verified: user.verified,
      subscription: user.subscription,
    },
  });
});

// GET /api/auth/verify?token=xxx
app.get("/api/auth/verify", (req, res) => {
  const { token } = req.query;
  const users = getUsers();
  const user  = Object.values(users).find(u => u.verifyToken === token);

  if (!user) {
    return res.send(`<html><body style="font-family:monospace;text-align:center;padding:60px">
      <h2 style="color:#e03535">Invalid or expired verification link.</h2>
      <a href="${process.env.FRONTEND_URL || "/"}">← Back to Tradle</a>
    </body></html>`);
  }

  users[user.id].verified = true;
  users[user.id].verifyToken = null;
  saveUsers(users);

  res.send(`<html><body style="font-family:monospace;text-align:center;padding:60px">
    <h2 style="color:#00a65a">✓ Email verified!</h2>
    <p>Your Tradle account is now active.</p>
    <a href="${process.env.FRONTEND_URL || "/"}" style="color:#00a65a">← Play Tradle</a>
  </body></html>`);
});

// POST /api/auth/forgot-password
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  const users = getUsers();
  const user  = Object.values(users).find(u => u.email === email?.toLowerCase());

  // Always return 200 to prevent email enumeration
  res.json({ message: "If that email exists, a reset link has been sent." });

  if (!user) return;

  const resetToken   = uuid();
  const resetExpires = Date.now() + 1000 * 60 * 60; // 1 hour

  users[user.id].resetToken   = resetToken;
  users[user.id].resetExpires = resetExpires;
  saveUsers(users);

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "noreply@tradle.app",
      to: user.email,
      subject: "Reset your Tradle password",
      html: `
        <div style="font-family: monospace; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #00a65a; letter-spacing: 2px;">TRADLE</h2>
          <p>You requested a password reset.</p>
          <a href="${process.env.BASE_URL}/reset-password?token=${resetToken}"
             style="display:inline-block;margin:20px 0;padding:12px 24px;background:#00a65a;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;letter-spacing:1px;">
            RESET PASSWORD
          </a>
          <p style="color:#666;font-size:12px;">This link expires in 1 hour. If you didn't request this, ignore it.</p>
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

  const users = getUsers();
  const user  = Object.values(users).find(
    u => u.resetToken === token && u.resetExpires > Date.now()
  );

  if (!user) return res.status(400).json({ error: "Invalid or expired reset token" });

  users[user.id].passwordHash  = await bcrypt.hash(password, 12);
  users[user.id].resetToken    = null;
  users[user.id].resetExpires  = null;
  saveUsers(users);

  res.json({ message: "Password updated successfully" });
});

// ─────────────────────────────────────────────────────────────────────────────
// USER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/user/me
app.get("/api/user/me", requireAuth, (req, res) => {
  const users = getUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id:           user.id,
    email:        user.email,
    username:     user.username,
    verified:     user.verified,
    subscription: user.subscription,
    createdAt:    user.createdAt,
  });
});

// PATCH /api/user/me  — update username or password
app.patch("/api/user/me", requireAuth, async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  const users = getUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  if (username && username !== user.username) {
    const taken = Object.values(users).some(
      u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase()
    );
    if (taken) return res.status(409).json({ error: "Username already taken" });
    users[req.user.id].username = username;
  }

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: "Current password required" });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    users[req.user.id].passwordHash = await bcrypt.hash(newPassword, 12);
  }

  saveUsers(users);
  res.json({ message: "Profile updated successfully" });
});

// DELETE /api/user/me — delete account
app.delete("/api/user/me", requireAuth, async (req, res) => {
  const { password } = req.body;
  const users = getUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Incorrect password" });

  // Cancel Stripe subscription if active
  if (user.subscription?.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(user.subscription.stripeSubscriptionId);
    } catch (e) { console.error("Stripe cancel failed:", e.message); }
  }

  delete users[req.user.id];
  saveUsers(users);

  res.json({ message: "Account deleted" });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/stripe/checkout — create a Stripe Checkout Session
app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  const users = getUsers();
  const user  = users[req.user.id];
  if (!user) return res.status(404).json({ error: "User not found" });

  // If already subscribed, redirect to billing portal instead
  if (user.subscription?.stripeCustomerId) {
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer:   user.subscription.stripeCustomerId,
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
      // Enable currency auto-detection (Stripe handles USD/CAD/EUR based on card)
      automatic_tax: { enabled: false },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/stripe/portal — manage existing subscription
app.post("/api/stripe/portal", requireAuth, async (req, res) => {
  const users = getUsers();
  const user  = users[req.user.id];
  if (!user?.subscription?.stripeCustomerId) {
    return res.status(400).json({ error: "No active subscription found" });
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer:   user.subscription.stripeCustomerId,
      return_url: process.env.FRONTEND_URL || "http://localhost:3000",
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(500).json({ error: "Failed to open billing portal" });
  }
});

// POST /api/stripe/webhook — Stripe event handler (raw body, registered above)
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

  const users = getUsers();

  switch (event.type) {
    case "checkout.session.completed": {
      const session  = event.data.object;
      const userId   = session.metadata?.userId;
      if (userId && users[userId]) {
        users[userId].subscription = {
          status:               "active",
          stripeCustomerId:     session.customer,
          stripeSubscriptionId: session.subscription,
          activatedAt:          Date.now(),
        };
        saveUsers(users);
        console.log(`✓ Subscription activated for user ${userId}`);
      }
      break;
    }

    case "customer.subscription.deleted":
    case "customer.subscription.paused": {
      const sub    = event.data.object;
      const userId = Object.keys(users).find(
        id => users[id].subscription?.stripeCustomerId === sub.customer
      );
      if (userId) {
        users[userId].subscription.status = "cancelled";
        saveUsers(users);
        console.log(`✗ Subscription cancelled for user ${userId}`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub    = event.data.object;
      const userId = Object.keys(users).find(
        id => users[id].subscription?.stripeCustomerId === sub.customer
      );
      if (userId) {
        users[userId].subscription.status = sub.status; // active / past_due / etc
        saveUsers(users);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const userId  = Object.keys(users).find(
        id => users[id].subscription?.stripeCustomerId === invoice.customer
      );
      if (userId) {
        users[userId].subscription.status = "past_due";
        saveUsers(users);
        // Optionally send a payment failed email here
      }
      break;
    }
  }

  res.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON — run within the same process (also available standalone via cron.js)
// ─────────────────────────────────────────────────────────────────────────────
const cron = require("node-cron");
const { fetchAndSaveDailyChart, fetchAndSavePracticeChart } = require("./cron");

// Every day at 00:01 — fetch tomorrow's daily chart
cron.schedule("1 0 * * *", async () => {
  console.log("[CRON] Fetching daily chart...");
  try {
    await fetchAndSaveDailyChart();
    console.log("[CRON] Daily chart saved.");
  } catch (e) {
    console.error("[CRON] Daily chart failed:", e.message);
  }
});

// Every hour — add one practice chart to the pool (uses ~1 API call)
cron.schedule("0 * * * *", async () => {
  const count = fs.readdirSync(PRACTICE_DIR).filter(f => f.endsWith(".json")).length;
  if (count >= 5000) return; // pool is full
  console.log(`[CRON] Adding practice chart (pool: ${count}/5000)...`);
  try {
    await fetchAndSavePracticeChart();
  } catch (e) {
    console.error("[CRON] Practice chart failed:", e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 Tradle server running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api\n`);

  // Fetch daily chart on startup if today's doesn't exist
  const todayFile = path.join(DAILY_DIR, `${todayKey()}.json`);
  if (!fs.existsSync(todayFile)) {
    console.log("[STARTUP] No daily chart for today — fetching now...");
    fetchAndSaveDailyChart()
      .then(() => console.log("[STARTUP] Daily chart ready."))
      .catch(e => console.error("[STARTUP] Daily chart fetch failed:", e.message));
  }
});
