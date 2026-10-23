import { sendBrevoTransactionalEmail } from "../brevoClient.js";
import {
  messageCardHtml,
  nameCardHtml,
  paragraph,
  statGridHtml,
  whatsappButtonHtml,
  wrapEmailHtml
} from "../emailDesign.js";
import {
  createMonthlyPaymentControlRuns,
  deactivateStudentFromMonthlyPaymentControl,
  getMonthlyPaymentControlRunByToken,
  markMonthlyPaymentControlRunEmailStatus
} from "../supabase/adminPaymentControlRepository.js";

function clean_(value) {
  return String(value ?? "").trim();
}

function lower_(value) {
  return clean_(value).toLowerCase();
}

function normaliseBaseUrl_(value) {
  return clean_(value).replace(/\/+$/, "");
}

function getPublicBaseUrl_() {
  const value = normaliseBaseUrl_(
    process.env.ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL ||
    process.env.REGISTRATION_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL
  );

  if (!value) {
    throw new Error(
      "ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL or REGISTRATION_PUBLIC_BASE_URL must be configured."
    );
  }

  return value;
}

/**
 * Monthly payment control intentionally sends one email total. If the existing
 * comma-separated setting contains more than one address, the first valid
 * address is the sole recipient.
 */
export function getAdminPaymentControlEmail() {
  const explicit = clean_(process.env.ADMIN_PAYMENT_CONTROL_EMAILS);
  const fallback = clean_(process.env.REGISTRATION_APPROVER_EMAILS);

  return (explicit || fallback)
    .split(",")
    .map(lower_)
    .find(Boolean) || "";
}

// Backwards-compatible export for callers that used the former plural helper.
// It now returns zero or one address by design.
export function getAdminPaymentControlEmails() {
  const email = getAdminPaymentControlEmail();
  return email ? [email] : [];
}

function pageUrl_(token) {
  const params = new URLSearchParams({ token: clean_(token) });
  return `${getPublicBaseUrl_()}/api/admin/payment-control?${params.toString()}`;
}

function formatDateEn_(value) {
  const raw = clean_(value);
  if (!raw) return "—";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Africa/Douala"
    }).format(date);
  } catch {
    return raw;
  }
}

export function enrichPaymentControlRunForDisplay(run = {}) {
  const token = clean_(run.token_raw);
  return {
    ...run,
    page_url: token ? pageUrl_(token) : "",
    students: Array.isArray(run.students) ? run.students : []
  };
}

function buildPaymentControlEmailHtml_({ run, pageUrl }) {
  return wrapEmailHtml({
    subject: "Monthly student payment management",
    preheader: "Open the secure dashboard to deactivate students whose access must be closed.",
    badge: "Payment management",
    theme: "teacher",
    children: [
      nameCardHtml({
        eyebrow: "Monthly admin dashboard",
        name: "Student payment management",
        subtitle: `Cycle month: ${clean_(run.cycle_month).slice(0, 10)} — active students: ${run.active_student_count || 0}`,
        theme: "teacher"
      }),
      paragraph(
        "Open the secure dashboard below. It lists the active students in this monthly control and provides one Deactivate button for each student."
      ),
      whatsappButtonHtml(pageUrl, "Open secure payment dashboard"),
      statGridHtml([
        { label: "Cycle month", value: clean_(run.cycle_month).slice(0, 10) },
        { label: "Active students listed", value: String(run.active_student_count || 0) },
        { label: "Valid until", value: formatDateEn_(run.expires_at) },
        { label: "Recipient", value: run.admin_email }
      ]),
      messageCardHtml({
        title: "Security note",
        body: "The secure link expires after the configured validity period. A deactivation is performed only by a POST request from the dashboard after browser confirmation.",
        theme: "warning"
      })
    ].join("\n")
  });
}

