# Smart English Learning Center backend

Status: GitHub source release prepared. The content bundle is complete, including requirement-based replacements authorised by the user for wording that could not be recovered. Local checks pass. External account configuration and live connection tests remain deferred as requested. See DEPLOYMENT.md before enabling processing or email delivery.

The source is based on the uploaded jea-correction-system-main (9).zip working application. It retains the working Google OAuth, audio conversion, PDFMonkey and participation/message logic, with a separate SELC runtime under src/selc. npm start uses src/selc/server.mjs; legacy JEA routes and its scheduler are not mounted. The original upload is unchanged.

## Included runtime

- Secret-authenticated registration and assignment webhooks matching the separately delivered Apps Script envelope and durable receipt.
- Durable, idempotent import events; original student answers preserved; tab IDs bind independently of tab renames.
- Teacher review pages with POST-only decisions and CSRF protection. The whole assignment has one final decision. Rejection requires a reason.
- Registration approval chooses level A1-C1, assigned registered teacher and required start date. Future starts remain SCHEDULED. The assigned teacher can be changed among registered teachers; the authenticated /worker/teachers endpoint adds other teachers with an explicit name and email.
- Immediate approval confirmation jobs, late-approval wording selection and a two-days-before teacher contact reminder at 07:00 UTC. The content bundle includes normal and late approval wording.
- Speaking-link ownership per student/assignment, persistent reserved Drive IDs, Apps Script audio download, authenticated recording retrieval and FFmpeg conversion.
- Internal verbatim transcription, actual audio bytes sent to the audio model, separate writing and speaking correction/review records and schema/source checks. A changed acoustic observation from a text review is sent back to the audio model before acceptance.
- Separate configurable OpenRouter model settings. DeepSeek V4 Pro family for text tasks; openai/gpt-audio-mini for audio correction; the preserved openai/gpt-4o-transcribe setting for transcription. Provider availability and exact account routing are not claimed tested.
- Reviewed writing and speaking assembled into the completed student feedback payload. No scores, displayed transcript, speaking example sentences or fixed motivational sentence.
- PDFMonkey rendering, reserved-ID private Drive storage and signed download links. There is no automatic public Drive sharing.
- Monday/Thursday two-topic delivery per active level, French-default instructions at every level with explicit teacher language instructions taking precedence. No LLM topic-review stage. Missing plan falls back to the last saved level instructions; no saved plan means wait and remind.
- Friday/Sunday 07:00 planning emails, one editable weekly link reused on Sunday, daily 07:00 missing-plan reminders combined with planning emails when applicable.
- Weekly plans stay editable until the next link is issued. Code rejects stale edits and verifies the selected revision before publishing a pack.
- Separate student-safe topic page, containing only a level's two topics. Teacher WhatsApp actions share this page, never the teacher report containing recipient details. Student topic emails can contain the two topics directly. No additional student PDF template is required.
- Teacher topic reports with real email status and at most 25 recipients/buttons per document; additional parts repeat the two topics.
- Teacher digests Wednesday/Friday/Sunday at 07:00 UTC, using the working app's recent-participation calculations, completed-week Sunday logic and DeepSeek message contract adapted to Olivier Tehua. Suggested messages are not printed in the PDF. Their text remains in the WhatsApp action.
- Independent scheduling, job and email loops: a long correction does not block email dispatch. Provider-accepted email is distinguished from delivered email. Uncertain send results are held UNKNOWN for reconciliation, not blindly resent.
- Quiz importing is disabled and deferred.

## Database setup at deployment

Use SELC's Supabase project, never the JEA database. Inspect installed versions first with npm run selc:db-status. This command reads the database; it was not run against the real account here.

The user has confirmed v1 is installed. Do not rerun it. Apply only missing migrations:

