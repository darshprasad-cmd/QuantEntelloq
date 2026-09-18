# Critical areas

## High-risk areas
- Authentication, cookies, JWT issuance/rotation, OAuth, session revocation, CORS, and rate limits
- Production database schema, migrations, seed behavior, and repository queries
- Portfolio, transaction, payment, or subscription data
- AI provider calls, prompts, model selection, and cost/privacy boundaries
- Realtime feeds, queues, ingestion, market-data integrations, and financial signal logic
- Deployment files, environment variables, custom domains, and production API configuration
- Analytics or user-tracking instrumentation
- Minification and synchronization between `js/app.js` and `js/app.min.js`

Changes in a high-risk area require all of the following before merge:

1. Explain current behavior and ownership boundaries.
2. Propose the smallest modification and list affected files.
3. Describe regression, security, privacy, scientific, and operational risks.
4. Add or update meaningful tests, or document why automation is not currently possible.
5. Run every relevant repository check.
6. Report unexpected side effects considered.
7. Receive explicit human review. Codex must not merge or deploy these changes autonomously.

Financial outputs must not silently change units, formulas, data sources, or confidence semantics. Never place provider keys or server secrets in frontend code.
