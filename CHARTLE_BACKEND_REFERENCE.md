# Chartle Backend Reference

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                   RAILWAY                         │
│                                                   │
│  ┌────────────┐        ┌───────────────────────┐ │
│  │  PostgreSQL │◄──────►│  Node.js Server       │ │
│  │  (database) │  SQL   │  (Express)            │ │
│  │             │        │                       │ │
│  │  - users    │        │  server/index.js      │ │
│  │  - journal  │        │  server/db.js         │ │
│  │  - consensus│        │  server/cron.js       │ │
│  │  - practice │        │                       │ │
│  └────────────┘        │  public/index.html     │ │
│                         │  (served as static)    │ │
│                         └───────────────────────┘ │
└──────────────────────────────────────────────────┘
```

Your backend is 3 files:

| File | Purpose | Lines |
|------|---------|-------|
| `server/index.js` | Express web server — all API endpoints, auth, Stripe | ~720 |
| `server/db.js` | Database connection, schema, all SQL queries | ~360 |
| `server/cron.js` | Chart fetching from Alpha Vantage API | ~330 |

---

## File 1: server/db.js — The Database Layer

This file is the **only file that talks to PostgreSQL**. Every other file goes through the functions exported here. If you want to change how data is stored, this is the only file you touch.

### How it connects

```js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,  // Set by Railway automatically
  ssl: { rejectUnauthorized: false },           // Required for Railway's Postgres
  max: 10,                                      // Up to 10 simultaneous connections
});
```

A "pool" means the server keeps several database connections open and reuses them. You don't open/close connections manually — you just call `pool.query(...)` and it handles the rest.

### The 4 tables

When the server starts, `initSchema()` runs and creates these tables if they don't already exist:

**users** — One row per registered account.
```
id                        TEXT       — UUID, primary key (e.g. "a1b2c3d4-...")
email                     TEXT       — unique, always lowercase
username                  TEXT       — unique, case-insensitive
password_hash             TEXT       — bcrypt hash, never the raw password
verified                  BOOLEAN    — true after clicking the email verification link
verify_token              TEXT       — UUID sent in the verification email, null after use
reset_token               TEXT       — UUID sent in the forgot-password email
reset_expires             BIGINT     — Unix timestamp (ms) when reset_token expires
subscription_status       TEXT       — "free", "active", "cancelled", "past_due"
stripe_customer_id        TEXT       — Stripe's customer ID (set after first payment)
stripe_subscription_id    TEXT       — Stripe's subscription ID
subscription_activated_at BIGINT     — When they became Pro (Unix ms)
created_at                BIGINT     — When they signed up (Unix ms)
```

**journal_entries** — One row per trade the user saves in the journal. The `UNIQUE(user_id, seed)` constraint means each user can have exactly one journal entry per daily chart (identified by `seed`). Saving again overwrites the old entry.
```
id           SERIAL     — Auto-incrementing ID
user_id      TEXT       — Foreign key → users.id (CASCADE: deleting user deletes entries)
seed         INTEGER    — The daily chart identifier (YYYYMMDD format, e.g. 20260317)
asset        TEXT       — e.g. "BTC/USD", "AAPL"
tf           TEXT       — Timeframe, e.g. "1D", "4H"
direction    TEXT       — "long" or "short"
sl           TEXT       — Stop loss price as string
tp           TEXT       — Take profit price as string
entry_price  FLOAT      — The entry price
score        INTEGER    — 0-100 score
result       TEXT       — "tp", "sl", or "timeout"
grade        TEXT       — "S", "A", "B", "C", or "D"
notes        TEXT       — Free-text trade notes
created_at   BIGINT     — When saved (Unix ms)
```

**consensus_votes** — One row per user per daily chart. This is the "how did everyone trade?" page. `UNIQUE(user_id, seed)` prevents voting twice.
```
id           SERIAL
user_id      TEXT       — FK → users.id (CASCADE)
seed         INTEGER    — Same YYYYMMDD seed as journal
direction    TEXT       — "long" or "short"
sl           FLOAT      — Stop loss
tp           FLOAT      — Take profit
score        INTEGER    — Their score
result       TEXT       — "tp", "sl", "timeout"
created_at   BIGINT
```

**practice_sessions** — Tracks how many practice charts each free user has loaded today. `UNIQUE(user_id, date_key)` means one counter per user per day.
```
id           SERIAL
user_id      TEXT
date_key     TEXT       — "2026-03-17" format
count        INTEGER    — How many practice charts loaded today
```

### Key functions and what they do

**Startup:**
- `init()` — Called once when server starts. Runs `initSchema()` → `migrateFromJSON()` → `seedTestAccount()` in order.
- `initSchema()` — Creates all 4 tables if they don't exist. Safe to run repeatedly.
- `migrateFromJSON()` — One-time migration. If `data/users.json` exists and the users table is empty, imports all users from the JSON file into Postgres. Then renames the file to `users.json.migrated` so it doesn't run again.
- `seedTestAccount()` — If `ADMIN_EMAIL` and `ADMIN_PASSWORD` env vars are set, creates (or upgrades) an admin account with Pro status.

**User lookups:**
- `getUserById(id)` → returns full user row or null
- `getUserByEmail(email)` → same, by email (lowercased)
- `getUserByVerifyToken(token)` → finds user by their email verification token
- `getUserByResetToken(token)` → finds user by password reset token (also checks it hasn't expired)
- `getUserByStripeCustomer(customerId)` → finds user by Stripe customer ID (used in webhooks)
- `usernameExists(username, excludeId?)` → returns true/false, case-insensitive. Optional `excludeId` so a user can "keep" their own username during profile edit.
- `searchUsers(query)` → admin search — LIKE match on email or username, returns up to 50 results.

**User mutations:**
- `createUser({ id, email, username, passwordHash, verifyToken })` → INSERT
- `updateUser(id, { field: value, ... })` → dynamic UPDATE. You pass an object with only the fields you want to change. It builds the SQL automatically:
  ```js
  // This:
  await db.updateUser("abc123", { username: "newname", verified: true });
  // Becomes:
  UPDATE users SET username = $1, verified = $2 WHERE id = $3
  ```
- `deleteUser(id)` → DELETE. Because of `ON DELETE CASCADE` on the foreign keys, this automatically deletes the user's journal entries and consensus votes too.

**Practice tracking:**
- `getPracticeCount(userId, dateKey)` → returns how many practice charts the user loaded today (0 if none)
- `incrementPractice(userId, dateKey)` → adds 1 to the counter. Uses `ON CONFLICT DO UPDATE` which means: if no row exists for this user+date, create one with count=1; if it already exists, increment count.

**Journal:**
- `getJournalEntries(userId)` → all entries for this user, newest first
- `getJournalEntry(userId, seed)` → one specific entry (or null)
- `upsertJournalEntry(userId, entry)` → INSERT or UPDATE. The `ON CONFLICT (user_id, seed) DO UPDATE` means: if the user already has an entry for this seed, overwrite it. Otherwise create a new one.

**Consensus:**
- `submitConsensus(userId, vote)` → INSERT with `ON CONFLICT DO NOTHING` (silently ignores duplicate votes)
- `getConsensusPool(seed)` → all votes for a given day
- `hasVotedConsensus(userId, seed)` → true/false
- `clearConsensus(seed)` → DELETE all votes for a seed (used on redeploy/admin reset)
- `clearPracticeSessions(dateKey)` → DELETE all practice counters for a date

### How to add a new table

1. Add the CREATE TABLE statement inside `initSchema()`
2. Write your query functions (get, create, update, delete)
3. Add them to `module.exports` at the bottom
4. Use them in `index.js` as `db.yourFunction()`

### How to add a new column to an existing table

`CREATE TABLE IF NOT EXISTS` won't add new columns to a table that already exists. You need to run an ALTER:

```js
// Add this inside initSchema(), after the CREATE TABLE statements:
await client.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS new_column TEXT DEFAULT 'something';
`);
```

