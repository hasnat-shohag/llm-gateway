# Vendored gateway source

These `.ts` files are a copy of the gateway's `src/` from
`https://github.com/hasnat-shohag/llm-gateway-for-claude-code`, so this repository builds and
runs without a second checkout beside it.

**Copied from:** commit `f58f4873bc9aa823dc55d54e9007891f24290cd1` (branch `feat/desktop-app`,
2026-08-31).

**Local divergence:** `provider-manager.ts`, `proxy.ts`, `config.ts`, `types.ts`,
`usage-tracker.ts`, `server.ts` and `openai-adapter.ts` no longer match that commit. They carry the
`compatibility` routing field, the ordered attempt phases, and the Anthropic ⇄ Chat Completions
translation ported from `~/llm-gateway-for-claude-code` branch `feat/openai-compatible-providers`
(that branch's `protocol`/`models`/`tier` vocabulary was deliberately not adopted).
`openai-adapter.ts`, `external-pricing.ts` and `external-pricing-data.ts` have no upstream
counterpart at the pinned commit. The external-pricing pair sources non-Anthropic model prices
from llmpricing.dev (generated snapshot + lazy per-model fetch, persisted beside `usage.db`);
`usage-tracker.ts` consults it after its own Anthropic table, and `server.ts` exposes the
read-only `GET /pricing` over it plus `POST /pricing/refresh`, which re-resolves given
models against the live site so price changes apply without a new snapshot. Re-copying the
pinned commit would silently drop all of it — diff before refreshing.

## Rules

- **Do not edit these files to change gateway behavior.** Fix it upstream, then re-copy. The whole
  point of `main/schema.js` importing `build/gateway/config.js` is that the app validates against
  the gateway's *real* zod schema; a local divergence here defeats that.
- `*.test.ts` is deliberately not vendored — those tests need `tsx`, which this app does not
  install. Run them in the upstream repo.
- Refreshing the copy is a plain file copy plus a version bump of the commit above:

  ```bash
  cp /path/to/llm-gateway-for-claude-code/src/*.ts gateway-src/
  rm -f gateway-src/*.test.ts
  npm run typecheck && npm test
  ```

- `providersArraySchema` must stay exported from `config.ts`; `main/schema.js` fails loudly if it
  does not.
- `tsconfig.json` here mirrors the upstream compiler options (ESM, `moduleResolution: bundler`,
  `verbatimModuleSyntax`), which is why the imports carry `.js` extensions on `.ts` files. Keep
  the two in step when upstream changes them.
