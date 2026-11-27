import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { Credential } from "../../../core/types.ts";
import { DEVIN_API } from "./constants.ts";
import type { DevinAPI, DevinModel } from "./types.ts";

/** Scope of one credential on one endpoint. Credentials reaching here already carry a validated endpoint origin. */
export function catalogScope(credential: Credential): string {
  return createHash("sha256").update(credential.apiServerURL + "\0" + credential.sessionToken).digest("hex");
}

/** The given Pi models that belong to the credential's catalog: Devin models of its endpoint and scope. */
export function modelsInScope<M extends Model<DevinAPI>>(models: readonly M[], credential: Credential): M[] {
  const expected = catalogScope(credential);
  return models.filter((model) => model.provider === "devin" && model.api === DEVIN_API && model.baseUrl === credential.apiServerURL
    && (model as unknown as DevinModel).devin?.scope === expected);
}