### SQL patterns used throughout

**Parameterized queries** — Never put variables directly in SQL strings. Always use `$1, $2, ...` placeholders:
```js
// GOOD:
pool.query("SELECT * FROM users WHERE email = $1", [email])

// BAD (SQL injection risk):
pool.query(`SELECT * FROM users WHERE email = '${email}'`)
```

**ON CONFLICT (upsert)** — Insert if new, update if exists:
```js
// Insert or update:
ON CONFLICT (user_id, seed) DO UPDATE SET notes = $5

// Insert or silently skip:
ON CONFLICT (user_id, seed) DO NOTHING
```

---

## File 2: server/index.js — The API Server

This is an Express.js web server. Express is a minimal web framework — you define routes (URL patterns) and what happens when someone hits them.

### How Express works (the basics)

```js
// Define a route: when someone sends GET to /api/thing, run this function
app.get("/api/thing", (req, res) => {
  // req = the incoming request (URL, headers, body, query params)
  // res = the response you send back
  res.json({ hello: "world" });  // Send JSON response
});

// POST route with a JSON body
app.post("/api/thing", (req, res) => {
  const { name } = req.body;     // Read JSON body
  res.status(201).json({ created: name });
});
```

### Middleware — functions that run before your route

```js
// This runs BEFORE the route handler:
function requireAuth(req, res, next) {
  // Check the Authorization header
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "No token" });
  // Verify the JWT and attach user info to the request
  req.user = jwt.verify(token, secret);
  next();  // Continue to the actual route handler
}

// Usage: requireAuth runs first, then the handler
app.get("/api/secret", requireAuth, (req, res) => {
  // req.user is now available because requireAuth set it
  res.json({ userId: req.user.id });
});
```

