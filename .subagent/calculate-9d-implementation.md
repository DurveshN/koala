# Calculate Phase 9D Implementation

## Scope

Implemented and registered the deterministic `calculate` V1 industrial tool.

## Components

- Bounded tokenizer and Pratt parser with source spans and right-associative
  powers.
- Isolated `decimal.js@10.5.0` arithmetic with canonical decimal output.
- Percentages, bounded function dispatch, dimensional units, and conversions.
- Distinct source-unit suffix powers, so `2 m^2` differs from `(2 m)^2`.
- Own-property function and unit lookup resistant to prototype identifiers.
- One generator-based evaluator shared by synchronous and cooperative Effect
  entry points.
- Interruptible OpenCode adapter with caller-cancellation and deadline
  classification through the shared Industrial Execution boundary.
- Durable redacted audit records and bounded model projections.

## Verification

- Koala complete suite: 429 passed.
- OpenCode combined document/industrial/sandbox/calculator suite: 121 passed.
- Calculator-focused hostile, span, boundary, cancellation, and deadline suites
  passed repeatedly.
- Koala and OpenCode typechecks passed.
