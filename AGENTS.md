# Quant Entelloq agent instructions

## Scope and priorities
- Preserve existing behavior and the current visual identity unless the task says otherwise.
- Inspect nearby code and reuse existing patterns before introducing new abstractions.
- Keep changes scoped. Do not edit generated or vendored files unless the task requires it.
- Never commit credentials. Use `backend/.env` locally and document new variables in `backend/.env.example`.
- Read `ARCHITECTURE.md` before changing data flow, auth, persistence, AI providers, realtime behavior, or deployment.

## Repository model
- The browser app is a vanilla-JS static SPA: `index.html`, `js/app.js`, and assets.
- `js/app.min.js` is the served minified counterpart of `js/app.js`. Make source changes in `js/app.js`, then regenerate the minified file when frontend behavior changes.
- `backend/` is a Node.js 20 ESM service backed by Postgres and Redis.
- Avoid editing vendored `js/lightweight-charts.min.js`.

## Setup and common commands
Frontend:
```bash
python -m http.server 8000
```
Then open `http://localhost:8000`.

Backend:
```bash
cd backend
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev
```
Use `docker compose up --build` from `backend/` when Postgres and Redis are not already available.

## Verification
For backend changes, run from `backend/`:
```bash
npm run lint
npm test
```
There is currently no backend build or typecheck script; do not claim those checks ran.

For frontend changes:
- Regenerate `js/app.min.js` using the command documented in `.gitignore`.
- Serve the repository over HTTP and smoke-test the affected flows in a browser.
- Check the browser console and at least one narrow/mobile viewport.
- If server mode is affected, test both standalone/static behavior and the API-backed path.

## Fragile boundaries
- Auth uses signed cookies, access/refresh JWTs, session revocation, CORS, and rate limits. Preserve all security controls.
- Database access belongs in `backend/db/repositories/`; route handlers should stay thin.
- AI calls must continue through `backend/services/ai.js`; never expose provider keys to frontend code.
- Realtime behavior spans Socket.io, SSE, and the optional Polygon/Massive websocket.
- Keep API response shapes backward-compatible unless a coordinated frontend migration is part of the task.

## Completion
- Fix failures caused by the change.
- Report commands run, tests performed, and any checks that could not run.
- Summarize changed files and call out migrations, configuration changes, and deployment steps.
