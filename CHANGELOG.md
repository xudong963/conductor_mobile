# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-04-07

### Added

- Added chat model and thinking-effort pickers so Telegram users can choose how new chats start.
- Added model registry coverage and integration tests around model-aware chat startup.

### Fixed

- Fixed desktop Codex chat resume compatibility so resumed chats do not stall when restoring state.

### Changed

- Refined Telegram chat startup flow and bridge state handling to support the new model-selection path.
