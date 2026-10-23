# SELC content bundle

Completed under the user's instruction to generate similar text from the agreed requirements. These are requirement-based replacements where full original wording was unavailable, not a claim that every subject/body/prompt was recovered verbatim. Located message wording was reused where compatible with the runtime. In particular, the assignment receipt no longer includes an unavailable timestamp and rejection directs students to their usual submission form rather than inventing a form URL. The retained speaking correction prompt is unchanged.

Emails use the English wording of the recovered drafts and SELC blue #060DBA, red #DA0309 and pale #ECEDFC. Fixed document headings are English. Feedback explanations use the student's requested language (French default at intake). Speaking-topic directions default to French at every level unless explicitly overridden by teacher planning.

Each email has KIND.html and KIND-subject.txt. Variables are {{name}}; ordinary values are HTML-escaped, and only topics_html is trusted generated HTML. All 13 email kinds and six prompt/WhatsApp files are included. New subjects are generated from requirements.

writing.txt corrects all genuine source errors with accessible explanations; writing-review.txt checks and repairs against the original source. speaking.txt assesses the actual audio; speaking-review.txt reviews text and internal consistency only. New audible claims require audio recheck. topics.txt creates exactly two shared topics with optional role play, no useful-language section and no LLM topic review. The inherited digest prompt and participation logic remain in src/selc rather than a new digest prompt.

No lesson context is required for correction. No numerical feedback scores, displayed transcript, speaking example sentences or fixed motivational quote is added. The quiz feature remains deferred.
