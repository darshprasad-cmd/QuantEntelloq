# Contributing to Quant Entelloq

## Workflow
1. Read `AGENTS.md`, `ARCHITECTURE.md`, and `CRITICAL_AREAS.md`.
2. Create one focused branch: `feat/<topic>`, `fix/<topic>`, `refactor/<topic>`, `docs/<topic>`, or `chore/<topic>`.
3. Inspect and explain the existing flow before editing.
4. Keep the change scoped and add regression coverage where behavior changes.
5. Run the checks below and review the final diff for unexpected side effects.
6. Open a PR; do not push directly to `main`.

Use Conventional Commit subjects such as `feat(portfolio): add position notes` or `fix(auth): preserve refresh cookie`.

## Setup and checks
Frontend:
```bash
python -m http.server 8000
python -m unittest discover -s tests
node --check js/app.js
node --check js/app.min.js
```

Backend:
```bash
cd backend
npm install
npm run lint
npm test
```

The backend currently has no typecheck or build script. Do not claim those checks ran. A reproducible lockfile is still needed; until one is committed, CI uses `npm install` rather than `npm ci`.

## Pull requests
PRs should state the problem, root cause or design intent, changed files, checks run, screenshots for visible UI changes, configuration/migration impact, unexpected side effects reviewed, and remaining risks.

A change is done when its acceptance criteria pass, relevant tests and CI pass, UI changes are browser-checked at desktop and narrow widths, documentation is current, no secrets or unrelated edits are present, and high-risk changes have explicit review.
