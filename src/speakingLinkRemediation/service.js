import { classifySpeakPipeLink } from "../submissionPolicy.js";
import {
  applyCorrectedSpeakingLink,
  createSpeakingLinkRemediationCase,
  loadSpeakingLinkRemediationCase,
  resolveSpeakingWithoutAudio,
  SpeakingLinkRemediationError
} from "../supabase/speakingLinkRemediationRepository.js";

function clean(value) { return String(value ?? "").trim(); }

function publicBaseUrl_() {
  return clean(process.env.REGISTRATION_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
}

export function remediationPageUrl(token, mode = "correct") {
  const base = publicBaseUrl_();
  if (!base) throw new SpeakingLinkRemediationError("MISSING_PUBLIC_BASE_URL", "REGISTRATION_PUBLIC_BASE_URL is required for speaking-link remediation emails.", 500);
  const query = new URLSearchParams({ token: clean(token), mode: clean(mode) || "correct" });
  return `${base}/api/speaking-link-remediation?${query.toString()}`;
}

export async function createInvalidLinkRemediation(client, input = {}) {
  const result = await createSpeakingLinkRemediationCase(client, input);
  if (!result.created || !result.token_raw) return { ...result, correct_url: "", resolve_url: "" };
  return {
    ...result,
    correct_url: remediationPageUrl(result.token_raw, "correct"),
    resolve_url: remediationPageUrl(result.token_raw, "resolve")
  };
}

export async function loadRemediationPage(token) {
  if (!clean(token)) throw new SpeakingLinkRemediationError("TOKEN_REQUIRED", "The remediation token is missing.", 400);
  const row = await loadSpeakingLinkRemediationCase(token);
  if (!row) throw new SpeakingLinkRemediationError("CASE_NOT_FOUND", "This remediation link is invalid.", 404);
  return row;
}

export async function correctRemediationLink(input = {}, dependencies = {}) {
  if (clean(input.confirmation) !== "verified") {
    throw new SpeakingLinkRemediationError("CONFIRMATION_REQUIRED", "Confirm that you opened and verified the recording before continuing.", 400);
  }
  const linkInfo = classifySpeakPipeLink(input.corrected_link);
  if (!linkInfo.valid) {
    throw new SpeakingLinkRemediationError(linkInfo.issue_code || "INVALID_SPEAKPIPE_LINK", linkInfo.issue_message || "Enter a complete valid SpeakPipe message link.", 400);
  }
  return applyCorrectedSpeakingLink({
    token: input.token,
    expectedVersion: input.version,
    canonicalLink: linkInfo.normalized_url
  }, dependencies);
}

export async function resolveRemediationWithoutSpeaking(input = {}, dependencies = {}) {
  if (clean(input.confirmation) !== "continue_without_speaking") {
    throw new SpeakingLinkRemediationError("CONFIRMATION_REQUIRED", "Explicit confirmation is required before continuing without speaking.", 400);
  }
  return resolveSpeakingWithoutAudio({ token: input.token, expectedVersion: input.version }, dependencies);
}
