/**
 * Local service-level test for the auto-trigger notification paths (no HTTP
 * server, no DI). Run: npx tsx scripts/test-triggers.ts
 *
 * Default run is side-effect-free: template CRUD on its own test row, a
 * sendSystem routing probe with a fake external id (real OneSignal key →
 * all-invalid → soft-skip path, nothing delivered), the read-only pending-
 * faculty query, and System-sender history rendering.
 *
 * `--send` additionally performs REAL sends: an announcement-kind push to a
 * small sample of active users and the 4h daily-report reminder to pending
 * faculty — use it to verify delivery on subscribed test devices.
 */
import 'reflect-metadata';
import { DatabaseService } from '../src/database/database.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { ReportReminderService } from '../src/modules/notifications/report-reminder.service';
import { kolkataNow } from '../src/common/util/time';

const LIVE = process.argv.includes('--send');
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

async function main() {
  const db = new DatabaseService();
  await db.onModuleInit();
  const notifications = new NotificationsService(db);
  const reminders = new ReportReminderService(db, notifications);
  try {
    // ---- templates CRUD ----
    const admin = await db.queryOne<{ id: string }>(
      `select id from users where role='admin' and status='active' limit 1`,
    );
    if (!admin) throw new Error('no active admin found in DB');

    const listed = await notifications.listTemplates();
    console.log(`templates listed → ${listed.length}; first: ${listed[0]?.name}`);

    const created = await notifications.createTemplate(
      { name: 'Trigger Test', title: 'Test title', message: 'Test message', target_type: 'all_faculty' },
      admin.id,
    );
    console.log(`template created → ${created.id}`);
    const updated = await notifications.updateTemplate(created.id, { name: 'Trigger Test v2' });
    console.log(`template updated → ${updated.name}`);
    const deleted = await notifications.deleteTemplate(created.id);
    console.log(`template deleted → ${JSON.stringify(deleted)}`);

    // ---- sendSystem routing probe (fake external id → soft-skip, nothing sent) ----
    await notifications.sendSystem({
      kind: 'announcement',
      title: 'Routing probe (fake id)',
      message: 'Should soft-skip — no audit row expected.',
      recipients: [{ id: FAKE_UUID, role: 'student' }],
    });
    console.log('routing probe done (soft-skip expected — no audit row)');

    // ---- history renders System rows ----
    const history = await notifications.history({ page: 1, pageSize: 5 });
    console.log(
      'history top rows:',
      history.rows.map((r: any) => `${r.senderName} [${r.targetType}${r.kind ? ':' + r.kind : ''}]`).join(' | ') || '(none)',
    );

    // ---- pending faculty (read-only) ----
    const { todayDow, today } = kolkataNow();
    const pending = await reminders.pendingFaculty(todayDow, today);
    console.log(
      `report reminder would reach ${pending.length} faculty today (${today}, dow=${todayDow})`,
      pending.slice(0, 3).map((p) => `${p.id.slice(0, 8)}: ${p.pending.join(', ')}`),
    );

    if (!LIVE) {
      console.log('\ndry run complete — pass --send to exercise real delivery.');
      return;
    }

    // ---- live: announcement-kind send to a sample + real reminder blast ----
    const faculty = await notifications.activeFaculty();
    const students = await notifications.activeStudents();
    const sample = [...faculty.slice(0, 2), ...students.slice(0, 2)];
    console.log(`LIVE sample: ${faculty.length} faculty / ${students.length} students active; sending to ${sample.length}`);
    await notifications.sendSystem({
      kind: 'announcement',
      title: 'Trigger test announcement',
      message: 'Local service-level test of the system send path.',
      recipients: sample,
    });
    const check = await db.queryOne<any>(
      `select n.id, n.kind, n.target_type, coalesce(u.display_name,'System') as sender, count(r.id)::int as recs
         from notifications n
         left join users u on u.id = n.sender_admin_id
         left join notification_recipients r on r.notification_id = n.id
        where n.kind = 'announcement'
        group by n.id, u.display_name
        order by n.created_at desc limit 1`,
    );
    console.log('sendSystem audit row:', check ? JSON.stringify(check) : '(none — nobody in the sample is subscribed)');

    const sent = await reminders.remindPendingFaculty(4, todayDow, today);
    console.log(`LIVE report reminder (4h) pushed to ${sent} faculty`);
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error('TEST SCRIPT FAILED:', e);
  process.exit(1);
});
