import { ModelProfile } from "@koala-ai/core/model/profile"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ProviderNotFoundError, UnknownError } from "../errors"
import { described } from "./metadata"

const root = "/global/model-profile"

export const ModelProfilePaths = {
  root,
  provider: `${root}/:providerID`,
} as const

export const ModelProfileApi = HttpApi.make("modelProfile").add(
  HttpApiGroup.make("modelProfile")
    .add(
      HttpApiEndpoint.get("list", ModelProfilePaths.root, {
        success: described(Schema.Array(ModelProfile.Provider), "Model profiles"),
        error: UnknownError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "modelProfile.list",
          summary: "List model profiles",
          description: "List all global Koala model provider profiles.",
        }),
      ),
      HttpApiEndpoint.post("create", ModelProfilePaths.root, {
        payload: ModelProfile.Provider,
        success: described(ModelProfile.Provider, "Created model profile"),
        error: [InvalidRequestError, ConflictError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "modelProfile.create",
          summary: "Create model profile",
          description: "Create a global Koala model provider profile.",
        }),
      ),
      HttpApiEndpoint.put("update", ModelProfilePaths.provider, {
        params: { providerID: ModelProfile.ProviderID },
        payload: ModelProfile.Provider,
        success: described(ModelProfile.Provider, "Updated model profile"),
        error: [InvalidRequestError, ProviderNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "modelProfile.update",
          summary: "Update model profile",
          description: "Replace a global Koala model provider profile.",
        }),
      ),
      HttpApiEndpoint.delete("remove", ModelProfilePaths.provider, {
        params: { providerID: ModelProfile.ProviderID },
        success: described(Schema.Boolean, "Model profile deleted"),
        error: [InvalidRequestError, ProviderNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "modelProfile.delete",
          summary: "Delete model profile",
          description: "Delete a global Koala model provider profile.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "modelProfile", description: "Global Koala model profile routes." })),
)