function buildPaymentControlEmailText_({ run, pageUrl }) {
  return [
    "Monthly student payment management",
    `Cycle month: ${clean_(run.cycle_month).slice(0, 10)}`,
    `Active students listed: ${run.active_student_count || 0}`,
    `Open the secure payment dashboard: ${pageUrl}`,
    `Valid until: ${clean_(run.expires_at)}`
  ].join("\n\n");
}

export async function sendMonthlyPaymentControlEmail(options = {}, dependencies = {}) {
  const adminEmail = getAdminPaymentControlEmail();
  const force = Boolean(options.force);
  const cycleMonth = clean_(
    options.cycleMonth ||
    options.cycle_month ||
    process.env.ADMIN_PAYMENT_CONTROL_CYCLE_MONTH ||
    ""
  );
  const requestedValidityDays = Number(
    options.validityDays ||
    options.validity_days ||
    process.env.ADMIN_PAYMENT_CONTROL_VALIDITY_DAYS ||
    30
  );
  const validityDays = Number.isFinite(requestedValidityDays) && requestedValidityDays > 0
    ? requestedValidityDays
    : 30;

  const createRuns = dependencies.createMonthlyPaymentControlRuns || createMonthlyPaymentControlRuns;
  const sendEmail = dependencies.sendBrevoTransactionalEmail || sendBrevoTransactionalEmail;
  const markEmailStatus =
    dependencies.markMonthlyPaymentControlRunEmailStatus ||
    markMonthlyPaymentControlRunEmailStatus;

  const created = await createRuns({
    adminEmails: adminEmail ? [adminEmail] : [],
    cycleMonth,
    validityDays,
    force
  });

  const run = Array.isArray(created.runs) ? created.runs[0] : null;
  if (!run) {
    return {
      ...created,
      ok: created.ok !== false,
      email_delivery_status: "not_sent",
      email_results: [],
      checked_at: new Date().toISOString()
    };
  }

  const dashboardUrl = pageUrl_(run.token_raw);
  const message = {
    toEmail: run.admin_email,
    toName: run.admin_email,
    subject: "Monthly student payment management",
    htmlContent: buildPaymentControlEmailHtml_({ run, pageUrl: dashboardUrl }),
    textContent: buildPaymentControlEmailText_({ run, pageUrl: dashboardUrl }),
    tags: ["jea-admin-payment-control"]
  };

  try {
    const sent = await sendEmail(message);
    await markEmailStatus({
      runId: run.id,
      status: "SENT",
      brevoMessageId: sent.message_id || ""
    });

    return {
      ...created,
      ok: true,
      email_delivery_status: "sent",
      email_results: [{
        ok: true,
        admin_email: run.admin_email,
        run_id: run.id,
        message_id: sent.message_id || "",
        page_url: dashboardUrl
      }],
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    const errorMessage = String(error && error.message ? error.message : error);

    await markEmailStatus({
      runId: run.id,
      status: "FAILED",
      errorMessage
    }).catch(() => {});

    return {
      ...created,
      ok: false,
      email_delivery_status: "failed",
      email_results: [{
        ok: false,
        admin_email: run.admin_email,
        run_id: run.id,
        error: errorMessage,
        page_url: dashboardUrl
      }],
      checked_at: new Date().toISOString()
    };
  }
}

// Preserve the existing public function name used by the scheduler and script.
export async function sendMonthlyPaymentControlEmails(options = {}, dependencies = {}) {
  return sendMonthlyPaymentControlEmail(options, dependencies);
}

export async function loadMonthlyPaymentControlPage(token, dependencies = {}) {
  const loadRun = dependencies.getMonthlyPaymentControlRunByToken || getMonthlyPaymentControlRunByToken;
  const run = await loadRun(token);
  if (!run) return null;
  return enrichPaymentControlRunForDisplay(run);
}

export async function deactivateStudentFromPaymentControlPage(
  { token, rowId } = {},
  dependencies = {}
) {
  const deactivate =
    dependencies.deactivateStudentFromMonthlyPaymentControl ||
    deactivateStudentFromMonthlyPaymentControl;

  return deactivate({ token, paymentControlStudentId: rowId });
}
