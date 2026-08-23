/**
 * Local service-level test for student notification sends (no HTTP server, no DI).
 * Run: npx tsx scripts/test-student-send.ts
 *
 * With zero subscribed students this is EXPECTED to end in a loud
 * BadRequestException ("All N recipients have invalid push subscriptions") — that
 * failure is itself the proof that the send was routed to the STUDENT OneSignal app
 * with the student REST key and that the invalid-aliases handling works.
 */
import 'reflect-metadata';
import { DatabaseService } from '../src/database/database.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

async function main() {
  const db = new DatabaseService();
  await db.onModuleInit();
  const svc = new NotificationsService(db);
  try {
    const students = await svc.studentsList();
    console.log(`studentsList → ${students.length} active students; first:`, JSON.stringify(students[0]));

    const admin = await db.queryOne<{ id: string }>(
      `select id from users where role='admin' and status='active' limit 1`,
    );
    if (!admin) throw new Error('no active admin found in DB');
    console.log(`sender admin: ${admin.id}`);

    try {
      const res = await svc.send({
        title: 'Student plumbing test',
        message: 'Local service-level test — expect a loud failure until at least one student subscribes.',
        target_type: 'selected_students',
        student_ids: [students[0].id],
        senderAdminId: admin.id,
      });
      console.log('SEND RESULT (a student must be subscribed for this):', JSON.stringify(res));
    } catch (err: any) {
      console.log(`EXPECTED LOUD FAILURE → ${err.constructor?.name}: ${err.message}`);
    }
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error('TEST SCRIPT FAILED:', e);
  process.exit(1);
});
