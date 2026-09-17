export * as ModelRouter from "./router"

import { ModelProfile } from "./profile"

export const TaskKind = [
  "general-chat",
  "coding",
  "document-analysis",
  "document-generation",
  "vision",
  "knowledge-retrieval",
  "calculation",
] as const
export type TaskKind = (typeof TaskKind)[number]

export interface Override {
  readonly providerID: ModelProfile.ProviderID
  readonly modelID: ModelProfile.ModelID
}

export interface Input {
  readonly task: TaskKind
  readonly requiredCapabilities: ReadonlyArray<ModelProfile.Capability>
  readonly userOverride?: Override
  readonly profiles: ReadonlyArray<ModelProfile.Provider>
}

export interface Candidate {
  readonly providerID: ModelProfile.ProviderID
  readonly profile: ModelProfile.Model
}

export type RejectionReason =
  | { readonly code: "disabled" }
  | {
      readonly code: "required-capability-unavailable"
      readonly capability: ModelProfile.Capability
      readonly detected: ModelProfile.Detectable
    }
  | { readonly code: "not-user-override" }
  | { readonly code: "task-role-not-preferred"; readonly role: ModelProfile.Role }
  | { readonly code: "lower-ranked" }

export interface RejectedCandidate extends Candidate {
  readonly reasons: ReadonlyArray<RejectionReason>
}

export interface Result {
  readonly selected: Candidate | undefined
  readonly rejected: ReadonlyArray<RejectedCandidate>
}

const taskPolicy: Record<TaskKind, { capability: ModelProfile.Capability; role: ModelProfile.Role }> = {
  "general-chat": { capability: "textInput", role: "general" },
  coding: { capability: "textInput", role: "coding" },
  "document-analysis": { capability: "textInput", role: "document" },
  "document-generation": { capability: "textInput", role: "document" },
  vision: { capability: "imageInput", role: "vision" },
  "knowledge-retrieval": { capability: "textInput", role: "embedding" },
  calculation: { capability: "textInput", role: "fast" },
}

export function route(input: Input): Result {
  const policy = taskPolicy[input.task]
  const requiredCapabilities = [...new Set([policy.capability, ...input.requiredCapabilities])]
  const candidates = input.profiles
    .flatMap((provider) => provider.models.map((profile) => ({ providerID: provider.id, profile })))
    .sort(
      (left, right) =>
        left.profile.priority - right.profile.priority ||
        left.providerID.localeCompare(right.providerID) ||
        left.profile.id.localeCompare(right.profile.id),
    )
  const evaluated = candidates.map((candidate) => ({
    ...candidate,
    reasons: [
      ...(candidate.profile.enabled ? [] : [{ code: "disabled" as const }]),
      ...requiredCapabilities.flatMap((capability) => {
        const detected = candidate.profile.capabilities[capability]
        if (detected === "yes") return []
        return [{ code: "required-capability-unavailable" as const, capability, detected }]
      }),
      ...(input.userOverride &&
      (candidate.providerID !== input.userOverride.providerID || candidate.profile.id !== input.userOverride.modelID)
        ? [{ code: "not-user-override" as const }]
        : []),
    ],
  }))
  const eligible = evaluated.filter((candidate) => candidate.reasons.length === 0)
  const preferred = input.userOverride
    ? eligible
    : eligible.filter((candidate) => candidate.profile.roles.includes(policy.role))
  const ranked = preferred.length > 0 ? preferred : eligible
  const selected = ranked[0]

  return {
    selected: selected ? { providerID: selected.providerID, profile: selected.profile } : undefined,
    rejected: evaluated.flatMap((candidate) => {
      if (candidate === selected) return []
      const roleReason =
        !input.userOverride &&
        preferred.length > 0 &&
        candidate.reasons.length === 0 &&
        !candidate.profile.roles.includes(policy.role)
          ? [{ code: "task-role-not-preferred" as const, role: policy.role }]
          : []
      return [
        {
          providerID: candidate.providerID,
          profile: candidate.profile,
          reasons: [
            ...candidate.reasons,
            ...roleReason,
            ...(ranked.includes(candidate) ? [{ code: "lower-ranked" as const }] : []),
          ],
        },
      ]
    }),
  }
}
