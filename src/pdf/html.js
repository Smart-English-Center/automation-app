function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


function normalizeUnicode_(value) {
  return String(value ?? "").normalize("NFKC");
}

function normalizeFeedbackMarkdown_(value) {
  return normalizeUnicode_(value)
    .replace(/\r\n/g, "\n")
    // Some previous review outputs started with a standalone "Feedback" line.
    // The PDF block title already says Writing Feedback / Speaking Feedback, so this
    // artificial heading only prevents the feedback-section parser from detecting
    // the real first section.
    .replace(/^\s*(?:#+\s*)?Feedback\s*\n+/i, "");
}

function stripAccents_(value) {
  return normalizeUnicode_(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inlineMarkdownToHtml_(value) {
  let html = escapeHtml_(normalizeUnicode_(value));

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(\d)\s*\*\s*(\d)/g, "$1 &times; $2");
  html = html.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  // DeepSeek occasionally returns a lone Markdown marker. It has no useful
  // formatting meaning and must never remain visible in a student PDF.
  html = html.replace(/\*/g, "");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  return html;
}

function flushParagraph_(parts, paragraphLines) {
  if (!paragraphLines.length) return;
  const text = paragraphLines.join("<br>");
  parts.push(`<p>${text}</p>`);
  paragraphLines.length = 0;
}

function flushList_(parts, listItems, ordered) {
  if (!listItems.length) return;
  const tag = ordered ? "ol" : "ul";
  parts.push(`<${tag}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
  listItems.length = 0;
}

function normaliseHeading_(heading) {
  return stripAccents_(heading)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\?/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function feedbackClassForHeading_(heading) {
  const key = normaliseHeading_(heading);

  if (key === "score" || key === "writing_score" || key === "speaking_score") return "score";

  if (key.includes("bon_point") || key.includes("good_point") || key === "positive") return "good_point";
  if (key.includes("a_corriger") || key.includes("to_improve") || key.includes("improve")) return "to_improve";
  if (key.includes("pourquoi") || key === "why") return "why";
  if (key.includes("modele") || key.includes("model")) return "model_answer";

  if (key.includes("respect_de_la_consigne") || key.includes("task_achievement")) return "task_achievement";
  if (key.includes("grammaire") && key.includes("vocabulaire")) return "grammar_and_vocabulary";
  if (key.includes("grammar") && key.includes("vocabulary")) return "grammar_and_vocabulary";
  if (key.includes("vocabulary") || key.includes("vocabulaire")) return "vocabulary";
  if (key.includes("grammar") || key.includes("grammaire")) return "grammar";
  if (key.includes("organisation") || key.includes("organization") || key.includes("phrases_completes")) return "organisation";
  if (key.includes("orthographe") || key.includes("spelling") || key.includes("punctuation")) return "spelling_and_punctuation";
  if (key.includes("corrections_de_prononciation") || key.includes("pronunciation_corrections")) return "pronunciation_corrections";
  if (key.includes("prononciation") || key.includes("pronunciation")) return "pronunciation";
  if (key.includes("clarte") || key.includes("clarity")) return "message_clarity";
  if (key.includes("corrections_principales") || key.includes("main_corrections")) return "main_corrections";

  return key || "general";
}

function parseFeedbackHeadingLine_(line) {
  const trimmed = normalizeUnicode_(line).trim();

  // **Score : 86/100**
  let match = trimmed.match(/^\*\*\s*([^:*]+?)\s*:\s*(.+?)\s*\*\*$/);
  if (match) return { heading: match[1].trim(), inlineValue: match[2].trim() };

  // **Bon point :** text OR **Bon point:** text
  match = trimmed.match(/^\*\*\s*(.+?)\s*:\s*\*\*\s*(.*)$/);
  if (match) return { heading: match[1].trim(), inlineValue: match[2].trim() };

  // Normal labels, including labels converted from mathematical-bold Unicode by NFKC.
  match = trimmed.match(/^(Score|Bon point|Good point|À corriger|A corriger|To improve|Pourquoi \?|Why\?|Mod[eè]le|Model|Prononciation|Pronunciation|Corrections de prononciation|Pronunciation corrections)\s*:\s*(.*)$/i);
  if (match) return { heading: match[1].trim(), inlineValue: match[2].trim() };

  // Score sub-sections such as "Respect de la consigne : 12/20" or
  // "Good use of grammar and vocabulary : 14/25".
  // Keep this restricted to score values so role-play lines like "New employee:"
  // inside a model answer are not mistaken for section headings.
  match = trimmed.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 '\u2019+\-/]{1,90}?)\s*:\s*(\d{1,3}\s*\/\s*\d{1,3})\s*$/);
  if (match) return { heading: match[1].trim(), inlineValue: match[2].trim() };

  return null;
}

function looksLikeFeedbackMarkdown_(text) {
  const normalized = normalizeFeedbackMarkdown_(text);
  return /\*\*\s*(Score|Bon point|Good point|À corriger|A corriger|To improve|Pourquoi|Why|Mod[eè]le|Model|Respect de la consigne|Task achievement|Prononciation|Pronunciation|Clart[eé]|Clarity)\b/i.test(normalized)
    || /^(Score|Bon point|Good point|À corriger|A corriger|To improve|Pourquoi|Why|Mod[eè]le|Model)\s*:/im.test(normalized);
}

function genericMarkdownToHtml_(value) {
  const text = normalizeFeedbackMarkdown_(value).trim();
  if (!text) return "";

  const parts = [];
  const paragraphLines = [];
  const listItems = [];
  let listOrdered = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph_(parts, paragraphLines);
      flushList_(parts, listItems, listOrdered);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph_(parts, paragraphLines);
      flushList_(parts, listItems, listOrdered);
      const level = Math.min(4, heading[1].length + 2);
      parts.push(`<h${level}>${inlineMarkdownToHtml_(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph_(parts, paragraphLines);
      if (listItems.length && listOrdered) flushList_(parts, listItems, listOrdered);
      listOrdered = false;
      listItems.push(inlineMarkdownToHtml_(unordered[1]));
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph_(parts, paragraphLines);
      if (listItems.length && !listOrdered) flushList_(parts, listItems, listOrdered);
      listOrdered = true;
      listItems.push(inlineMarkdownToHtml_(ordered[1]));
      continue;
    }

    flushList_(parts, listItems, listOrdered);
    paragraphLines.push(inlineMarkdownToHtml_(line));
  }

  flushParagraph_(parts, paragraphLines);
  flushList_(parts, listItems, listOrdered);

  return parts.join("");
}

function scoreFromInlineValue_(value) {
  const match = String(value ?? "").match(/\b\d{1,3}\s*\/\s*100\b|\b\d{1,3}\s*\/\s*\d{1,3}\b/);
  return match ? match[0].replace(/\s+/g, "") : "";
}

function splitFeedbackSections_(text) {
  const sections = [];
  let current = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const parsed = parseFeedbackHeadingLine_(line);

    if (parsed) {
      if (current) sections.push(current);
      current = {
        heading: parsed.heading,
        inlineValue: parsed.inlineValue || "",
        bodyLines: []
      };
      continue;
    }

    if (!current) {
      current = { heading: "Feedback", inlineValue: "", bodyLines: [] };
    }

    current.bodyLines.push(line);
  }

  if (current) sections.push(current);
  return sections.filter((section) => {
    return section.heading || section.inlineValue || section.bodyLines.some((line) => line.trim());
  });
}

function parseCorrectionCards_(bodyText) {
  const lines = bodyText.split("\n");
  const cards = [];
  let current = null;

  function pushCurrent() {
    if (current) cards.push(current);
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const start = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (start) {
      pushCurrent();
      current = { number: start[1], lines: [start[2]] };
      continue;
    }

    if (!current) current = { number: String(cards.length + 1), lines: [] };
    current.lines.push(line);
  }

  pushCurrent();
  return cards.filter((card) => card.lines.length);
}

function fieldClassForLabel_(label) {
  const key = normaliseHeading_(label);
  if (key.includes("original")) return "original";
  if (key.includes("correction") || key.includes("prononciation_cible") || key.includes("target_pronunciation") || key.includes("pronunciation_target")) return "correction";
  if (key.includes("type")) return "type";
  if (key.includes("explication") || key.includes("explanation") || key.includes("rappel") || key.includes("reminder") || key.includes("probleme") || key.includes("problem")) return "explanation";
  return "general";
}

function parseLoosePronunciationLine_(line) {
  const clean = normalizeUnicode_(line).trim();
  const split = clean.split(/\s+[—-]\s+(?:Heard|Probleme entendu|Probl[eè]me entendu)\s*/i);
  if (split.length < 2) return null;

  const left = split[0].trim();
  const right = split.slice(1).join(" — Heard ").trim();
  const leftParts = left.split(/\s+/).filter(Boolean);
  if (leftParts.length < 2) return null;

  const word = leftParts[0];
  const target = leftParts.slice(1).join("-").replace(/-+/g, "-");

  return [
    { label: "Word/phrase", value: word },
    { label: "Pronunciation target", value: target },
    { label: "Heard problem / reminder", value: right }
  ];
}

function correctionCardsToHtml_(bodyText, sectionClass = "") {
  const cards = parseCorrectionCards_(bodyText);
  if (!cards.length) return genericMarkdownToHtml_(bodyText);

  const cardHtml = cards.map((card) => {
    const fields = [];
    const loose = [];

    for (const line of card.lines) {
      const field = normalizeUnicode_(line).match(/^(.+?)\s*:\s*(.+)$/);
      if (field) {
        const label = field[1].trim();
        const value = field[2].trim();
        const fieldClass = fieldClassForLabel_(label);
        fields.push(`
          <div class="correction-field correction-field-${fieldClass}">
            <div class="correction-label">${inlineMarkdownToHtml_(label)}</div>
            <div class="correction-value">${inlineMarkdownToHtml_(value)}</div>
          </div>`);
      } else if (sectionClass === "pronunciation_corrections") {
        const parsedPronunciationFields = parseLoosePronunciationLine_(line);
        if (parsedPronunciationFields) {
          for (const parsedField of parsedPronunciationFields) {
            const fieldClass = fieldClassForLabel_(parsedField.label);
            fields.push(`
              <div class="correction-field correction-field-${fieldClass}">
                <div class="correction-label">${inlineMarkdownToHtml_(parsedField.label)}</div>
                <div class="correction-value">${inlineMarkdownToHtml_(parsedField.value)}</div>
              </div>`);
          }
        } else {
          loose.push(line);
        }
      } else {
        loose.push(line);
      }
    }

    const looseHtml = loose.length ? `<div class="correction-field correction-field-explanation"><div class="correction-value">${genericMarkdownToHtml_(loose.join("\n"))}</div></div>` : "";

    return `<div class="correction-card">
      <div class="correction-card-title">Correction ${escapeHtml_(card.number)}</div>
      ${looseHtml}
      ${fields.join("")}
    </div>`;
  }).join("");

  return `<div class="main-corrections-list">${cardHtml}</div>`;
}

function isScoreOnlyLine_(line, score) {
  if (!score) return false;
  const cleanLine = normalizeUnicode_(line).trim().replace(/\s+/g, "");
  const cleanScore = normalizeUnicode_(score).trim().replace(/\s+/g, "");
  return cleanLine === cleanScore;
}

function feedbackSectionToHtml_(section) {
  const cssClass = feedbackClassForHeading_(section.heading);
  const score = scoreFromInlineValue_(section.inlineValue);

  const bodyLines = [...section.bodyLines];
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();

  // Avoid duplicated numbers such as:
  // SCORE 62/100
  // 62/100
  // Comment...
  if (bodyLines.length && isScoreOnlyLine_(bodyLines[0], score)) {
    bodyLines.shift();
  }

  const includeInlineValueInBody = section.inlineValue
    && !(score && isScoreOnlyLine_(section.inlineValue, score));

  const bodyText = [
    ...(includeInlineValueInBody ? [section.inlineValue] : []),
    ...bodyLines
  ].join("\n").trim();

  const isCorrectionSection = cssClass === "main_corrections" || cssClass === "pronunciation_corrections";
  const bodyHtml = isCorrectionSection
    ? correctionCardsToHtml_(bodyText, cssClass)
    : genericMarkdownToHtml_(bodyText);

  return `<section class="feedback-section feedback-section-${escapeHtml_(cssClass)}">
    <div class="feedback-heading-row">
      <div class="feedback-heading">${escapeHtml_(section.heading)}</div>
      ${score ? `<div class="feedback-section-score">${escapeHtml_(score)}</div>` : ""}
    </div>
    ${bodyHtml ? `<div class="feedback-body">${bodyHtml}</div>` : ""}
  </section>`;
}

function feedbackMarkdownToHtml_(value) {
  const text = normalizeFeedbackMarkdown_(value).trim();
  if (!text) return "";
  return splitFeedbackSections_(text).map(feedbackSectionToHtml_).join("");
}

export function plainTextToHtml(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml_(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function markdownToHtml(value) {
  const text = normalizeFeedbackMarkdown_(value).trim();
  if (!text) return "";
  return looksLikeFeedbackMarkdown_(text) ? feedbackMarkdownToHtml_(text) : genericMarkdownToHtml_(text);
}

export function linkToHtml(url, label = "Open link") {
  const cleanUrl = String(url ?? "").trim();
  if (!cleanUrl) return "";
  return `<a href="${escapeHtml_(cleanUrl)}">${escapeHtml_(label)}</a>`;
}
