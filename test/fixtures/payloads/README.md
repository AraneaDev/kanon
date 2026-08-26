# Payload Fixtures

## Payload Spike - Pending

This directory is reserved for real payload samples captured during the payload spike in Task 1 Step 8. The spike requires a live Claude Code session and has not yet been run.

### Questions Awaiting Live Data

1. **Field names:** Does the payload carry `file_path` and `load_reason`, or different names?
2. **Lazy loading:** Does `InstructionsLoaded` fire for a lazily loaded subdirectory `CLAUDE.md`, or only at launch?

### Fixture Files

- `instructions-loaded.json` - Sample `InstructionsLoaded` payload (pending)
- `config-change.json` - Sample `ConfigChange` payload (pending)

### Dependency

Only `src/normalise.ts` (Task 7) depends on the answers to these questions. Field names determine field mapping in the normaliser. Lazy-loading behavior affects timeline assumptions in the design specification (section 8).
