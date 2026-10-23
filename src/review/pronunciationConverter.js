/******************************************************************
 * pronunciationConverter.js
 *
 * John’s English Academy IPA-to-Method-90 conversion utility.
 *
 * Safety rules:
 * - Preserve explicit IPA syllable boundaries.
 * - Infer missing boundaries conservatively from stress, vowel nuclei
 *   and valid English onset clusters.
 * - Preserve spaces between words; hyphens separate syllables.
 * - Convert only fully valid IPA. Unknown or ambiguous input fails
 *   closed instead of being partially rewritten.
 * - In prose, protect dates, URLs, paths, regular expressions,
 *   Markdown labels and other slash/bracket-delimited non-IPA text.
 ******************************************************************/

const IPA_TO_METHOD90_MAP = Object.freeze({
  // Diphthongs and affricates first. The tokenizer also sorts by length.
  "tʃ": "tch",
  "dʒ": "dj",
  "eɪ": "è-i",
  "aɪ": "aï",
  "ɔɪ": "oo-i",
  "aʊ": "a-ou",
  "əʊ": "euh-ou",
  "oʊ": "euh-ou", // non-RP fallback if a dictionary/API returns GOAT this way
  "ɪə": "i-euh",
  "eə": "è-euh",
  "ɛə": "è-euh",
  "ʊə": "ou-eu",

  // Long vowels.
  "iː": "ii",
  "ɑː": "aa",
  "ɔː": "oo",
  "uː": "ouu",
  "ʉː": "ouu", // contemporary Southern British GOOSE alias
  "ɜː": "euhh",

  // Short vowels.
  "ɪ": "i",
  "e": "è",
  "ɛ": "è",
  "æ": "a",
  "ɒ": "o",
  "ʊ": "ou",
  "ʌ": "eu",
  "ɐ": "eu", // contemporary Southern British STRUT alias
  "ə": "euh",
  "ɘ": "euh",
  "ɵ": "euh",
  "ɜ": "euhh",
  "ɞ": "euhh",
  "ɨ": "i",
  "ʉ": "ou",
  "u": "ou", // fallback for unstressed /u/ in some British IPA dictionaries
  "i": "i", // fallback for final happy vowel /i/ in some British IPA dictionaries

  // Consonants.
  "p": "p",
  "b": "b",
  "t": "t",
  "d": "d",
  "k": "k",
  "ɡ": "gu",
  "g": "gu",
  "f": "f",
  "v": "v",
  "θ": "ts",
  "ð": "dz",
  "s": "s",
  "z": "z",
  "ʃ": "ch",
  "ʒ": "j",
  "h": "h",
  "m": "m",
  "n": "n",
  "ŋ": "ng",
  "l": "l",
  "ɹ": "r",
  "r": "r",
  "j": "y",
  "w": "w"
});

const VOWEL_KEYS = new Set([
  "eɪ", "aɪ", "ɔɪ", "aʊ", "əʊ", "oʊ", "ɪə", "eə", "ɛə", "ʊə",
  "iː", "ɑː", "ɔː", "uː", "ʉː", "ɜː",
  "ɪ", "e", "ɛ", "æ", "ɒ", "ʊ", "ʌ", "ɐ", "ə", "ɘ", "ɵ", "ɜ", "ɞ", "ɨ", "ʉ", "u", "i"
]);

const SHORT_VOWEL_KEYS = new Set([
  "ɪ", "e", "ɛ", "æ", "ɒ", "ʊ", "ʌ", "ɐ", "ə", "ɘ", "ɵ", "ɜ", "ɞ", "ɨ", "ʉ", "u", "i"
]);

const SINGLE_ENGLISH_ONSETS = new Set([
  "p", "b", "t", "d", "k", "ɡ", "g", "f", "v", "θ", "ð", "s", "z",
  "ʃ", "ʒ", "h", "m", "n", "l", "ɹ", "r", "j", "w", "tʃ", "dʒ"
]);

const COMPLEX_ENGLISH_ONSETS = new Set([
  "pɹ", "pr", "bɹ", "br", "tɹ", "tr", "dɹ", "dr", "kɹ", "kr", "ɡɹ", "ɡr", "gr",
  "fɹ", "fr", "θɹ", "θr", "ʃɹ", "ʃr", "tʃɹ", "tʃr", "dʒɹ", "dʒr",
  "pl", "bl", "kl", "ɡl", "gl", "fl", "sl",
  "sp", "st", "sk", "sm", "sn", "sw",
  "tw", "dw", "kw", "ɡw", "gw", "θw", "hw",
  "pj", "bj", "tj", "dj", "kj", "ɡj", "gj", "fj", "vj", "θj", "sj", "zj", "hj", "mj", "nj", "lj",
  "spl", "spɹ", "spr", "stɹ", "str", "skɹ", "skr", "skw", "skj"
]);

