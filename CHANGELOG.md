# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `KORA_USAGE_LOG_PATH`: provider-call JSONL accounting for OpenAI-compatible
  and AI Gateway models, including usage before structured-output validation,
  response model identity, and explicit missing-usage records without content
  or credentials.
- `NativeRunnerModel`: route `kora-app-*-android` slugs through a native runner.
- 104 strict scenarios dataset (`data/104-scenario-apps.strict.jsonl`) plus
  accompanying README documentation.
- `kora-tester` MCP server configuration (`.mcp.json`).

### Fixed

- Usage-log write failures stop model retries, fallbacks, and benchmark
  processing. The CLI exits with status 73 rather than continuing paid calls
  with broken accounting.
- Scenario upload: relax the `seed.context` size cap and clean stale
  `modelMemory` from the 104-apps dataset.
