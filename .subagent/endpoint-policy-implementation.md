# Koala Endpoint Policy Implementation

## Scope

Implemented the pure, browser-safe local endpoint policy in `packages/koala`.
No DNS lookup, socket, request, redirect-following, or App integration is part
of this change.

## Files

- `packages/koala/src/network/endpoint-policy.ts`: typed parsing, address
  classification, resolution authorization, request scope authorization, and
  redirect status policy.
- `packages/koala/src/network/endpoint-policy.test.ts`: endpoint policy unit
  coverage.
- `packages/koala/src/model/profile.ts`: delegates `BaseURL` validation to
  `EndpointPolicy.parseBaseURL`.
- `packages/koala/src/model/profile.test.ts`: covers profile-level endpoint
  policy validation.
- `packages/koala/src/index.ts`: exports the `EndpointPolicy` namespace.
- `packages/koala/package.json`: exports network modules and declares
  `ipaddr.js` as a direct runtime dependency.
- `bun.lock`: records the direct `ipaddr.js` dependency.

## Rules

- Base URLs must be absolute HTTP or HTTPS URLs without credentials, query,
  fragment, wildcard hostname, empty hostname, port zero, IPv6 zone ID, raw
  control characters, or backslashes.
- Hostnames are normalized to lowercase without a trailing root dot and remain
  pending DNS authorization. Known metadata hostnames are denied immediately.
- Legacy IPv4 integer, hexadecimal, octal, shortened, leading-zero, and
  percent-encoded hostname forms are denied. IPv6 literals are emitted in
  compact canonical form.
- Allowed IPv4 ranges are `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, and
  `192.168.0.0/16`. Allowed IPv6 ranges are `::1/128` and `fc00::/7`.
- Unspecified, link-local, multicast, carrier-grade NAT, public, reserved,
  metadata, and IPv4-mapped IPv6 addresses are denied.
- Metadata identifiers include `instance-data`, the documented cloud metadata
  hostnames, and provider metadata addresses including `fd00:ec2::23`,
  `fd00:ec2::254`, and `fd20:ce::254`. They are denied before general
  private/ULA classification.
- DNS authorization rejects empty answers, invalid address families,
  family/address mismatches, mixed allowed and denied answers, and non-loopback
  answers for `localhost` and `*.localhost`. Successful answers are canonical,
  deduplicated, and represented as a non-empty tuple.
- Request authorization requires the same protocol, canonical hostname, and
  effective port. It permits only the exact base path or slash-delimited
  descendants and rejects request credentials.
- Redirect statuses are all integer HTTP status values from 300 through 399.

## Dependency And License

- Added `ipaddr.js@2.5.0` with Bun as a direct runtime dependency of
  `@koala-ai/core`.
- The installed package declares the MIT license. Its license file identifies
  copyright `(C) 2011-2017 whitequark <whitequark@whitequark.org>` and contains
  the MIT permission and warranty terms.
- `THIRD_PARTY_NOTICES` was not changed.

## Verification

- `bunx prettier --write ...` from `packages/koala`: completed.
- `bun test` from `packages/koala`: 139 passed, 0 failed, 169 assertions.
- `bun typecheck` from `packages/koala`: passed.
- `git diff --check` from the repository root: passed.

## Limitations

- The module is policy-only. A caller must perform DNS resolution, pass every
  answer to `authorizeResolution`, connect using the authorized result, and
  apply `authorizeRequest` plus fresh resolution authorization to each redirect
  target.
- Hostnames cannot be accepted as local/private based on syntax alone; they are
  intentionally pending until DNS answers are supplied.
- `ModelProfile.BaseURL` validates through the policy but preserves the input
  string. Consumers that need canonical endpoint fields must call
  `parseBaseURL`.
- App form validation remains unchanged for this task.
