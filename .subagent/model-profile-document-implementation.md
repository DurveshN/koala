# Model Profile Document Implementation

## Objective

Add a versioned persistence contract for collections of validated Koala model provider profiles.

## Files

- `packages/koala/src/model/profile-document.ts`
- `packages/koala/src/model/profile-document.test.ts`
- `packages/koala/src/index.ts`
- `.subagent/model-profile-document-implementation.md`

## Decisions

- Use the literal version `1` so missing and unsupported document versions fail decoding.
- Reuse `ModelProfile.Provider` for every profile so the existing nested provider and model validation remains authoritative.
- Reject duplicate provider IDs at the document boundary while allowing an empty profile collection.
- Expose a frozen `empty` value whose document and profile array are immutable at runtime and readonly in the schema type.
- Rely on Effect Schema's default excess-property stripping during decoding, then encode the decoded value for canonical persistence. Unknown raw credential-like fields are not retained.
- Preserve the existing uncommitted `ModelProviderConfig` root export while adding `ModelProfileDocument`.

## Tests And Results

- Tests cover the immutable empty document, a complete encode/decode round trip, duplicate provider IDs, unsupported and missing versions, nested model validation, and removal of unknown credential-like fields from canonical encoding.
- `bun test`: 42 passed and 0 failed from `packages/koala`.
- `bun typecheck`: passed from `packages/koala`.
- `git diff --check`: passed from the repository root.

## Risks

- Version `1` has no migration path by design; later document versions require an explicit schema and migration boundary.
- Runtime freezing applies to the canonical empty value. Other decoded documents are readonly at the type level but are not deeply frozen at runtime.
- Excess-property stripping depends on Effect Schema's default parse options; callers that explicitly preserve excess properties must still persist a canonical encoding produced from the standard decoded contract.
