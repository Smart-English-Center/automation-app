/******************************************************************
 * Maintainer alert repository.
 *
 * Purpose:
 * - Store technical/system problems in system_alerts.
 * - Deduplicate repeated problems by fingerprint.
 * - Queue a maintainer email when MAINTAINER_ALERT_EMAIL is configured.
 ******************************************************************/

import crypto from "node:crypto";
import {
  clean,
  escapeHtml,
  messageCardHtml,
  monoBoxHtml,
  statGridHtml,
  textJoin,
  wrapEmailHtml
} from "../emailDesign.js";
import { withSupabaseClient } from "./client.js";

export const MAINTAINER_ALERT_SOURCE_TYPE = "MAINTAINER_ALERT";

const SEVERITY_META = {
  CRITICAL: { color: "#991b1b", background: "#fef2f2", label: "Critical alert" },
  ERROR: { color: "#b91c1c", background: "#fef2f2", label: "Error alert" },
  WARNING: { color: "#c2410c", background: "#fff7ed", label: "Warning alert" },
  INFO: { color: "#1d4ed8", background: "#eff6ff", label: "Information" }
};

function upper_(value, fallback = "INFO") {
  const cleanValue = clean(value).toUpperCase();
  return cleanValue || fallback;
}

function hashKey_(parts) {
  return crypto.createHash("sha256").update(parts.map(clean).join("|")).digest("hex").slice(0, 32);
}

function maintainerEmail_() {
  return clean(process.env.MAINTAINER_ALERT_EMAIL || process.env.JEA_MAINTAINER_ALERT_EMAIL);
}

function maintainerAlertsEnabled_() {
  const raw = clean(process.env.MAINTAINER_ALERTS_ENABLED || "true").toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function severityMeta_(severity) {
  return SEVERITY_META[upper_(severity)] || SEVERITY_META.INFO;
}

function buildFingerprint_(payload = {}) {
  const explicit = clean(payload.fingerprint);
  if (explicit) return explicit;

  return [
    upper_(payload.alert_type || payload.issue_type || "TECHNICAL_ALERT"),
    clean(payload.entity_type),
    clean(payload.entity_id),
    clean(payload.source_spreadsheet_id),
    clean(payload.source_tab),
    clean(payload.source_row),
    clean(payload.assignment_key),
    hashKey_([JSON.stringify(payload.details_json || payload.details || {})])
  ].join(":");
}

function alertSubject_(alert) {
  const severity = upper_(alert.severity);
  const title = clean(alert.title || alert.alert_type || "Technical alert");
  return `[JEA ${severity}] ${title}`;
}

function renderMaintainerEmail_(alert) {
  const severity = upper_(alert.severity);
  const meta = severityMeta_(severity);
  const subject = alertSubject_(alert);
  const details = alert.details_json && typeof alert.details_json === "object"
    ? alert.details_json
    : {};

  const technicalRows = [
    { label: "Alert type", value: alert.alert_type },
    { label: "Severity", value: severity },
    { label: "Status", value: alert.status },
    { label: "Fingerprint", value: alert.fingerprint },
    { label: "Entity", value: [alert.entity_type, alert.entity_id].filter(Boolean).join(" / ") },
    { label: "Student ID", value: alert.student_id },
    { label: "Teacher ID", value: alert.teacher_id },
    { label: "Assignment key", value: alert.assignment_key },
    { label: "Source sheet", value: alert.source_spreadsheet_id },
    { label: "Source tab", value: alert.source_tab },
    { label: "Source row", value: alert.source_row },
    { label: "Occurrences", value: alert.occurrence_count }
  ].filter((row) => clean(row.value));

  const detailsHtml = Object.keys(details).length
    ? `
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Technical details:</strong></p>
      ${monoBoxHtml(JSON.stringify(details, null, 2))}
    `
    : "";

  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: clean(alert.message).slice(0, 130),
    badge: meta.label,
    theme: "maintainer",
    headerColor: meta.color,
    background: "#f4f6f8",
    children: `
      ${statGridHtml(technicalRows)}
      ${messageCardHtml({ title: clean(alert.title) || "Technical alert recorded", body: alert.message || "A technical alert was recorded.", theme: "maintainer" })}
      ${detailsHtml}
      ${messageCardHtml({ title: "Recommended action", body: "Inspect the affected record(s), fix the underlying cause, then mark the alert as resolved when complete.", theme: "maintainer" })}
    `
  });

  const bodyText = textJoin([
    subject,
    alert.message || "A technical alert was recorded.",
    technicalRows.map(({ label, value }) => `${label}: ${value}`).join("\n"),
    Object.keys(details).length ? `Details:\n${JSON.stringify(details, null, 2)}` : "",
    "Recommended action: inspect the affected record(s), fix the underlying cause, then mark the alert as resolved when complete.",
    "John’s English Academy"
  ]);

  return { subject, bodyHtml, bodyText };
}

