/**
 * End-to-end test: send EVERY notification type to three specific people
 * through the real service code paths (live OneSignal REST keys from .env).
 *
 *   Rakesh    (admin)    → receives via faculty app (westin-faculty.vercel.app)
 *   Viswa Teja(faculty)  → receives via faculty app
 *   Balarakesh(student)  → receives via student app (westin-student.vercel.app)
 *
 * Sends: the 4 auto-trigger kinds (announcement / event / attendance_absent /
 * report_reminder) via sendSystem to all three, plus two manual template-based
 * sends (selected_students → Balarakesh, selected_faculty → Viswa).
 * Run: npx tsx scripts/test-send-three.ts
 */
import 'reflect-metadata';
import { DatabaseService } from '../src/database/database.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const RAKESH_ADMIN = '33f3c9d6-4d5e-432c-87ae-263baf741c15';
const VISWA_FACULTY = 'f43beb11-7216-4231-8e1c-7eefd0a80ff7';
const BALARAKESH_STUDENT = '991a7c7c-49fc-402b-9cc9-b55406a4ffd9';

const ALL_THREE = [
  { id: RAKESH_ADMIN, role: 'admin' as const },
  { id: VISWA_FACULTY, role: 'faculty' as const },
  { id: BALARAKESH_STUDENT, role: 'student' as const },
];

async function main() {
  const db = new DatabaseService();
  await db.onModuleInit();
  const svc = new NotificationsService(db);
  try {
    // ---- auto-trigger kinds (sendSystem → faculty app + student app) ----
    const kinds: Array<{ kind: 'announcement' | 'event' | 'attendance_absent' | 'report_reminder'; title: string; message: string }> = [
      {
        kind: 'announcement',
        title: '[TEST] New Announcement',
        message: 'Test of the announcement auto-trigger: staff meeting Monday at 10 AM in the conference hall.',
      },
      {
        kind: 'event',
        title: '[TEST] New Event: Cultural Fest',
        message: '2026-08-28 at 09:00 AM • Main Auditorium',
      },
      {
        kind: 'attendance_absent',
        title: '[TEST] Absent Marked',
        message: 'You were marked absent for Data Structures on 2026-08-23 (Period 3). If this is a mistake, contact your class teacher.',
      },
      {
        kind: 'report_reminder',
        title: '[TEST] Daily Report Reminder',
        message: "Only 4 hours left to submit today's daily report: DBMS (CSE-A), CN (CSE-B). Please upload it before midnight.",
      },
    ];

    for (const k of kinds) {
      // All kinds pass all three ids on purpose — sendSystem's kind-scoping
      // must filter attendance_absent down to the student by itself.
      try {
        await svc.sendSystem({ ...k, recipients: ALL_THREE });
        console.log(
          `✔ ${k.kind} sent${k.kind === 'attendance_absent' ? ' (admin/faculty filtered out → Balarakesh only)' : ' to Rakesh + Viswa + Balarakesh'}`,
        );
      } catch (err: any) {
        console.log(`✘ ${k.kind} FAILED → ${err.constructor?.name}: ${err.message}`);
      }
    }

    // ---- manual template-based sends (svc.send, the admin Send page path) ----
    const templates = await svc.listTemplates();
    const holiday = templates.find((t) => t.name === 'Holiday Tomorrow');
    if (holiday) {
      try {
        const res = await svc.send({
          title: holiday.title,
          message: holiday.message,
          target_type: 'selected_students',
          student_ids: [BALARAKESH_STUDENT],
          senderAdminId: RAKESH_ADMIN,
        });
        console.log(`✔ template "${holiday.name}" (manual send) → Balarakesh (${res.recipientCount} recipient)`);
      } catch (err: any) {
        console.log(`✘ template "${holiday.name}" FAILED → ${err.message}`);
      }
    }

    const reportTpl = templates.find((t) => t.name === 'Daily Report Reminder');
    if (reportTpl) {
      try {
        const res = await svc.send({
          title: reportTpl.title,
          message: reportTpl.message,
          target_type: 'selected_faculty',
          faculty_ids: [VISWA_FACULTY],
          senderAdminId: RAKESH_ADMIN,
        });
        console.log(`✔ template "${reportTpl.name}" (manual send) → Viswa (${res.recipientCount} recipient)`);
      } catch (err: any) {
        // Expected until Viswa enables notifications from his own browser.
        console.log(`✘ template "${reportTpl.name}" FAILED → ${err.message}`);
      }
    }

    // ---- audit proof ----
    const recent = await db.query<any>(
      `select n.kind, coalesce(u.display_name,'System') as sender, n.message_title, count(r.id)::int as recs
         from notifications n
         left join users u on u.id = n.sender_admin_id
         left join notification_recipients r on r.notification_id = n.id
        where n.created_at > now() - interval '5 minutes'
        group by n.id, u.display_name
        order by n.created_at desc`,
    );
    console.log('\naudit rows (last 5 min):');
    for (const row of recent) console.log(`  [${row.kind ?? 'manual'}] ${row.sender}: "${row.message_title}" → ${row.recs} recipients`);
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error('TEST SCRIPT FAILED:', e);
  process.exit(1);
});
