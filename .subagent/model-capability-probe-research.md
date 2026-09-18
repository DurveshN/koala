# Model Capability Probe Research

## Objective

Design active, local-only tests for model capabilities left as `Unknown` in a
Koala profile.

## Classification Decision

- `Yes`: exact nonce and feature-specific response shape were observed.
- `No`: after a verified text baseline, the endpoint returned a controlled
  feature-request rejection such as 400, 405, 413, 415, or 422.
- `Unknown`: model behavior was ambiguous or auth, policy, timeout, transport,
  parsing, rate limiting, or server state blocked measurement.

The suite runs a text control first and stops dependent probes when that control
is not verified. Remaining requested probes run sequentially: streaming, tool
calling, structured output, image input, then reasoning.

## Probe Evidence

- Text and streaming require an exact random nonce.
- Tool calling requires one forced function call with exact JSON arguments.
- Structured output requires a direct JSON object matching a strict JSON Schema.
- Image input uses a locally generated metadata-free PNG containing a random
  visual hexadecimal nonce that is absent from prompt text.
- Reasoning requires the correct nonce-bound answer plus observable compatible
  reasoning metadata or a positive reasoning-token count.

No probe executes a returned tool, follows a redirect, fetches an external
image, retries automatically, or persists credentials/profile state.

## Limitations

One successful request establishes only the observed request shape. It does not
establish consistent behavior for every prompt, deployment state, model build,
or future server version.

AI behavior is not guaranteed and may vary.
