# fixtures

Raw provider responses, used by the normalization tests.

- `*.sample.json` — **synthetic data**, shaped after official documentation and community implementations. It may differ from the real shape.
- `*.json` (without `sample`) — **captured from real devices**. Tokens, account IDs, email addresses and organization UUIDs are replaced with `"<redacted>"` before being added.
- `raw/` — temporary location before masking. Git-ignored; never commit it.

When real data becomes available, compare it with the `.sample.json` of the same name and point the tests at the real data.
