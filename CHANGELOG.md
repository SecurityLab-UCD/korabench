# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `kora generate-conversations`: judge-free conversation generation with
  validated, atomically persisted transcripts, identity-checked restart and
  existing provider usage accounting.
- `bigmodel-glm-5`: direct GLM-5 terminal judge through `GLM_API_KEY` and
  `GLM_BASE_URL`, with a 16,000-token cap and strict local grade validation.
- `kora run --skip-mechanisms`: grade the safety call only. The mechanism
  judge call is skipped; per-test results omit `mechanismAssessment` and run
  sums carry no mechanisms. The safety call and its prompt are unchanged.
- `KORA_USAGE_LOG_PATH`: provider-call JSONL accounting for OpenAI-compatible
  and AI Gateway models, including usage before structured-output validation,
  response model identity, and explicit missing-usage records without content
  or credentials.
- `NativeRunnerModel`: route `kora-app-*-android` slugs through a native runner.
- 104 strict scenarios dataset (`data/104-scenario-apps.strict.jsonl`) plus
  accompanying README documentation.
- `kora-tester` MCP server configuration (`.mcp.json`).

### Fixed

- Attribute durable provider usage to target, simulated-user, or judge roles,
  including concurrent calls with the same model ID. Generic generation calls
  remain unassigned; role metadata does not change routing or provider requests.
- Usage-log write failures stop model retries, fallbacks, and benchmark
  processing. The CLI exits with status 73 rather than continuing paid calls
  with broken accounting.
- Scenario upload: relax the `seed.context` size cap and clean stale
  `modelMemory` from the 104-apps dataset.
