# Analytics contract

No canonical PostHog instrumentation was found on the default branch when this document was created. Treat that as an intentional baseline: do not add analytics ad hoc.

Before adding instrumentation:
1. Define the product question and event owner.
2. Add the event to the catalog below.
3. Keep capture calls behind one analytics adapter rather than mixing them into product logic.
4. Avoid secrets, raw prompts, financial holdings, tokens, email addresses, and other sensitive payloads.
5. Verify consent and environment behavior before production use.

## Naming
Use lowercase `object_action` names, for example `portfolio_created`. Prefer stable domain language over UI labels. Properties use `snake_case`, must have documented types, and must not duplicate identity data.

## Event catalog
| Event | Trigger | Properties | Owner | Status |
|---|---|---|---|---|
| _None yet_ | | | | |

Any rename or semantic change requires a migration note in `docs/DECISIONS.md`.