There are 3 middleware functions:
- `requireAuth` — Verifies the JWT token. Rejects with 401 if missing/invalid. Sets `req.user`.
- `optionalAuth` — Same but doesn't reject. `req.user` is either set or undefined.
- `requireAdmin` — Checks if `req.user.email` matches `ADMIN_EMAIL` env var. Must come after `requireAuth`.

### Authentication flow

**How JWTs work:**
1. User logs in with email + password
2. Server verifies password, creates a JWT (JSON Web Token) containing `{ id, email, username }`
3. Server sends the JWT back to the frontend
4. Frontend stores it in localStorage and sends it as `Authorization: Bearer <token>` on every request
5. `requireAuth` middleware decodes the JWT to identify the user — no database lookup needed

**Signup flow:**
```
POST /api/auth/signup { email, password, username }
  → Hash password with bcrypt (12 rounds)
  → Create user in DB
  → Generate verification token (UUID)
  → Send verification email via Resend
  → Return JWT + user object
```

**Login flow:**
```
POST /api/auth/login { email, password }
  → Find user by email
  → Compare password hash with bcrypt
  → Return JWT + user object (includes isAdmin flag)
```

**Email verification:**
```
GET /api/auth/verify?token=<uuid>
  → Find user by verify_token
  → Set verified=true, clear token
  → Show success HTML page
```

**Password reset:**
```
POST /api/auth/forgot-password { email }
  → Always returns 200 (prevents email enumeration)
  → If user exists: generate reset token, send email

POST /api/auth/reset-password { token, password }
  → Find user by reset_token (must not be expired)
  → Hash new password, clear token
```

### Complete API reference

**Auth:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| POST | /api/auth/signup | No | Create account |
| POST | /api/auth/login | No | Get JWT token |
| GET | /api/auth/verify?token=x | No | Verify email (returns HTML) |
| POST | /api/auth/forgot-password | No | Send reset email |
| POST | /api/auth/reset-password | No | Set new password |

