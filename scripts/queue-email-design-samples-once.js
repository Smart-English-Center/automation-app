import { queueEmailDesignSamples } from "../src/supabase/interventionEmailRepository.js";
import { createAndQueueMaintainerAlert } from "../src/supabase/maintainerAlertRepository.js";
import { queueStudentProgressReports } from "../src/supabase/studentProgressReportRepository.js";

function clean(value) {
  return String(value ?? "").trim();
}

async function main() {
  const testRecipient = clean(
    process.env.EMAIL_DESIGN_TEST_RECIPIENT ||
    process.env.STUDENT_EMAIL_TEST_RECIPIENT ||
    process.env.EMAIL_TEST_RECIPIENT ||
    process.env.HEAD_TEACHER_EMAIL ||
    process.env.JEA_HEAD_TEACHER_EMAIL ||
    ""
  );

  if (!testRecipient) {
    throw new Error("Set EMAIL_DESIGN_TEST_RECIPIENT or HEAD_TEACHER_EMAIL before queueing design samples.");
  }

  const interventionSamples = await queueEmailDesignSamples({
    testRecipient,
    cycleDate: process.env.EMAIL_DESIGN_SAMPLE_CYCLE_DATE || ""
  });

  const progressSample = await queueStudentProgressReports({
    testMode: true,
    testRecipient,
    limit: Number(process.env.EMAIL_DESIGN_PROGRESS_SAMPLE_LIMIT || 1),
    cycleDate: process.env.EMAIL_DESIGN_PROGRESS_CYCLE_DATE || ""
  });

  const maintainerSample = await createAndQueueMaintainerAlert({
    severity: "WARNING",
    alert_type: "EMAIL_DESIGN_SAMPLE_MAINTAINER_ALERT",
    fingerprint: `EMAIL_DESIGN_SAMPLE_MAINTAINER_ALERT:${testRecipient}`,
    title: "Email design sample: maintainer alert",
    message: "This is a maintainer alert design sample. It is intentionally queued for the configured design-test recipient.",
    entity_type: "EMAIL_DESIGN_SAMPLE",
    details_json: {
      sample: true,
      test_recipient: testRecipient,
      note: "This email should look like a real maintainer alert. No visible test banner is added."
    }
  });

  const result = {
    ok: true,
    test_recipient: testRecipient,
    intervention_samples: interventionSamples,
    progress_sample: progressSample,
    maintainer_sample: maintainerSample
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
