function clean_(value) {
  return String(value ?? "").trim();
}

/**
 * Formats JEA's surname-first full names for student-facing copy.
 *
 * Examples:
 * - MATENE Emsy Pascale -> Emsy Pascale
 * - ZOBO NGONO Jean Christophe -> Jean Christophe
 * - MATENE Emsy -> Emsy
 *
 * Canonical full names must remain unchanged in source records and audit data.
 */
export function studentFacingName(value, fallback = "") {
  const cleaned = clean_(value);
  const cleanFallback = clean_(fallback);

  if (!cleaned || cleaned.includes("@")) return cleanFallback;

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[1];
  return parts.slice(-2).join(" ");
}
