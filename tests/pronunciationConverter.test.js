import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMethod90ConversionToSpeakingCorrection,
  convertIpaSpansInTextToMethod90,
  convertIpaToMethod90,
  convertPronunciationTargetsToMethod90,
  previewPronunciationConversion
} from "../src/review/pronunciationConverter.js";
import { buildReviewedStudentFeedback } from "../src/review/reviewResultParser.js";

test("explicit IPA syllable separators remain authoritative", () => {
  assert.equal(convertIpaToMethod90("/ˌɪn-fə-ˈmeɪ-ʃən/"), "in-feuh-↑mè-i-cheuhn");
  assert.equal(convertIpaToMethod90("/ˌɪn.fə.ˈmeɪ.ʃən/"), "in-feuh-↑mè-i-cheuhn");
  assert.equal(convertIpaToMethod90("/ˌɪn·fə·ˈmeɪ·ʃən/"), "in-feuh-↑mè-i-cheuhn");
  assert.equal(convertIpaToMethod90("/ˌɪn ‐ fə ‐ ˈmeɪ ‐ ʃən/"), "in-feuh-↑mè-i-cheuhn");
});

test("missing syllable boundaries are inferred from stress and vowel nuclei", () => {
  const cases = new Map([
    ["/ˌɪnfəˈmeɪʃən/", "in-feuh-↑mè-i-cheuhn"],
    ["/ˈbɪznəs/", "↑biz-neuhs"],
    ["/rɪˈsepʃən/", "ri-↑sèp-cheuhn"],
    ["/ˈtʃɪldrən/", "↑tchil-dreuhn"],
    ["/ˌæplɪˈkeɪʃən/", "ap-li-↑kè-i-cheuhn"],
    ["/ˈekstrə/", "↑èk-streuh"],
    ["/ˈlaɪən/", "↑laï-euhn"],
    ["/kriˈeɪt/", "kri-↑è-it"],
    ["/əˈstrɒnəmi/", "euh-↑stron-euh-mi"]
  ]);

  for (const [ipa, expected] of cases) {
    assert.equal(convertIpaToMethod90(ipa), expected, ipa);
  }
});

test("monosyllables are not split apart while approved diphthong codes remain intact", () => {
  assert.equal(convertIpaToMethod90("/teɪk/"), "tè-ik");
  assert.equal(convertIpaToMethod90("/tʃeɪndʒ/"), "tchè-indj");
  assert.equal(convertIpaToMethod90("/θɹuː/"), "tsrouu");
});

test("word spaces and syllable hyphens remain distinct in phrases", () => {
  assert.equal(
    convertIpaToMethod90("/ˈkʌstəmə ˈsɜːvɪs/"),
    "↑keus-teuh-meuh ↑seuhh-vis"
  );
  assert.equal(convertIpaToMethod90("/aɪ hæv/"), "aï hav");
  assert.equal(convertIpaToMethod90("/aɪ‿hæv/"), "aï hav");
});

test("primary stress is shown and secondary stress is kept only as a boundary", () => {
  assert.equal(convertIpaToMethod90("/ˌɪn-fə-ˈmeɪ-ʃən/"), "in-feuh-↑mè-i-cheuhn");
  assert.equal(convertIpaToMethod90("/ˈbɪz-nəs/"), "↑biz-neuhs");
});

test("common British IPA aliases and fine phonetic marks are normalised safely", () => {
  assert.equal(convertIpaToMethod90("/hɐˈləʊ/"), "heu-↑leuh-ou");
  assert.equal(convertIpaToMethod90("/ˈtiːtʃɚ/"), "↑tii-tcheuhr");
  assert.equal(convertIpaToMethod90("/bɝd/"), "beuhhrd");
  assert.equal(convertIpaToMethod90("/ˈsɪɾi/"), "↑sit-i");
  assert.equal(convertIpaToMethod90("/kʰæt/"), "kat");
  assert.equal(convertIpaToMethod90("/mæ̃n/"), "man");
  assert.equal(convertIpaToMethod90("/iˑt/"), "it");
});

