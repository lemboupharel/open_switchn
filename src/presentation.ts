import { ZodError } from "zod";

const secretKey = /token|authorization|cookie|password|pin|otp|unique_id|payment_link|validate_url|resend_url/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, secretKey.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}
export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return "Validation failed: " + error.issues.map(issue =>
      issue.path.length === 1 && issue.path[0] === "inputted_receiver_name"
        ? "Enter the recipient's registered Mobile Money account name (1-256 characters)."
        : `${issue.path.join(".") || "input"} (${issue.code})`).join("; ");
  }
  return error instanceof Error ? error.message : "Unexpected error";
}
