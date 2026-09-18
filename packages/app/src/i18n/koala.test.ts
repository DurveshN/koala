import { describe, expect, test } from "bun:test"
import { ENGLISH_DICTIONARY } from "@/context/language"
import { dict as de } from "./de"
import { dict as en } from "./en"
import { dict as koala } from "./koala"

describe("Koala i18n fallback", () => {
  test("includes dedicated Koala copy in the English base dictionary", () => {
    const entries = Object.entries(koala)
    expect(entries.length).toBeGreaterThan(0)
    entries.forEach(([key, value]) => {
      expect(Object.entries(ENGLISH_DICTIONARY)).toContainEqual([key, value])
      expect(Object.hasOwn(en, key)).toBeFalse()
    })
  })

  test("leaves non-English dictionaries untranslated so they use the English base fallback", () => {
    Object.keys(koala).forEach((key) => {
      expect(Object.hasOwn(de, key)).toBeFalse()
    })
  })

  test("describes Koala enablement and profile persistence without claiming connectivity", () => {
    expect(koala["provider.koala.models.enabled.description"]).toBe("Make this model available to Koala.")
    expect(koala["provider.koala.toast.saved.title"]).toBe("{{provider}} configuration saved")
    expect(koala["provider.koala.toast.saved.description"]).toBe(
      "The local or private model profile for {{provider}} was saved.",
    )
    expect(Object.keys(koala).some((key) => key.includes("toast.connected"))).toBeFalse()
  })

  test("describes transient discovery credentials and redacted discovery outcomes", () => {
    expect(koala["provider.koala.field.apiKey.description"]).toContain("Discovery uses this key only for that request")
    expect(koala["provider.koala.field.apiKey.description"]).toContain("submitting the form stores it")
    expect(koala["provider.koala.discovery.success"]).toContain("{{count}}")
    expect(koala["provider.koala.discovery.duplicates"]).toContain("{{count}}")
    expect(koala["provider.koala.discovery.empty.description"]).toContain("not changed")
    expect(koala["provider.koala.discovery.failure.description"]).not.toContain("{{")
  })
})
