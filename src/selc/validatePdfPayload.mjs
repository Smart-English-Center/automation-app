// Call before submitting these payloads to PDFMonkey. Not yet wired into the SELC worker.
function fail(message) { throw new Error(`Invalid SELC PDF payload: ${message}`); }
function list(value, name) { if (!Array.isArray(value)) fail(`${name} must be an array`); return value; }
function text(value, name) { if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`); }
function positive(value, name) { if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`); }
function link(value, preview, whatsapp = false) {
  if (!value) return;
  let url; try { url = new URL(value); } catch { fail('malformed link'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('links must use HTTPS without URL credentials');
  if (url.hostname.endsWith('.invalid')) { if (!preview) fail('demo link in production'); return; }
  if (whatsapp && (url.hostname !== 'wa.me' || !/^\/[1-9]\d{6,14}$/.test(url.pathname) || !url.searchParams.get('text'))) fail('invalid WhatsApp message URL');
}
function base(payload) {
  if (!payload || typeof payload !== 'object') fail('object required');
  text(payload.teacher?.teacher_name, 'teacher.teacher_name');
  positive(payload.document?.part_number, 'document.part_number');
  positive(payload.document?.total_parts, 'document.total_parts');
  if (payload.document.part_number > payload.document.total_parts) fail('part number exceeds total parts');
  if (payload.preview_mode !== undefined && typeof payload.preview_mode !== 'boolean') fail('preview_mode must be boolean');
}
function unique(students) {
  const ids = new Set();
  for (const s of students) { text(s.student_id, 'student_id'); if (ids.has(s.student_id)) fail('duplicate student in document'); ids.add(s.student_id); text(s.student_name, 'student_name'); }
  return ids;
}
export function validateDigest(payload) {
  base(payload);
  if (payload.quizzes_enabled !== false) fail('quiz importing is deferred; quizzes_enabled must be false');
  const entries = [...list(payload.sections?.needs_encouragement, 'sections.needs_encouragement'), ...list(payload.sections?.students_with_activity, 'sections.students_with_activity')];
  if (entries.length > 25) fail('split into additional documents; maximum 25 students per part');
  const ids = unique(entries);
  if (payload.all_students) {
    const all = unique(list(payload.all_students, 'all_students'));
    if (all.size !== ids.size || [...all].some(id => !ids.has(id))) fail('section entries must cover this part exactly once');
  }
  for (const s of entries) {
    link(s.whatsapp_url, payload.preview_mode, true); link(s.feedback_link, payload.preview_mode);
    for (const f of s.assignment_feedback_sent || []) link(f.feedback_link || f.pdf_drive_url || f.pdf_url || f.pdf_file_url, payload.preview_mode);
    for (const key of ['assignment_submission_count','feedback_email_count']) if (!Number.isInteger(s[key]) || s[key] < 0) fail(`${key} must be a non-negative integer`);
  }
  for (const key of ['active_student_count','assignment_submission_count','feedback_emails_sent_count','students_needing_follow_up_count']) if (!Number.isInteger(payload.summary?.[key]) || payload.summary[key] < 0) fail(`summary.${key} must be a non-negative integer`);
  text(payload.document.window_range_en, 'document.window_range_en');
  return payload;
}
export function validateTopics(payload) {
  base(payload);
  if (!['A1','A2','B1','B2','C1'].includes(payload.document.level)) fail('unsupported level');
  text(payload.document.practice_date, 'document.practice_date');
  if (list(payload.topics,'topics').length !== 2) fail('exactly two topics required');
  for (const t of payload.topics) {
    text(t.title,'topic.title'); text(t.instructions,'topic.instructions'); text(t.instruction_language,'topic.instruction_language');
    if (!list(t.questions,'topic.questions').length) fail('at least one speaking question required');
    for (const q of t.questions) text(q,'speaking question');
    if (t.role_play) { text(t.role_play.scenario,'role_play.scenario'); for (const r of ['role_a','role_b']) {text(t.role_play[r]?.name,r+'.name');text(t.role_play[r]?.instructions,r+'.instructions');} }
  }
  const students=list(payload.recipients,'recipients');
  if (students.length > 25) fail('split into additional documents; maximum 25 recipients per part');
  unique(students);
  for (const s of students) { if(s.level !== payload.document.level) fail('recipient level differs from topic level'); text(s.email_delivery_status,'email_delivery_status'); link(s.whatsapp_url,payload.preview_mode,true); }
  return payload;
}