const IGNORABLE_IPA_MARKS = new Set([
  "̃", "̯", "̥", "̬", "̪", "̟", "̠", "̚", "ʰ", "ʷ", "ʲ", "ˠ"
]);

const SYLLABIC_MARK = "̩";
const PRIMARY_STRESS = "ˈ";
const SECONDARY_STRESS = "ˌ";
const MAX_IPA_CONTENT_CHARACTERS = 160;
const SORTED_IPA_KEYS = Object.keys(IPA_TO_METHOD90_MAP).sort((a, b) => b.length - a.length);
const IPA_SPAN_REGEX = /\/([^\/\n]{1,160})\/|\[([^\]\n]{1,160})\]/gu;
const IPA_SPECIFIC_SIGNAL_REGEX = /[\u0250-\u02af\u1d00-\u1d7f\u0300-\u036fˈˌːˑ]/u;
const PRONUNCIATION_CONTEXT_REGEX = /\b(?:ipa|phonetic|pronunciation|pronounce|pronounced)\b|phonétique|prononciation|prononcer|prononcé/iu;

export function convertIpaToMethod90(ipaInput) {
  const prepared = prepareIpaInput_(ipaInput);
  if (!prepared.ok) return "";

  // Raw ASCII words such as "hello" are not trustworthy IPA. Slash or
  // bracket wrappers, IPA-specific symbols or explicit syllable marks are
  // required before an unwrapped value is accepted.
  if (
    !prepared.wasWrapped &&
    !hasIpaSpecificSignal_(prepared.originalContent) &&
    !/[-.·‧]/u.test(prepared.originalContent)
  ) {
    return "";
  }

  return convertNormalizedIpa_(prepared.normalizedContent);
}

export function convertIpaSpansInTextToMethod90(text) {
  const source = String(text || "");
  if (!source) return "";

  return source.replace(IPA_SPAN_REGEX, (fullMatch, slashInner, bracketInner, offset) => {
    const inner = slashInner ?? bracketInner ?? "";
    const delimiter = slashInner !== undefined ? "/" : "[";

    if (!isSafeTextSpanContext_(source, offset, fullMatch, delimiter)) {
      return fullMatch;
    }

    const converted = convertIpaToMethod90(fullMatch);
    if (!converted) return fullMatch;

    // ASCII-only IPA is inherently ambiguous in prose (/pen/ can also be a
    // path or notation). Convert it only inside a pronunciation-labelled
    // line, or immediately below such a line.
    if (!hasIpaSpecificSignal_(inner) && !hasPronunciationContext_(source, offset)) {
      return fullMatch;
    }

    return converted;
  });
}

export function convertPronunciationTargetsToMethod90(targets) {
  if (!Array.isArray(targets)) return [];

  return targets.map((target) => {
    const item = target && typeof target === "object" ? { ...target } : {};
    const ipa = String(item.ipa_syllables || item.ipa || "").trim();
    item.ipa_syllables = ipa;
    item.adapted_pronunciation = convertIpaToMethod90(ipa);
    return item;
  });
}

export function applyMethod90ConversionToSpeakingCorrection(correction) {
  const output = correction && typeof correction === "object" ? { ...correction } : {};

  const stringFields = [
    "pronunciation_feedback",
    "student_draft_feedback",
    "teacher_draft_feedback",
    "formatted_feedback",
    "teacher_email_body"
  ];

  output.pronunciation_targets = convertPronunciationTargetsToMethod90(output.pronunciation_targets);

  for (const field of stringFields) {
    if (typeof output[field] === "string" && output[field].trim()) {
      output[field] = convertIpaSpansInTextToMethod90(output[field]);
    }
  }

  return output;
}

