#!/usr/bin/env bun
import { $ } from "bun"

import { buildDevelopmentDocumentRuntime, prepareOrVerifyReleaseDocumentRuntime } from "./document-runtime"
import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
if (channel === "dev") {
  await buildDevelopmentDocumentRuntime()
  await downloadCliToResources()
} else {
  await prepareOrVerifyReleaseDocumentRuntime()
}
