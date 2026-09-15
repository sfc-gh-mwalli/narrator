# Security

This project is published **as-is**, as a reference implementation. It is not a
supported product and receives no security maintenance or patch guarantees.

## Reporting a vulnerability

Please **do not** open a public issue or pull request to report a security
concern.

Use GitHub's private reporting flow: **Repository → Security → Report a
vulnerability**.

## What to keep in mind when deploying this

Narrator is a template you deploy into your own Snowflake account, so its
security posture is mostly determined by how you configure it.

- **Credentials never belong in the repository.** Local development reads
  `~/.snowflake/connections.toml`; in Snowpark Container Services the worker
  authenticates with the injected OAuth token at
  `/snowflake/session/token`. `.gitignore` excludes `.env` files and the
  `snowflake-ca.crt` build input. There are no credentials in this repository
  and none should be added.
- **The app grants whatever its own role grants.** Any user who can reach the
  application service endpoint acts with the service's privileges. Grant
  `USAGE` on the application service deliberately.
- **Voice enrollment audio and generated narration are personal data.** They
  live in internal Snowflake stages, encrypted with `SNOWFLAKE_SSE`. Treat a
  voice recording with the same care as any other biometric identifier, and
  apply your own retention policy — this project does not delete anything on a
  schedule.
- **Generated audio is not watermarked.** See "Responsible use" in `README.md`.
