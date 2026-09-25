import type { z } from "zod";

/**
 * One line for a thrown `Error`. Each issue is prefixed with its field path
 * (when it has one) so a failure names the offending field, e.g.
 * `access_token: Invalid input`. Top-level issues (path `[]`, such as a
 * `superRefine` on a bare string) surface their message alone.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
