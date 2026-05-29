# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `NativeRunnerModel`: route `kora-app-*-android` slugs through a native runner.
- 104 strict scenarios dataset (`data/104-scenario-apps.strict.jsonl`) plus
  accompanying README documentation.
- `kora-tester` MCP server configuration (`.mcp.json`).

### Fixed

- Scenario upload: relax the `seed.context` size cap and clean stale
  `modelMemory` from the 104-apps dataset.
