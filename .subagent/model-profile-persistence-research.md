# Model Profile Persistence Research

## Objective

Choose the first durable storage boundary for complete Koala model profiles.

## Decision

Use a versioned JSON repository owned by the sidecar at:

```text
<Global.Service.data>/koala/model-profiles.json
```

Expose authenticated global CRUD routes. The Desktop accesses profiles through
the sidecar rather than Electron storage.

## Reasons

- The current profile set is a small global aggregate read as a collection.
- V1 config deep-merge semantics are unsuitable for exact create/update/delete.
- Electron storage is not readable by the selected sidecar runtime.
- A dedicated Koala SQLite database is premature before audit, artifact,
  routing-history, and knowledge tables exist.
- Versioned JSON supports strict validation and a later explicit SQLite
  migration.

## Required Storage Properties

- Missing file means an empty collection.
- Malformed and unknown-version files fail visibly.
- Cross-process lock around read-modify-write operations.
- Canonical schema encoding strips unknown credential-like fields.
- Same-directory temporary write, owner-only permissions where supported,
  atomic rename, and temporary cleanup.
- Stable provider-ID ordering.

## Migration

Existing custom OpenCode providers cannot be converted silently because they do
not contain complete capability, role, priority, or limit information. A future
import flow must prefill known fields and require user confirmation.
