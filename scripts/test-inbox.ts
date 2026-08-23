/**
 * Local service-level test for the recipient inbox endpoints (no HTTP server).
 * Run: npx tsx scripts/test-inbox.ts
 * Reads the real notification_recipients rows for one recipient, exercises
 * myNotifications / markRead / markAllRead, then RESTORES read_at to its
 * original state so no in-app data is left modified.
 */
import 'reflect-metadata';
import { DatabaseService } from '../src/database/database.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

async function main() {
  const db = new DatabaseService();
  await db.onModuleInit();
  const svc = new NotificationsService(db);
  try {
    const any = await db.queryOne<{ recipient_id: string; read_at: string | null }>(
      `select recipient_id, read_at from notification_recipients order by created_at desc limit 1`,
    );
    if (!any) {
      console.log('no recipient rows in DB — nothing to test against');
      return;
    }
    console.log(`testing inbox for recipient ${any.recipient_id} (read_at was: ${any.read_at ?? 'null'})`);

    const before = await svc.myNotifications(any.recipient_id, 10);
    console.log(`myNotifications → ${before.items.length} items, unread=${before.unread}`);
    if (before.items[0]) console.log('  latest:', JSON.stringify(before.items[0]));

    if (before.items[0]) {
      await svc.markRead(any.recipient_id, before.items[0].id);
      const mid = await svc.myNotifications(any.recipient_id, 10);
      console.log(`after markRead(first) → unread=${mid.unread} (was ${before.unread})`);
    }

    await svc.markAllRead(any.recipient_id);
    const after = await svc.myNotifications(any.recipient_id, 10);
    console.log(`after markAllRead → unread=${after.unread}`);

    // Restore original state for the rows we touched
    await db.query(
      `update notification_recipients set read_at=$2 where recipient_id=$1 and notification_id = any($3::uuid[])`,
      [any.recipient_id, any.read_at, before.items.map((i: { id: string }) => i.id)],
    );
    console.log('restored original read state ✓');
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error('TEST SCRIPT FAILED:', e);
  process.exit(1);
});
