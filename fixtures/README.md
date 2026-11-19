# fixtures

Raw provider responses, used by the normalization tests, and shared snapshots read by both the agent and the server tests.

- `*.sample.json` — **synthetic data**, shaped after official documentation and community implementations. It may differ from the real shape.
- Other provider responses (`claude/`, `codex/`, without `sample`) — **captured from real devices**. Tokens, account IDs, email addresses and organization UUIDs are replaced with `"<redacted>"` before being added. Text that only describes the machine it was captured on (request counts, session counts, tool or server names) is replaced with synthetic values of the same shape.
- `snapshot/` — **synthetic** snapshots and uploads in Headroom's own format, read by the Rust and TypeScript tests alike.
- `raw/` — temporary location before masking. Git-ignored; never commit it.

When real data becomes available, compare it with the `.sample.json` of the same name and point the tests at the real data.