test("affricate tie bars and syllabic consonants do not leak into learner output", () => {
  assert.equal(convertIpaToMethod90("/ˈt͡ʃeɪn.d͡ʒɪz/"), "↑tchè-in-djiz");
  assert.equal(convertIpaToMethod90("/ˈbʌtn̩/"), "↑beut-n");
  assert.equal(convertIpaToMethod90("/n̩/"), "n");
});

test("optional non-rhotic consonants remain visibly optional", () => {
  assert.equal(convertIpaToMethod90("/ˈfɑː-ðə(r)/"), "↑faa-dzeuh(r)");
  assert.equal(convertIpaToMethod90("/fə(r)/"), "feuh(r)");
});

test("fully unsupported or malformed IPA fails closed", () => {
  const invalid = [
    "hello",
    "[optional]",
    "/hələʊʔ/",
    "/str/",
    "/ˈ/",
    "/ˈˌteɪk/",
    "/teɪkˈ/",
    "/teɪk--ə/",
    "/-teɪk/",
    "/teɪk-/",
    "/fə((r))/",
    "/fə(r/",
    "/fə(ə)/",
    "/teɪk",
    "teɪk/",
    "[]",
    "//"
  ];

  for (const input of invalid) {
    assert.equal(convertIpaToMethod90(input), "", input);
  }
});

test("overlong IPA candidates fail closed without partial conversion", () => {
  const overlong = `/${"teɪk".repeat(41)}/`;
  assert.equal(convertIpaToMethod90(overlong), "");
  assert.equal(convertIpaSpansInTextToMethod90(`Pronunciation: ${overlong}`), `Pronunciation: ${overlong}`);
});

test("valid phonetic brackets are accepted only when their context is safe", () => {
  assert.equal(convertIpaToMethod90("[ˈteɪk]"), "↑tè-ik");
  assert.equal(convertIpaSpansInTextToMethod90("Phonetic form: [pen]."), "Phonetic form: pèn.");
  assert.equal(convertIpaSpansInTextToMethod90("Choose [pen] carefully."), "Choose [pen] carefully.");
  assert.equal(
    convertIpaSpansInTextToMethod90("[ˈteɪk](https://example.com)"),
    "[ˈteɪk](https://example.com)"
  );
});

test("dates URLs paths regexes fractions and ordinary brackets are never converted", () => {
  const unchanged = [
    "Date: 30/08/2026.",
    "Visit https://example.com/path/ now.",
    "Linux path: /usr/local/bin/.",
    "Windows path: C:\\users\\student\\file.txt.",
    "Regex example: /foo|bar/.",
    "Use / and / when needed.",
    "The ratio is 50 / 10 / 5.",
    "Choose [optional] wording.",
    "Generic /pen/ notation.",
    "Embedded abc/teɪk/def must stay unchanged.",
    "Unmatched /teɪk stays unchanged."
  ];

  for (const input of unchanged) {
    assert.equal(convertIpaSpansInTextToMethod90(input), input, input);
  }
});

test("ASCII-only IPA converts in explicit pronunciation context but not generic prose", () => {
  assert.equal(
    convertIpaSpansInTextToMethod90("Target pronunciation: /pen/."),
    "Target pronunciation: pèn."
  );
  assert.equal(
    convertIpaSpansInTextToMethod90("Prononciation cible : /best/."),
    "Prononciation cible : bèst."
  );
  assert.equal(
    convertIpaSpansInTextToMethod90("Target pronunciation:\n/pen/"),
    "Target pronunciation:\npèn"
  );
  assert.equal(convertIpaSpansInTextToMethod90("Generic /pen/ notation."), "Generic /pen/ notation.");
});

test("multiple valid IPA spans convert independently and invalid neighbours remain intact", () => {
  assert.equal(
    convertIpaSpansInTextToMethod90("Pronunciation: /teɪk/, /kəʊs/ and /foo|bar/."),
    "Pronunciation: tè-ik, keuh-ous and /foo|bar/."
  );
});