1. database/selc/001_foundation.sql - reference for a fresh project only; already installed in the user's project.
2. database/selc/002_planning.sql - install if version 2 is absent.
3. database/selc/003_audio_reservations.sql - install if audio_drive_reservations is absent. It intentionally creates only the shared JEA/SELC namespace reservation table; do not run it twice.
4. database/selc/004_runtime.sql - install if version 4 is absent. Corrects unused reversed v1 spreadsheet seed rows, seeds the confirmed Olivier teacher identity, adds numeric source tab IDs and runtime checkpoints, disables motivational selections and records confirmed schedules. It refuses to silently rewrite a wrong source that already has import events.

These migrations were applied to a fresh local PostgreSQL-compatible database in the integration tests. Existing live contents have not been inspected. All application tables remain server-only with RLS and no browser policies.

## Private configuration

Copy .env.example to your hosting provider's private environment settings and fill actual values there. Do not commit filled .env files. Use SELC's Google account and refresh token. All schedules and database calendar dates use UTC/GMT+0.

Keep ENABLE_INTERNAL_WORKER_LOOP=false and SELC_EMAIL_DELIVERY_ENABLED=false until migrations, template IDs, keys and deployment URLs are configured and the planned live checks are complete. /health is liveness only. GET /ready and GET /worker/status require x-worker-admin-secret. /ready checks configuration, content and schema availability; it does not prove all provider credentials work.

The DeepSeek model identifier in .env.example is the documented OpenRouter slug deepseek/deepseek-v4-pro, not an automatic latest-model alias. The direct DeepSeek alias in the source does not establish the provider revision used by the user's live account. All text-task model variables can be independently changed at deployment. No alternate text model is silently selected.

Model calls for audio include the actual base64-encoded WAV. The transcription endpoint accepts JSON audio input. No external connection was exercised to validate the retained transcription model's availability or transcript behaviour.

## Separate Apps Script projects

Do not copy Apps Script code or manifests into this repository. The Forms Bridge and Audio Downloader are separate deliverables outside this source tree. The Forms Bridge needs installed spreadsheet triggers. The Audio Downloader needs a Web App /exec deployment under SELC's account. Its owner must match the backend's Google OAuth account so reserved Drive IDs belong to the same account.

The audio downloader preserves the original source's substring check, audio/download acceptance, extension handling and diagnostic preview, as requested. Only the agreed duplicate protection and SELC private configuration are added. Historical duplicate files are not deleted. The separate JEA patch is not deployed by this SELC backend.

## Email event setup at deployment

Configure a Brevo transactional webhook to POST to /hooks/brevo, with x-selc-webhook-secret matching BREVO_WEBHOOK_SECRET. This has not been configured remotely. Delivery events correlate by message ID or the generated selc-UUID tag.

UNKNOWN sends remain held. Check Brevo before an administrator POSTs /worker/email/:id/resolve with outcome CONFIRMED_NOT_SENT to permit retry, or CONFIRMED_ACCEPTED plus message_id to record acceptance. This is not an automated claim that a message was sent.

Expired decision links can be renewed using authenticated POST /worker/reviews/REGISTRATION/:id/renew or /worker/reviews/ASSIGNMENT/:id/renew. Normal review pages continue to show the final decision after handling. Authenticated POST /worker/jobs/:id/retry requeues a DEAD/RETRY job after the underlying issue is fixed. Never expose the admin secret in a browser URL or email link.

## Release and testing

npm ci
npm run check:selc
npm test
npm run test:legacy
npm run check

Local tests use an in-memory PostgreSQL-compatible database and mocked external providers. They do not validate the actual Supabase, Google, Brevo, PDFMonkey, SpeakPipe, ScraperAPI or OpenRouter connections. Teacher template previews were validated separately.

The GitHub ZIP includes this backend, all content and an unfilled .env.example. It excludes all Apps Script, node_modules, test outputs, private .env files and local checkpoints. scripts/check-selc.mjs checks the source tree contains no Apps Script source/manifest.