**User:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| GET | /api/user/me | Required | Get current user profile |
| PATCH | /api/user/me | Required | Update username or password |
| DELETE | /api/user/me | Required | Delete account (requires password in body) |

**Charts:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| GET | /api/chart/daily | Optional | Today's chart (file-based) |
| GET | /api/chart/practice/:id | Required | A practice chart (enforces daily limit for free users) |
| GET | /api/chart/practice-count | Required | How many practice charts used today |
| GET | /api/chart/pool-size | No | How many practice charts exist |

**Journal:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| GET | /api/journal | Required | All journal entries for logged-in user |
| GET | /api/journal/:seed | Required | Single entry by seed |
| POST | /api/journal | Required | Create or update entry |

**Consensus:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| GET | /api/consensus/:seed | Optional | Get all votes for a day + whether current user voted |
| POST | /api/consensus | Required | Submit a vote |

**Admin** (requires ADMIN_EMAIL match):
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| GET | /api/admin/users?q=term | Admin | Search users by email/username |
| DELETE | /api/admin/users/:id | Admin | Delete a user |
| POST | /api/admin/users/:id/cancel-subscription | Admin | Downgrade user to free |
| POST | /api/admin/reset-daily | Admin | Clear today's consensus + practice counts |

**Stripe:**
| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| POST | /api/stripe/checkout | Required | Create Stripe checkout session |
| POST | /api/stripe/portal | Required | Open Stripe billing portal |
| POST | /api/stripe/webhook | No (Stripe calls this) | Handle payment events |

### How to add a new endpoint

Example: adding an endpoint to get a user's total score across all journal entries.

```js
// 1. Add a query function in db.js:
async function getUserTotalScore(userId) {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(score), 0) as total FROM journal_entries WHERE user_id = $1",
    [userId]
  );
  return rows[0].total;
}
// Don't forget to add it to module.exports!

// 2. Add the route in index.js:
app.get("/api/user/total-score", requireAuth, async (req, res) => {
  const total = await db.getUserTotalScore(req.user.id);
  res.json({ totalScore: total });
});
```

### Stripe webhook flow

Stripe sends POST requests to `/api/stripe/webhook` when payment events happen. The server handles 4 event types:

1. `checkout.session.completed` → User just paid. Activate their subscription.
2. `customer.subscription.deleted` / `paused` → Subscription ended. Mark as cancelled.
3. `customer.subscription.updated` → Status changed (e.g. active → past_due).
4. `invoice.payment_failed` → Payment failed. Mark as past_due.

The webhook is registered BEFORE `express.json()` middleware because Stripe requires the raw request body to verify the signature.

### Startup sequence

```
1. db.init()
   ├── initSchema()        — Create tables if needed
   ├── migrateFromJSON()   — Import users.json if it exists
   └── seedTestAccount()   — Create admin account if env vars set

2. app.listen(PORT)
   └── If no daily chart file exists:
       ├── clearConsensus(todaySeed)
       └── fetchAndSaveDailyChart()

3. Cron jobs start:
   ├── "1 0 * * *"  — Every midnight: fetch new daily chart
   └── "0 * * * *"  — Every hour: add one practice chart to pool
```

---

## File 3: server/cron.js — Chart Fetching

This file fetches real stock/crypto/forex charts from Alpha Vantage and saves them as JSON files.

### Asset universe

70% chance of a stock (100+ tickers like AAPL, TSLA, NVDA), 15% crypto (BTC, ETH, SOL, etc.), 15% forex (EUR/USD, GBP/USD, etc.).

### What a chart JSON looks like