export function getMethod90CodebookForPrompt() {
  return [
    "/iː/ - ii", "/ɪ/ - i", "/e/ - è", "/æ/ - a", "/ɑː/ - aa", "/ɒ/ - o", "/ɔː/ - oo", "/ʊ/ - ou", "/uː/ - ouu", "/ʌ/ - eu", "/ɜː/ - euhh", "/ə/ - euh",
    "/eɪ/ - è-i", "/aɪ/ - aï", "/ɔɪ/ - oo-i", "/aʊ/ - a-ou", "/əʊ/ - euh-ou", "/ɪə/ - i-euh", "/eə/ - è-euh", "/ʊə/ - ou-eu",
    "/p/ - p", "/b/ - b", "/t/ - t", "/d/ - d", "/k/ - k", "/ɡ/ - gu", "/tʃ/ - tch", "/dʒ/ - dj", "/f/ - f", "/v/ - v", "/θ/ - ts", "/ð/ - dz", "/s/ - s", "/z/ - z", "/ʃ/ - ch", "/ʒ/ - j", "/h/ - h", "/m/ - m", "/n/ - n", "/ŋ/ - ng", "/l/ - l", "/ɹ/ - r", "/j/ - y", "/w/ - w"
  ].join("\n");
}

function prepareIpaInput_(value) {
  const original = String(value || "").trim();
  if (!original) return { ok: false };

  let originalContent = original;
  let wasWrapped = false;

  const startsSlash = original.startsWith("/");
  const endsSlash = original.endsWith("/");
  const startsBracket = original.startsWith("[");
  const endsBracket = original.endsWith("]");

  if (startsSlash || endsSlash) {
    if (!startsSlash || !endsSlash || original.length < 3) return { ok: false };
    originalContent = original.slice(1, -1);
    wasWrapped = true;
  } else if (startsBracket || endsBracket) {
    if (!startsBracket || !endsBracket || original.length < 3) return { ok: false };
    originalContent = original.slice(1, -1);
    wasWrapped = true;
  }

  if (!originalContent.trim() || [...originalContent].length > MAX_IPA_CONTENT_CHARACTERS) {
    return { ok: false };
  }

  const normalizedContent = normalizeIpaContent_(originalContent);
  if (!normalizedContent || /[\/\[\]]/u.test(normalizedContent)) return { ok: false };

  return {
    ok: true,
    originalContent,
    normalizedContent,
    wasWrapped
  };
}

function normalizeIpaContent_(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[͜͡]/gu, "")
    .replace(/ɚ/gu, "ər")
    .replace(/ɝ/gu, "ɜːr")
    .replace(/ᵻ/gu, "ɪ")
    .replace(/ᵿ/gu, "ʊ")
    .replace(/ɫ/gu, "l")
    .replace(/ɾ/gu, "t")
    .replace(/ɻ/gu, "ɹ")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/[.·‧]/gu, "-")
    .replace(/‿/gu, " ")
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function convertNormalizedIpa_(normalized) {
  const words = String(normalized || "").split(" ").filter(Boolean);
  if (!words.length) return "";

  const convertedWords = [];
  for (const word of words) {
    const converted = convertIpaWord_(word);
    if (!converted) return "";
    convertedWords.push(converted);
  }

  return cleanConvertedPronunciation_(convertedWords.join(" "));
}

function convertIpaWord_(word) {
  const value = String(word || "");
  if (!value || value.startsWith("-") || value.endsWith("-") || value.includes("--")) return "";

  const explicitSegments = value.split("-");
  if (explicitSegments.some((segment) => !segment)) return "";

  if (explicitSegments.length > 1) {
    const convertedSegments = [];
    for (const segment of explicitSegments) {
      const parsed = tokenizeIpaSegment_(segment);
      if (!parsed.ok) return "";
      const rendered = renderIpaTokens_(parsed.tokens);
      if (!rendered) return "";
      convertedSegments.push(rendered);
    }
    return convertedSegments.join("-");
  }

  const parsed = tokenizeIpaSegment_(value);
  if (!parsed.ok) return "";

  const syllables = inferSyllableTokenGroups_(parsed);
  if (!syllables.length) return "";

  const convertedSyllables = syllables.map(renderIpaTokens_);
  if (convertedSyllables.some((part) => !part)) return "";
  return convertedSyllables.join("-");
}

