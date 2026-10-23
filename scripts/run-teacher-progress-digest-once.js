import { generateTeacherDigestsForActiveTeachers } from "../src/supabase/teacherDigestRepository.js";

function envBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["true", "1", "yes", "y", "on"].includes(value);
}

try {
  const result = await generateTeacherDigestsForActiveTeachers({
    cycleDate: process.env.TEACHER_DIGEST_CYCLE_DATE || "",
    force: envBool("TEACHER_DIGEST_FORCE", false),
    teacherId: process.env.TEACHER_DIGEST_TEACHER_ID || "",
    teacherEmail: process.env.TEACHER_DIGEST_TEACHER_EMAIL || "",
    teacherLimit: Number(process.env.TEACHER_DIGEST_TEACHER_LIMIT || process.env.TEACHER_DIGEST_LIMIT || 50),
    studentsPerPdf: Number(process.env.TEACHER_DIGEST_STUDENTS_PER_PDF || 25)
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-teacher-progress-digest-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}
