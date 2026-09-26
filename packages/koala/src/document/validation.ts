export * as DocumentValidation from "./validation"

import { Schema } from "effect"
import { Artifact } from "../artifact/artifact"
import { IndustrialInput } from "../industrial/input"
import { IndustrialResult } from "../industrial/result"

export const ArtifactFinding = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "DocumentValidation.ArtifactFinding" })

export const ArtifactValidate = {
  Input: Schema.Struct({
    source: IndustrialInput.Source,
    profile: Schema.optionalKey(Schema.Literal("ooxml-basic")),
  }).annotate({ identifier: "DocumentValidation.ArtifactValidate.Input" }),
  Result: IndustrialResult.make(
    "artifact_validate",
    Schema.Struct({
      valid: Schema.Boolean,
      findings: Schema.Array(ArtifactFinding),
    }).annotate({ identifier: "DocumentValidation.ArtifactValidate.Data" }),
  ),
}

export type ArtifactValidateInput = typeof ArtifactValidate.Input.Type
export type ArtifactValidateResult = typeof ArtifactValidate.Result.Type