function tokenizeIpaSegment_(segment) {
  const ipa = String(segment || "");
  if (!ipa) return { ok: false };

  const tokens = [];
  let parenthesisDepth = 0;

  for (let index = 0; index < ipa.length;) {
    const char = ipa[index];

    if (char === PRIMARY_STRESS || char === SECONDARY_STRESS) {
      tokens.push({ kind: "stress", symbol: char });
      index += char.length;
      continue;
    }

    if (char === "(") {
      if (parenthesisDepth !== 0) return { ok: false };
      tokens.push({ kind: "parenthesis", symbol: char });
      parenthesisDepth = 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      if (parenthesisDepth !== 1) return { ok: false };
      tokens.push({ kind: "parenthesis", symbol: char });
      parenthesisDepth = 0;
      index += 1;
      continue;
    }

    if (char === SYLLABIC_MARK) {
      const previous = findPreviousSoundToken_(tokens);
      if (!previous || previous.isNucleus) return { ok: false };
      previous.isNucleus = true;
      previous.isSyllabicConsonant = true;
      index += char.length;
      continue;
    }

    if (IGNORABLE_IPA_MARKS.has(char)) {
      if (!findPreviousSoundToken_(tokens)) return { ok: false };
      index += char.length;
      continue;
    }

    if (char === "ˑ") {
      const previous = findPreviousSoundToken_(tokens);
      if (!previous || !previous.isNucleus) return { ok: false };
      // Method-90 has no separate half-length notation. Preserve the vowel
      // quality and safely omit this fine phonetic distinction.
      index += char.length;
      continue;
    }

    if (char === "ː") {
      // A full length mark must be consumed as part of a supported vowel token.
      return { ok: false };
    }

    let matchedKey = "";
    for (const key of SORTED_IPA_KEYS) {
      if (ipa.startsWith(key, index)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) return { ok: false };

    tokens.push({
      kind: "sound",
      symbol: matchedKey,
      output: IPA_TO_METHOD90_MAP[matchedKey],
      isNucleus: VOWEL_KEYS.has(matchedKey),
      isSyllabicConsonant: false
    });
    index += matchedKey.length;
  }

  if (parenthesisDepth !== 0 || !validateOptionalGroups_(tokens)) return { ok: false };

  const nucleusIndexes = [];
  const stressByNucleus = new Map();
  let pendingStress = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "stress") {
      if (pendingStress) return { ok: false };
      pendingStress = token.symbol;
      continue;
    }

    if (token.kind === "sound" && token.isNucleus) {
      nucleusIndexes.push(index);
      if (pendingStress) stressByNucleus.set(index, pendingStress);
      pendingStress = "";
    }
  }

  if (pendingStress || !nucleusIndexes.length) return { ok: false };

  return { ok: true, tokens, nucleusIndexes, stressByNucleus };
}

function findPreviousSoundToken_(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].kind === "sound") return tokens[index];
    if (tokens[index].kind === "stress") return null;
  }
  return null;
}

function validateOptionalGroups_(tokens) {
  let start = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "parenthesis") continue;

    if (token.symbol === "(") {
      if (start !== -1) return false;
      start = index;
      continue;
    }

    if (start === -1) return false;
    const inside = tokens.slice(start + 1, index);
    if (
      !inside.length ||
      inside.some((item) => item.kind !== "sound" || item.isNucleus)
    ) {
      return false;
    }
    start = -1;
  }
  return start === -1;
}

function inferSyllableTokenGroups_(parsed) {
  const { tokens, nucleusIndexes, stressByNucleus } = parsed;
  if (nucleusIndexes.length <= 1) return [tokens];

  const boundaries = new Set();

  for (let pairIndex = 0; pairIndex < nucleusIndexes.length - 1; pairIndex += 1) {
    const previousNucleusIndex = nucleusIndexes[pairIndex];
    const nextNucleusIndex = nucleusIndexes[pairIndex + 1];
    const betweenIndexes = [];

    for (let index = previousNucleusIndex + 1; index < nextNucleusIndex; index += 1) {
      betweenIndexes.push(index);
    }

    const explicitStressIndex = betweenIndexes.find((index) => tokens[index].kind === "stress");
    if (explicitStressIndex !== undefined) {
      boundaries.add(explicitStressIndex);
      continue;
    }

    if (betweenIndexes.some((index) => tokens[index].kind === "parenthesis")) {
      boundaries.add(nextNucleusIndex);
      continue;
    }

    const consonantIndexes = betweenIndexes.filter((index) => {
      const token = tokens[index];
      return token.kind === "sound" && !token.isNucleus;
    });

    if (!consonantIndexes.length) {
      boundaries.add(nextNucleusIndex);
      continue;
    }

    const previousNucleus = tokens[previousNucleusIndex];
    const previousIsStressedShortVowel = Boolean(stressByNucleus.get(previousNucleusIndex)) &&
      !previousNucleus.isSyllabicConsonant &&
      SHORT_VOWEL_KEYS.has(previousNucleus.symbol);

    const maximumOnsetLength = Math.max(
      0,
      consonantIndexes.length - (previousIsStressedShortVowel ? 1 : 0)
    );
    const onsetLength = findEnglishOnsetLength_(tokens, consonantIndexes, maximumOnsetLength);

    if (onsetLength > 0) {
      boundaries.add(consonantIndexes[consonantIndexes.length - onsetLength]);
    } else {
      boundaries.add(nextNucleusIndex);
    }
  }

  const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
  const groups = [];
  let start = 0;

  for (const boundary of orderedBoundaries) {
    if (boundary <= start || boundary >= tokens.length) return [];
    groups.push(tokens.slice(start, boundary));
    start = boundary;
  }
  groups.push(tokens.slice(start));

  if (groups.some((group) => !group.some((token) => token.kind === "sound" && token.isNucleus))) {
    return [];
  }

  return groups;
}

