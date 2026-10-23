/******************************************************************
 * run-registration-expiry-once.js
 *
 * Manual/scheduled runner for one-week registration access expiry.
 * It closes expired one-week registration enrollments using exact
 * registration_end_at UTC timestamps, deactivates the student when
 * no active enrollment remains, and sends the trial-ended CTA email.
 *
 * Sliplane Scheduled Command:
 *   npm run registration:expire:once
 ******************************************************************/

import { expireRegistrationEnrollments } from "../src/supabase/registrationRepository.js";
import {
  sendEmailFailureAlert,
  sendTrialExpiredEmails
} from "../src/services/registrationEmailService.js";

try {
  const result = await expireRegistrationEnrollments();
  const delivery = await sendTrialExpiredEmails({ expiryResult: result });
  const failures = (delivery.results || []).filter((item) => !item.ok);

  if (failures.length) {
    await sendEmailFailureAlert({
      requestId: result.expired_trials?.[0]?.request?.id || null,
      context: "registration trial expiry scheduled command",
      failures
    }).catch(() => {});
  }

  const output = {
    ...result,
    email_delivery: delivery
  };

  console.log(JSON.stringify(output, null, 2));

  if (result.ok === false || delivery.notification_status === "failed") {
    process.exit(1);
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-registration-expiry-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}
