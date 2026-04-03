# Quizzy

A Blooket-inspired multiplayer quiz website with server-authoritative anti-cheat controls, real persistent host accounts, guest joining, profile customization, and multiple game modes.

## What changed

- Project renamed to Quizzy
- Hosting requires creating and logging into an account
- Guests can still join without an account
- Guests can pick profile options when joining (avatar, frame, title, glow color)
- Added game modes:
  - Classic Clash
  - Lightning Rush
  - Chaos Jackpot

## Do you need Postgres?

Yes. If you want actual accounts that survive restarts and redeploys on Render, you need a database. Free Render web services have an ephemeral filesystem, so in-memory accounts disappear as soon as the service restarts or spins down. Render Postgres is the right choice here.

## Security approach

- Server-authoritative scoring, streaks, and game mode multipliers
- Signed account tokens and signed room-session tokens (HMAC SHA-256)
- Password hashing with PBKDF2 + per-user salt
- WebSocket authentication timeout and message-size limits
- HTTP and WebSocket rate limits
- Suspicious action strike system
- Helmet headers + strict CSP baseline

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm start
```

3. Open http://localhost:3000

## Deploy on Render (free tier)

### Option A: Blueprint deploy

1. Push this project to GitHub.
2. In Render, create a new Blueprint from your repo.
3. Render reads `render.yaml` automatically.
4. Deploy.

### Option B: Manual web service

1. Create a new Web Service from your repo.
2. Runtime: Node
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment variables:
   - `TRUST_PROXY=true`
   - `SESSION_SECRET=<long random secret>`
  - `DATABASE_URL=<your Render Postgres connection string>`
   - Optional: `APP_ORIGIN=https://your-app-name.onrender.com`

If you use Render Blueprint, create or attach a Postgres database and wire its connection string into `DATABASE_URL`.

## Important note

No browser game is perfectly unhackable. Quizzy reduces common DevTools cheats by keeping all trusted state and scoring logic on the server.