function findEnglishOnsetLength_(tokens, consonantIndexes, maximumLength) {
  const limit = Math.min(consonantIndexes.length, maximumLength);

  for (let length = limit; length >= 1; length -= 1) {
    const candidateIndexes = consonantIndexes.slice(-length);
    const symbols = candidateIndexes.map((index) => tokens[index].symbol);
    const candidate = symbols.join("");

    if (length === 1 && SINGLE_ENGLISH_ONSETS.has(candidate)) return 1;
    if (length > 1 && COMPLEX_ENGLISH_ONSETS.has(candidate)) return length;
  }

  return 0;
}

function renderIpaTokens_(tokens) {
  let output = "";

  for (const token of tokens) {
    if (token.kind === "stress") {
      if (token.symbol === PRIMARY_STRESS) output += "↑";
      continue;
    }

    if (token.kind === "parenthesis") {
      output += token.symbol;
      continue;
    }

    if (token.kind === "sound") output += token.output;
  }

  return output;
}

function isSafeTextSpanContext_(source, offset, fullMatch, delimiter) {
  const before = offset > 0 ? source[offset - 1] : "";
  const afterIndex = offset + fullMatch.length;
  const after = afterIndex < source.length ? source[afterIndex] : "";

  // Do not consume a fragment from // URLs, paths, dates or slash-delimited
  // notation embedded directly inside another token.
  if (delimiter === "/" && (
    before === "/" ||
    before === "\\" ||
    /[\p{L}\p{N}]/u.test(before) ||
    after === "/" ||
    after === "\\" ||
    /[\p{L}\p{N}]/u.test(after)
  )) {
    return false;
  }

  // A bracket immediately followed by '(' is a Markdown link label, not a
  // phonetic transcription, even if its text happens to use IPA characters.
  if (delimiter === "[" && after === "(") return false;

  return true;
}

function hasPronunciationContext_(source, offset) {
  const currentLineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const previousLineEnd = Math.max(0, currentLineStart - 1);
  const previousLineStart = previousLineEnd > 0
    ? source.lastIndexOf("\n", previousLineEnd - 1) + 1
    : 0;
  const currentLineEndIndex = source.indexOf("\n", offset);
  const currentLineEnd = currentLineEndIndex === -1 ? source.length : currentLineEndIndex;
  const context = source.slice(previousLineStart, currentLineEnd);
  return PRONUNCIATION_CONTEXT_REGEX.test(context);
}

function hasIpaSpecificSignal_(value) {
  return IPA_SPECIFIC_SIGNAL_REGEX.test(String(value || ""));
}

function cleanConvertedPronunciation_(value) {
  return String(value || "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*-\s*/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-\s]+|[-\s]+$/gu, "")
    .trim();
}

export const METHOD90_IPA_MAP = IPA_TO_METHOD90_MAP;

// Review-layer entry point. This is intentionally used only after DeepSeek review,
// inside reviewResultParser.js, so the first OpenAI speaking correction remains in IPA.
export function convertPronunciationInFeedback(feedback) {
  return convertIpaSpansInTextToMethod90(feedback);
}

export function previewPronunciationConversion(feedback) {
  const original = String(feedback || "");
  const converted = convertPronunciationInFeedback(original);
  return { changed: original !== converted, original, converted };
}