```json
{
  "asset": "AAPL",
  "tf": "1D",
  "assetType": "stock",
  "entryPrice": 187.35,
  "displayBars": 80,
  "candles": [
    { "open": 182.1, "high": 183.5, "low": 181.2, "close": 182.9, "volume": 52340000 },
    ...  // 100 bars total (80 displayed + 20 warmup for moving averages)
  ],
  "future": [
    { "open": 187.35, "high": 189.1, "low": 186.8, "close": 188.2, "volume": 48000000 },
    ...  // 20 synthetic future bars (random walk based on recent volatility)
  ],
  "fetchedAt": 1710633600000
}
```

The future bars are **synthetic** — generated from a random walk seeded by the last real close price. They are NOT real future data.

### Two exported functions

- `fetchAndSaveDailyChart()` — Picks a random asset, fetches from Alpha Vantage, saves to `data/daily/YYYY-MM-DD.json`
- `fetchAndSavePracticeChart()` — Same but saves to `data/practice/0001.json`, `0002.json`, etc. Pool capped at 5000.

### Rate limits

Alpha Vantage free tier: 5 calls/minute, 500/day. The cron uses 1 call at midnight (daily) and 1 call per hour (practice), well within limits.

---

## Environment Variables

| Variable | Required | What it does |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Railway sets this automatically) |
| `JWT_SECRET` | Yes | Secret key for signing JWT tokens. Any random long string. |
| `PORT` | No | Server port (Railway sets this, defaults to 3000 locally) |
| `ADMIN_EMAIL` | No | Email for the auto-created admin account |
| `ADMIN_PASSWORD` | No | Password for the admin account |
| `ALPHA_VANTAGE_KEY` | No | API key for real chart data (free at alphavantage.co) |
| `STRIPE_SECRET_KEY` | No | Stripe API secret key |
| `STRIPE_PRICE_ID` | No | The Stripe Price ID for the $3.99/mo plan |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `RESEND_API_KEY` | No | Resend.com API key for sending emails |
| `EMAIL_FROM` | No | Sender email (default: noreply@chartle.app) |
| `BASE_URL` | No | Your app's public URL (for email links) |
| `FRONTEND_URL` | No | Frontend URL for CORS and redirects |
| `FREE_PRACTICE_PER_DAY` | No | Practice limit for free users (default: 3) |
| `DB_SSL` | No | Set to "false" to disable SSL (for local dev) |

---

## Common tasks

### "I want to add a new feature that stores data"

1. Add a column (`ALTER TABLE ... ADD COLUMN`) or a new table (`CREATE TABLE`) in `db.js` → `initSchema()`
2. Write query functions in `db.js` (get, create, update, delete)
3. Export them at the bottom of `db.js`
4. Add API endpoints in `index.js` that call your `db.xxx()` functions
5. Call those endpoints from the frontend using `window.apiFetch()`

### "I want to test an endpoint locally"

```bash
# Start the server
npm run dev

# Test with curl
curl http://localhost:3000/api/chart/daily

# Test authenticated endpoint
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" http://localhost:3000/api/journal
```

### "I want to look at the database directly"

In Railway dashboard → click your Postgres service → "Data" tab → SQL query editor. Or use any Postgres client (pgAdmin, DBeaver, TablePlus) with the connection string from Railway.

```sql
-- See all users
SELECT id, email, username, subscription_status, created_at FROM users;

-- See journal entries for a user
SELECT * FROM journal_entries WHERE user_id = 'abc123' ORDER BY seed DESC;

-- Count consensus votes for today
SELECT COUNT(*) FROM consensus_votes WHERE seed = 20260317;

-- See practice usage today
SELECT * FROM practice_sessions WHERE date_key = '2026-03-17';
```

### "I want to run the server locally"

```bash
# 1. Create a .env file in the project root:
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=any-random-string-here
ADMIN_EMAIL=you@email.com
ADMIN_PASSWORD=yourpassword

# 2. Install dependencies
npm install

# 3. Start
npm run dev    # with auto-reload (nodemon)
npm start      # without auto-reload
```

You can point `DATABASE_URL` at your Railway Postgres (get the URL from Railway dashboard → Postgres service → "Connect" tab) or run Postgres locally.
