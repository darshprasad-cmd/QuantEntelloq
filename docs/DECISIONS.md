# Architecture decisions

Record durable decisions here before or with the implementation. Include status, context, decision, alternatives, consequences, and date.

## Accepted: static-first frontend with optional server mode
The root SPA remains usable as a static application. Authenticated and persistent capabilities route through the backend only when server mode is enabled. Changes must preserve both paths unless a reviewed migration retires one.

## Accepted: Postgres is authoritative; Redis is disposable
Postgres owns durable product data. Redis supports caching, queues, and revocation coordination and must not become the sole store for durable user state.

## Accepted: AI providers stay behind the backend adapter
Frontend code never receives provider credentials. Provider selection and request behavior remain centralized in `backend/services/ai.js`.

## Proposed decisions
Add new entries above implementation for analytics adoption, database migrations, auth changes, billing, major data-provider changes, or a frontend architecture migration.
