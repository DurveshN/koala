import { expect, test } from "bun:test"

test("bundles the complete Koala contract surface for browsers", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/../index.ts`],
    target: "browser",
    format: "esm",
    packages: "bundle",
  })

  expect(bundle.success).toBe(true)
  if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"))
  const output = bundle.outputs[0]
  if (!output) throw new Error("Browser bundle did not produce an output")
  expect(await output.text()).not.toMatch(/(?:from|require\()["'](?:node:|fs|path|child_process|crypto|stream)/)
})