export async function createMaintainerAlert(options = {}) {
  const fingerprint = buildFingerprint_(options);
  const severity = upper_(options.severity || "WARNING");
  const alertType = upper_(options.alert_type || options.issue_type || "TECHNICAL_ALERT");
  const status = upper_(options.status || "OPEN");
  const detailsJson = options.details_json || options.details || {};

  return withSupabaseClient(async (client) => {
    const result = await client.query(
      `
        insert into system_alerts (
          alert_type,
          severity,
          status,
          fingerprint,
          title,
          message,
          entity_type,
          entity_id,
          student_id,
          teacher_id,
          source_spreadsheet_id,
          source_tab,
          source_row,
          assignment_key,
          details_json,
          first_seen_at,
          last_seen_at,
          occurrence_count,
          email_status,
          created_at,
          updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6,
          $7, $8,
          nullif($9, '')::uuid,
          nullif($10, '')::uuid,
          $11, $12, $13, $14,
          $15::jsonb,
          now(), now(), 1,
          'NOT_QUEUED',
          now(), now()
        )
        on conflict (fingerprint) do update
        set
          severity = excluded.severity,
          status = case when system_alerts.status = 'RESOLVED' then 'REOPENED' else system_alerts.status end,
          title = excluded.title,
          message = excluded.message,
          details_json = excluded.details_json,
          last_seen_at = now(),
          occurrence_count = coalesce(system_alerts.occurrence_count, 0) + 1,
          updated_at = now()
        returning *
      `,
      [
        alertType,
        severity,
        status,
        fingerprint,
        clean(options.title) || alertType,
        clean(options.message) || "Technical alert recorded.",
        clean(options.entity_type),
        clean(options.entity_id),
        clean(options.student_id),
        clean(options.teacher_id),
        clean(options.source_spreadsheet_id),
        clean(options.source_tab),
        clean(options.source_row),
        clean(options.assignment_key),
        JSON.stringify(detailsJson)
      ]
    );

    return result.rows[0];
  });
}

export async function queueMaintainerAlertEmail(alertOrOptions = {}) {
  if (!maintainerAlertsEnabled_()) {
    return { ok: true, status: "MAINTAINER_ALERTS_DISABLED", queued: null };
  }

  const recipientEmail = maintainerEmail_();
  if (!recipientEmail) {
    return { ok: true, status: "MAINTAINER_EMAIL_NOT_CONFIGURED", queued: null };
  }

  const alert = alertOrOptions.alert_id ? alertOrOptions : await createMaintainerAlert(alertOrOptions);
  const rendered = renderMaintainerEmail_(alert);
  const idempotencyKey = `maintainer-alert:${alert.fingerprint}`;

  return withSupabaseClient(async (client) => {
    const result = await client.query(
      `
        insert into email_queue (
          source_type,
          source_id,
          idempotency_key,
          status,
          recipient_role,
          recipient_email,
          recipient_name,
          subject,
          body_html,
          body_text,
          payload_json,
          provider,
          created_at,
          updated_at
        )
        values (
          $1,
          $2::uuid,
          $3,
          'QUEUED',
          'MAINTAINER',
          $4,
          'Maintainer',
          $5,
          $6,
          $7,
          $8::jsonb,
          'BREVO',
          now(),
          now()
        )
        on conflict (idempotency_key) do update
        set
          updated_at = now(),
          recipient_email = case when email_queue.status = 'SENT' then email_queue.recipient_email else excluded.recipient_email end,
          subject = case when email_queue.status = 'SENT' then email_queue.subject else excluded.subject end,
          body_html = case when email_queue.status = 'SENT' then email_queue.body_html else excluded.body_html end,
          body_text = case when email_queue.status = 'SENT' then email_queue.body_text else excluded.body_text end,
          payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end
        returning *
      `,
      [
        MAINTAINER_ALERT_SOURCE_TYPE,
        alert.alert_id,
        idempotencyKey,
        recipientEmail,
        rendered.subject,
        rendered.bodyHtml,
        rendered.bodyText,
        JSON.stringify({
          source: "maintainer-alert",
          alert_id: alert.alert_id,
          alert_type: alert.alert_type,
          severity: alert.severity,
          fingerprint: alert.fingerprint
        })
      ]
    );

    const queued = result.rows[0] || null;

    if (queued?.id) {
      await client.query(
        `
          update system_alerts
          set
            email_status = case when $2 = 'SENT' then 'SENT' else 'QUEUED' end,
            email_id = $1::uuid,
            updated_at = now()
          where alert_id = $3::uuid
        `,
        [queued.id, queued.status, alert.alert_id]
      );
    }

    return { ok: true, status: "MAINTAINER_ALERT_EMAIL_QUEUED", queued };
  });
}

export async function createAndQueueMaintainerAlert(options = {}) {
  const alert = await createMaintainerAlert(options);
  const email = await queueMaintainerAlertEmail(alert);
  return { ok: true, alert, email };
}
