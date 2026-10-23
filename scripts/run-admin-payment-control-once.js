/******************************************************************
 * run-admin-payment-control-once.js
 *
 * Manual/scheduled runner for the monthly admin payment-control email.
 * It sends a real admin email containing a secure payment-management
 * page link. The page expires after ADMIN_PAYMENT_CONTROL_VALIDITY_DAYS
 * days, default 30.
 *
 * Sliplane Scheduled Command:
 *   npm run admin:payment-control:once
 ******************************************************************/

import { sendMonthlyPaymentControlEmails } from "../src/services/adminPaymentControlService.js";

function envBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["true", "1", "yes", "y", "on"].includes(value);
}

try {
  const result = await sendMonthlyPaymentControlEmails({
    cycleMonth: process.env.ADMIN_PAYMENT_CONTROL_CYCLE_MONTH || "",
    force: envBool("ADMIN_PAYMENT_CONTROL_FORCE", false),
    validityDays: Number(process.env.ADMIN_PAYMENT_CONTROL_VALIDITY_DAYS || 30)
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false || result.email_delivery_status === "failed") process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-admin-payment-control-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}
