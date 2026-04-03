# QuizFortress

A Blooket-inspired multiplayer quiz website with a server-authoritative game loop and anti-cheat protections designed to be much harder to exploit through browser DevTools.

## Security approach

- Server-authoritative scoring, streaks, and powerup activation
- Signed player session tokens (HMAC SHA-256)
- WebSocket authentication timeout and payload-size caps
- Rate limits for HTTP routes and socket messages
- Suspicious behavior strike system (spam, duplicate answers, impossible timing)
- No client-side answer authority (correct answers never trusted from browser)
- Helmet headers + strict CSP baseline

## Features

- Host and join via room codes
- Real-time lobby updates
- Timed quiz rounds over WebSocket
- Dynamic scoring (speed + streak + difficulty)
- Simple powerup system (2x points round)
- Live leaderboard and winner reveal
- Host transfer when host disconnects

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm run dev
```

3. Open http://localhost:3000

## Deploy on Render (free tier)

### Option A: Blueprint deploy (recommended)

1. Push this project to GitHub.
2. In Render, select New + and choose Blueprint.
3. Point to your repository (Render reads `render.yaml`).
4. Deploy.

### Option B: Manual Web Service

1. New Web Service from your repo.
2. Runtime: Node
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add environment variables:
   - `TRUST_PROXY=true`
   - `SESSION_SECRET=<long random secret>`
   - Optional: `APP_ORIGIN=https://your-app-name.onrender.com`

## Hardening notes

- Keep all game logic and random reward logic on the server.
- Never add score updates based only on client event payloads.
- If you add a database later, store server-side audit events for suspicious sessions.
- Use HTTPS only in production so WebSocket upgrades happen over `wss://`.

## Important reality check

No browser game can be truly unhackable. This architecture focuses on making common cheat scripts fail by ensuring the browser does not control trusted game state.
