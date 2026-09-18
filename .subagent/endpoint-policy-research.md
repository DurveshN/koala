# Endpoint Policy Research

## Objective

Define a local/private model endpoint boundary that remains valid at socket
connection time rather than relying only on URL syntax.

## Findings

- Existing profile validation accepted any absolute HTTP or HTTPS URL.
- The global fetch client can follow redirects and resolve DNS after a separate
  validation check.
- No existing application-owned private-address or cloud-metadata policy was
  available.
- AI SDK providers accept a custom fetch implementation, which is the intended
  inference integration seam.
- A secure sidecar transport needs a custom DNS lookup callback so the checked
  address is the address used by the socket while the original hostname remains
  available for HTTP Host and TLS SNI/certificate validation.

## Decision

Use two layers:

1. Browser-safe URL, IP, resolution-set, request-scope, and redirect policy in
   `@koala-ai/core`.
2. A sidecar-only scoped transport that resolves and pins approved addresses,
   rejects redirects, and avoids environment proxy routing.

Allowed ranges are IPv4 loopback and RFC1918 plus IPv6 loopback and ULA. Public,
link-local, multicast, unspecified, CGNAT, reserved, metadata, IPv4-mapped IPv6,
empty DNS, and mixed DNS results are denied.

## Limitations

Application policy does not replace an organization firewall or independent
packet monitor. Transparent proxies, compromised DNS, and operating-system
routing remain separate infrastructure concerns.
