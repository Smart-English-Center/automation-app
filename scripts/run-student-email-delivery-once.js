/******************************************************************
 * run-student-email-delivery-once.js
 *
 * Supabase-native manual/scheduled runner for student feedback PDF emails.
 * Default behaviour sends one already queued STUDENT_FEEDBACK_PDF email.
 * Set QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND=true to queue before sending.
 ******************************************************************/

import { runStudentEmailDeliveryOnce } from "../src/studentEmailDeliveryWorker.js";

try {
  const result = await runStudentEmailDeliveryOnce({
    limit: Number(process.env.STUDENT_EMAIL_DELIVERY_LIMIT || process.env.EMAIL_DELIVERY_LIMIT || 1),
    queueLimit: Number(process.env.EMAIL_QUEUE_LIMIT || 10),
    sourceTypes: process.env.STUDENT_EMAIL_DELIVERY_SOURCE_TYPES || "STUDENT_FEEDBACK_PDF",
    queueBeforeSend: process.env.QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND || "false"
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.ok === false) {
    process.exit(1);
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        script: "run-student-email-delivery-once",
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      },
      null,
      2
    )
  );

  process.exit(1);
}
