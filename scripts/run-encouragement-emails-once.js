#!/usr/bin/env node
import {
  queueWeeklyEncouragementEmails,
  queueWeeklyStudentEncouragementEmails,
  queueWeeklyTeacherEncouragementEmails
} from "../src/supabase/encouragementEmailRepository.js";
import { closeSupabasePool } from "../src/supabase/client.js";

function argValue_(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function envValue_(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function argOrEnv_(argName, envName, fallback = "") {
  return argValue_(argName, envValue_(envName, fallback));
}

function numberArgOrEnv_(argName, envName, fallback) {
  const value = Number(argOrEnv_(argName, envName, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function main() {
  const mode = argOrEnv_("--mode", "ENCOURAGEMENT_EMAIL_MODE", "weekly-all");
  const options = {
    limit: numberArgOrEnv_("--limit", "ENCOURAGEMENT_EMAIL_QUEUE_LIMIT", 100),
    cycleDate: argOrEnv_("--cycle-date", "ENCOURAGEMENT_EMAIL_CYCLE_DATE", ""),
    messageKey: argOrEnv_("--message-key", "ENCOURAGEMENT_EMAIL_MESSAGE_KEY", ""),
    testRecipientEmail: argOrEnv_("--test-recipient-email", "ENCOURAGEMENT_TEST_RECIPIENT_EMAIL", ""),
    testRecipientName: argOrEnv_("--test-recipient-name", "ENCOURAGEMENT_TEST_RECIPIENT_NAME", "JEA Test Recipient")
  };

  let result;

  if (mode === "weekly-all") {
    result = await queueWeeklyEncouragementEmails(options);
  } else if (mode === "weekly-students") {
    result = await queueWeeklyStudentEncouragementEmails(options);
  } else if (mode === "weekly-teachers") {
    result = await queueWeeklyTeacherEncouragementEmails(options);
  } else {
    throw new Error("Unsupported --mode. Use weekly-all, weekly-students, or weekly-teachers.");
  }

  console.log(JSON.stringify({ ok: true, mode, options, result }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSupabasePool();
  });
