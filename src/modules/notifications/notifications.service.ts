import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { env } from '../../config/env';

/**
 * OneSignal Web Push — server-side only.
 * Site: https://westin-faculty.vercel.app (shared faculty+admin).
 * Student recipients are never included (blocked by role filter).
 * External IDs are faculty_<users.id> / admin_<users.id> via getOneSignalExternalId().
 */

// Shared helper — must stay identical to faculty_admin_portal/src/lib/onesignal.ts:getOneSignalExternalId
export function getOneSignalExternalId(user: { id: string; role: 'faculty' | 'admin' }): string {
  return `${user.role}_${user.id}`;
}

type SendInput = {
  title: string;
  message: string;
  target_type: 'all_faculty' | 'selected_faculty' | 'admins';
  faculty_ids?: string[];
  senderAdminId: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private db: DatabaseService) {}

  // ---------- faculty list (for Send checklist) ----------

  /** Lightweight active-faculty directory for the Send page checklist. Admin-only. */
  async facultyList(): Promise<Array<{ id: string; name: string; department: string }>> {
    const rows = await this.db.query<any>(
      `select u.id, u.display_name as name, coalesce(f.department,'—') as department
         from users u join faculty_profiles f on f.user_id = u.id
        where u.role='faculty' and u.status='active'
        order by coalesce(f.department,''), u.display_name`,
    );
    return rows.map((r: any) => ({ id: r.id, name: r.name, department: r.department }));
  }

  // ---------- settings ----------

  async getSettings(adminId: string): Promise<{ receiveFromOtherAdmins: boolean }> {
    const row = await this.db.queryOne<{ receive_from_other_admins: boolean }>(
      `select receive_from_other_admins from admin_notification_settings where admin_id=$1`,
      [adminId],
    );
    return { receiveFromOtherAdmins: row?.receive_from_other_admins ?? true };
  }

  async putSettings(adminId: string, value: boolean) {
    await this.db.query(
      `insert into admin_notification_settings (admin_id, receive_from_other_admins)
       values ($1,$2)
       on conflict (admin_id) do update set receive_from_other_admins=excluded.receive_from_other_admins, updated_at=now()`,
      [adminId, value],
    );
    return { receiveFromOtherAdmins: value };
  }

  // ---------- history ----------

  async history(params: {
    senderAdminId?: string;
    from?: string;
    to?: string;
    page?: number | string;
    pageSize?: number | string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const from = params.from ? new Date(params.from) : null;
    const to = params.to ? new Date(params.to) : null;
    const sender = params.senderAdminId ?? null;
    // Validate sender uuid if provided
    if (sender && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sender)) {
      throw new BadRequestException('Invalid senderAdminId');
    }
    if (from && Number.isNaN(from.getTime())) throw new BadRequestException('Invalid from date');
    if (to && Number.isNaN(to.getTime())) throw new BadRequestException('Invalid to date');

    const rows = await this.db.query<any>(
      `select n.id, n.sender_admin_id as "senderAdminId", u.display_name as "senderName",
              n.message_title as "messageTitle", n.message_body as "messageBody",
              n.target_type as "targetType", n.created_at as "createdAt",
              n.onesignal_notification_id as "onesignalNotificationId",
              count(r.id)::int as "recipientCount"
         from notifications n
         join users u on u.id=n.sender_admin_id
         left join notification_recipients r on r.notification_id=n.id
        where ($1::uuid is null or n.sender_admin_id=$1::uuid)
          and ($2::timestamptz is null or n.created_at >= $2::timestamptz)
          and ($3::timestamptz is null or n.created_at < ($3::date + interval '1 day'))
        group by n.id, u.display_name
        order by n.created_at desc
        limit $4 offset $5`,
      [sender, from?.toISOString() ?? null, to?.toISOString() ?? null, pageSize, offset],
    );
    const totalRow = await this.db.queryOne<{ c: string }>(
      `select count(*)::text as c from notifications n
        where ($1::uuid is null or n.sender_admin_id=$1::uuid)
          and ($2::timestamptz is null or n.created_at >= $2::timestamptz)
          and ($3::timestamptz is null or n.created_at < ($3::date + interval '1 day'))`,
      [sender, from?.toISOString() ?? null, to?.toISOString() ?? null],
    );
    const total = Number(totalRow?.c ?? 0);
    return { rows, total, page, pageSize };
  }

  async historyDetail(id: string) {
    const notif = await this.db.queryOne<any>(
      `select n.id, n.sender_admin_id as "senderAdminId", u.display_name as "senderName",
              n.message_title as "messageTitle", n.message_body as "messageBody",
              n.target_type as "targetType", n.created_at as "createdAt",
              n.onesignal_notification_id as "onesignalNotificationId"
         from notifications n join users u on u.id=n.sender_admin_id where n.id=$1`,
      [id],
    );
    if (!notif) throw new BadRequestException('Notification not found');
    const recipients = await this.db.query<any>(
      `select r.id, r.recipient_type as "recipientType", r.recipient_id as "recipientId",
              u.display_name as name, u.email,
              coalesce(f.department, ap.title, '—') as department,
              f.faculty_id as "facultyId", ap.admin_id as "adminId",
              r.delivered
         from notification_recipients r
         join users u on u.id=r.recipient_id
         left join faculty_profiles f on f.user_id=u.id
         left join admin_profiles ap on ap.user_id=u.id
        where r.notification_id=$1
        order by r.recipient_type, u.display_name`,
      [id],
    );
    return { ...notif, recipients, recipientCount: recipients.length };
  }

  // ---------- send ----------

  async send(input: SendInput) {
    const title = input.title?.trim();
    const message = input.message?.trim();
    if (!title) throw new BadRequestException('Title is required');
    if (!message) throw new BadRequestException('Message is required');
    if (title.length > 120) throw new BadRequestException('Title must be 120 characters or fewer');
    if (message.length > 500) throw new BadRequestException('Message must be 500 characters or fewer');

    // Resolve recipients server-side (never trust client counts)
    let recipients: Array<{ id: string; role: 'faculty' | 'admin' }> = [];

    if (input.target_type === 'all_faculty') {
      const rows = await this.db.query<{ id: string }>(
        `select u.id from users u join faculty_profiles f on f.user_id=u.id
          where u.role='faculty' and u.status='active'`,
      );
      recipients = rows.map((r) => ({ id: r.id, role: 'faculty' as const }));
      if (recipients.length === 0) throw new BadRequestException('No active faculty found');
    } else if (input.target_type === 'selected_faculty') {
      const ids = [...new Set((input.faculty_ids ?? []).map((s) => s.trim()).filter(Boolean))];
      if (ids.length === 0) throw new BadRequestException('Select at least one faculty member');
      // Validate all ids are active faculty
      const rows = await this.db.query<{ id: string }>(
        `select u.id from users u join faculty_profiles f on f.user_id=u.id
          where u.id = any($1::uuid[]) and u.role='faculty' and u.status='active'`,
        [ids],
      );
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => r.id));
        const missing = ids.filter((x) => !found.has(x));
        throw new BadRequestException(`Unknown or inactive faculty: ${missing.join(', ')}`);
      }
      recipients = rows.map((r) => ({ id: r.id, role: 'faculty' as const }));
    } else if (input.target_type === 'admins') {
      const rows = await this.db.query<{ id: string }>(
        `select u.id from users u
           left join admin_notification_settings s on s.admin_id=u.id
          where u.role='admin' and u.status='active'
            and u.id <> $1::uuid
            and coalesce(s.receive_from_other_admins,true)=true`,
        [input.senderAdminId],
      );
      if (rows.length === 0) {
        throw new BadRequestException('No other active admins to notify (all opted out).');
      }
      recipients = rows.map((r) => ({ id: r.id, role: 'admin' as const }));
    } else {
      throw new BadRequestException('Invalid target_type');
    }

    // Build OneSignal external IDs (single shared helper)
    const externalIds = recipients.map((r) => getOneSignalExternalId(r));

    // Call OneSignal REST API (modular, never exposed to frontend)
    const onesignalId = await this.callOneSignal({ title, message, externalIds });

    // Audit: one tx so notification + recipients are atomic
    const created = await this.db.tx(async (client) => {
      const nres = await client.query(
        `insert into notifications (sender_admin_id, message_title, message_body, target_type, onesignal_notification_id)
         values ($1,$2,$3,$4::notification_target,$5) returning id, created_at`,
        [input.senderAdminId, title, message, input.target_type, onesignalId],
      );
      const nid = nres.rows[0].id as string;
      const createdAt = nres.rows[0].created_at;
      // Bulk insert recipients using UNNEST (avoids N round-trips)
      const ids = recipients.map((r) => r.id);
      const types = recipients.map((r) => r.role);
      await client.query(
        `insert into notification_recipients (notification_id, recipient_type, recipient_id)
         select $1::uuid, unnest($2::recipient_type[]), unnest($3::uuid[])`,
        [nid, types, ids],
      );
      return { id: nid, createdAt };
    });

    // Return sender name for immediate UI display
    const sender = await this.db.queryOne<{ display_name: string }>(`select display_name from users where id=$1`, [
      input.senderAdminId,
    ]);

    return {
      id: created.id,
      senderAdminId: input.senderAdminId,
      senderName: sender?.display_name ?? null,
      messageTitle: title,
      messageBody: message,
      targetType: input.target_type,
      createdAt: created.createdAt,
      onesignalNotificationId: onesignalId,
      recipientCount: recipients.length,
    };
  }

  private async callOneSignal(args: { title: string; message: string; externalIds: string[] }): Promise<string | null> {
    const appId = env.onesignal.appId;
    const restKey = env.onesignal.restApiKey;
    const apiUrl = env.onesignal.apiUrl;

    // Key not configured: local dev skips the remote call so the audit flow can still be
    // exercised without OneSignal. Production must fail loudly — a silent skip makes the
    // send look successful in the UI while nothing is ever delivered.
    const keyMissing = !restKey || restKey.trim() === '' || restKey === 'REPLACE_WITH_REAL_REST_API_KEY';
    if (keyMissing) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error('ONESIGNAL_REST_API_KEY not configured in production — rejecting send');
        throw new ServiceUnavailableException(
          'Push notifications are not configured on the server (missing OneSignal REST API key). Nothing was sent.',
        );
      }
      this.logger.warn('ONESIGNAL_REST_API_KEY not configured — skipping OneSignal REST call (audit still recorded).');
      return null;
    }

    const body: Record<string, unknown> = {
      app_id: appId,
      include_aliases: { external_id: args.externalIds },
      target_channel: 'push',
      headings: { en: args.title },
      contents: { en: args.message },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${restKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new ServiceUnavailableException('OneSignal request timed out');
      throw new ServiceUnavailableException(`OneSignal request failed: ${e?.message ?? String(e)}`);
    }
    clearTimeout(t);

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json?.errors?.[0] ?? json?.error ?? json?.message ?? text ?? `OneSignal error ${res.status}`;
      this.logger.error(`OneSignal send failed ${res.status}: ${JSON.stringify(json)}`);
      // Surface as 400 so frontend shows actionable toast instead of 500
      throw new BadRequestException(`Push delivery failed: ${String(msg).slice(0, 300)}`);
    }

    // Response shape: { id: "<onesignal-notification-id>", recipients: <int>, ... }
    const nid: string | null = (json?.id as string) ?? (json?.notification_id as string) ?? null;
    if (!nid) this.logger.warn(`OneSignal sent but no id in response: ${text.slice(0, 500)}`);
    this.logger.log(`OneSignal sent id=${nid ?? 'n/a'} to ${args.externalIds.length} external_ids`);
    return nid;
  }
}
