# Sites adapter (NOT IMPLEMENTED — stub only)

This directory is where the ChatGPT Sites persistent-DB implementation of
`AuthRepository` and `GameRepository` (see `../types.ts`) goes.

Do NOT invent a fake Sites API. When the real Sites DB API is known,
implement `SitesAuthRepository` / `SitesGameRepository` here and register
them in `src/lib/server/repo.ts` under `BACKEND_MODE=sites`.

See `docs/SITES_HANDOFF.md` for the full migration plan.
