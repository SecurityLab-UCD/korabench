# AGENTS.md — Project context for coding agents

## Development workflow

- Refresh context from `docs/` and the active plan in `plans/` before editing.
- Always write unit tests for new features; for bugs, write a regression test
  first to reproduce, then fix.
- Document new features in `docs/`.

## Plans, PRs, versioning

- Use `plans/` for non-trivial work. New features ALWAYS get a plan committed
  for review before implementation.
- A plan must contain: problem background, proposed solution, implementation
  steps. Once fully implemented, rewrite as a design doc under `docs/` and
  remove from `plans/`.
- The project follows [Semantic Versioning](https://semver.org/) — version
  lives in `pyproject.toml`.
- **Patch bump per PR**: every non-chore PR bumps the patch version.
- **Minor bump**: when cutting a release (alpha → beta, beta → stable).
- **Major**: reserved for breaking public-interface changes.
- The current release track is `0.1.x` (pre-beta).

### CHANGELOG

Follow [Keep a Changelog](https://keepachangelog.com/). Group entries under
`Added`, `Changed`, `Fixed`, `Removed`. Every non-chore PR adds an entry under
`## [Unreleased]`.

## Code review

When asked to review a PR on this repo, read the linked plan and PR description
first. Comment, request changes, or approve directly on GitHub. Use the PR
comment thread for design discussion and for follow-ups after fixing requested
changes.
