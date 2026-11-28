# CLAUDE.md — Engineering Contract for Headroom

```autopilot
runtime: node
language: TypeScript
framework: Cloudflare Workers + Scriptable + Rust
package_manager: npm
node_version: 24
```

## Canonical Commands

```autopilot
install: npm ci
typecheck: npm run typecheck
lint: npm run typecheck
test: npm test
test_single: node --test {file}
test_coverage: node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info "packages/*/test/**/*.test.ts"
coverage_output: coverage/lcov.info
coverage_exclude:
  - "packages/*/test/**"
  - "scripts/**"
```

## Test File Conventions & Gate 1 (Test-Files-Only) Regex

```autopilot
test_file_regex: ^packages/[^/]+/test/.*\.test\.ts$
```

- TypeScript unit tests use built-in `node:test` and `node:assert/strict` under `packages/<pkg>/test/*.test.ts`.
- All comments, test names, identifiers, commit messages, and user-facing strings must be written in **English**.
- Tests must run 100% offline with deterministic fixtures and mocks; never make live network calls or invoke external CLIs.

## Security-Critical Paths & High-Scrutiny Areas

```autopilot
security_critical_paths:
  - "packages/worker/src/auth.ts"
  - "packages/worker/src/sanitize.ts"
  - "packages/worker/migrations/**"
  - "agent/src/providers/**"
  - "scripts/package-*"
  - ".github/workflows/**"
```

## Per-Layer Bot Constraints

- **Layer 2 (Nightly Tests):** Modify or create ONLY `packages/<pkg>/test/*.test.ts` files. Never modify production files or weaken existing assertions.
- **Layer 4 (`ai-fix`):** Keep diffs minimal and surgical; never modify D1 migrations, `auth.ts`, `sanitize.ts`, or `agent/src/providers/**`.
- **Layer 5 (`ai-prototype`):** Keep changes under 300 lines with direct unit test assertions (`feature_flag_mechanism: none` in `PRODUCT.md`), stay strictly within Cloudflare Workers and D1 Free Plan limits, and never read or store credentials or local file paths.
