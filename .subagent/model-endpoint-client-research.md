# Model Endpoint Client Research

## Objective

Identify a connection-time enforcement mechanism for Koala model endpoints that
does not rely on a separate DNS check followed by ordinary fetch.

## Findings

- The default fetch-backed client can follow redirects and resolve a hostname
  again after validation.
- Environment proxy support can delegate destination resolution outside the
  application's policy boundary.
- Node HTTP/HTTPS requests accept a custom lookup callback while preserving the
  original hostname for HTTP Host, TLS SNI, and certificate checks.
- The AI SDK OpenAI-compatible provider accepts a custom fetch function, making
  a bound transport reusable for inference after discovery integration.

## Decision

Use a sidecar service bound to one provider ID and base URL. Each request must
match the authorized origin and base path. Each new socket resolves all DNS
answers, validates the complete set, and returns one approved address directly
to the socket callback. Redirects are rejected and connections do not use the
environment proxy.

## Limitations

- Initial transport disables pooling so every connection receives fresh DNS
  authorization.
- TLS behavior relies on Node defaults and the host trust store; no insecure TLS
  override is available.
- Host firewall policy remains an independent deployment control.
