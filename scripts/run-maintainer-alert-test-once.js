import { createAndQueueMaintainerAlert } from "../src/supabase/maintainerAlertRepository.js";

try {
  const result = await createAndQueueMaintainerAlert({
    severity: process.env.MAINTAINER_TEST_SEVERITY || "WARNING",
    alert_type: "MAINTAINER_ALERT_TEST",
    fingerprint: `MAINTAINER_ALERT_TEST:${process.env.MAINTAINER_TEST_FINGERPRINT || "default"}`,
    title: "Maintainer alert test",
    message: "This is a test maintainer alert from John's English Academy. It confirms that system_alerts and email_queue integration are working.",
    details_json: {
      triggered_by: "scripts/run-maintainer-alert-test-once.js",
      test_mode: true,
      generated_at: new Date().toISOString()
    }
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-maintainer-alert-test-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}
