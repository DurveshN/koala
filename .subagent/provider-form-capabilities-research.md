# Provider Form Capabilities Research

## Objective

Map the existing custom provider form to Koala's complete model-profile contract
without replacing OpenCode's current UI structure.

## Findings

- The current form collects provider ID, name, base URL, optional API key,
  model ID/name pairs, and optional headers.
- Existing `TextField`, `Select`, `Checkbox`, and `Switch` components cover the
  required controls; no new UI primitive is needed.
- Numeric form values should remain strings while editing and be parsed during
  validation.
- Tri-state capabilities should use selects. Roles should use a fixed checkbox
  group. Enabled state should use a switch.
- OpenCode V1 config can retain model limits, input modalities, tool-calling,
  and reasoning flags.
- OpenCode V1 config cannot retain streaming, structured-output status, roles,
  Koala enabled state, priority, or unknown capability values.
- Complete Koala profiles therefore require an independent persistence boundary
  before the form can truthfully save every field.
- The App can depend on `@koala-ai/core` without creating a package cycle.

## Recommended UI Shape

Keep the existing model ID/name row. Add context and output limits, six
tri-state capability selects, a role checkbox group, enabled switch, and
priority field beneath it inside the existing scroll container.

## Risks

- Adding localization keys requires parity across every locale dictionary.
- Saving only the V1 projection would silently discard routing metadata.
- Current save success does not establish endpoint reachability.