test("conversion is idempotent once IPA delimiters have been removed", () => {
  const original = "Pronunciation: /ˌɪnfəˈmeɪʃən/. Date: 30/08/2026.";
  const once = convertIpaSpansInTextToMethod90(original);
  const twice = convertIpaSpansInTextToMethod90(once);
  assert.equal(once, "Pronunciation: in-feuh-↑mè-i-cheuhn. Date: 30/08/2026.");
  assert.equal(twice, once);
});

test("structured pronunciation targets receive safe adapted values without mutating the source", () => {
  const source = [
    { word: "business", ipa_syllables: "/ˈbɪznəs/" },
    { word: "information", ipa: "/ˌɪnfəˈmeɪʃən/" },
    { word: "invalid", ipa: "hello" }
  ];
  const converted = convertPronunciationTargetsToMethod90(source);

  assert.deepEqual(converted, [
    {
      word: "business",
      ipa_syllables: "/ˈbɪznəs/",
      adapted_pronunciation: "↑biz-neuhs"
    },
    {
      word: "information",
      ipa: "/ˌɪnfəˈmeɪʃən/",
      ipa_syllables: "/ˌɪnfəˈmeɪʃən/",
      adapted_pronunciation: "in-feuh-↑mè-i-cheuhn"
    },
    {
      word: "invalid",
      ipa: "hello",
      ipa_syllables: "hello",
      adapted_pronunciation: ""
    }
  ]);
  assert.equal(source[0].adapted_pronunciation, undefined);
});

test("speaking-correction conversion touches only supported fields and safe IPA", () => {
  const source = {
    pronunciation_targets: [{ word: "business", ipa: "/ˈbɪznəs/" }],
    pronunciation_feedback: "Target pronunciation: /pen/. Date: 30/08/2026.",
    formatted_feedback: "Use /teɪk/ here; keep https://example.com/path/ unchanged.",
    unrelated_field: "Pronunciation: /teɪk/."
  };

  const converted = applyMethod90ConversionToSpeakingCorrection(source);
  assert.equal(converted.pronunciation_targets[0].adapted_pronunciation, "↑biz-neuhs");
  assert.equal(converted.pronunciation_feedback, "Target pronunciation: pèn. Date: 30/08/2026.");
  assert.equal(converted.formatted_feedback, "Use tè-ik here; keep https://example.com/path/ unchanged.");
  assert.equal(converted.unrelated_field, "Pronunciation: /teɪk/.");
  assert.notEqual(converted, source);
});

test("reviewed feedback uses the hardened converter for approved and replacement paths", () => {
  const originalFeedback = "**Target pronunciation:** /ˈbɪznəs/\nDate: 30/08/2026.";
  assert.equal(
    buildReviewedStudentFeedback({
      originalFeedback,
      parsedReview: { ok: true, review_status: "APPROVED" }
    }),
    "**Target pronunciation:** ↑biz-neuhs\nDate: 30/08/2026."
  );

  assert.equal(
    buildReviewedStudentFeedback({
      originalFeedback,
      parsedReview: {
        ok: true,
        review_status: "FIXED",
        corrected_feedback_markdown: "**Target pronunciation:** /rɪˈsepʃən/"
      }
    }),
    "**Target pronunciation:** ri-↑sèp-cheuhn"
  );
});

test("preview reports changes only when a safe IPA conversion occurs", () => {
  assert.deepEqual(previewPronunciationConversion("Pronunciation: /teɪk/."), {
    changed: true,
    original: "Pronunciation: /teɪk/.",
    converted: "Pronunciation: tè-ik."
  });
  assert.deepEqual(previewPronunciationConversion("Date: 30/08/2026."), {
    changed: false,
    original: "Date: 30/08/2026.",
    converted: "Date: 30/08/2026."
  });
});
