/** Provider-reported model metadata only; never synthesize it from selection. */
export const MAX_RESPONSE_MODEL_LENGTH = 256;

export function isResponseModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RESPONSE_MODEL_LENGTH && value.trim().length > 0;
}

export function reportedModel(value: unknown): string | undefined {
  return isResponseModel(value) ? value : undefined;
}
