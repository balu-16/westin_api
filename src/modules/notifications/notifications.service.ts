import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { env } from '../../config/env';
import { CreateTemplateDto, UpdateTemplateDto } from './notifications.dto';

/**
 * OneSignal Web Push — server-side only.
 * Faculty/admin recipients subscribe on https://westin-faculty.vercel.app (main app);
 * students on https://westin-student.vercel.app (separate app — same-origin policy).
 * External IDs are faculty_<users.id> / admin_<users.id> / student_<users.id>
 * via getOneSignalExternalId().
 */

// Shared helper — must stay identical to faculty_admin_portal/src/lib/onesignal.ts
// and Student_portal/src/lib/onesignal.ts getOneSignalExternalId
export function getOneSignalExternalId(user: { id: string; role: 'faculty' | 'admin' | 'student' }): string {
  return `${user.role}_${user.id}`;
}

type SendInput = {
  title: string;
  message: string;
  target_type: 'all_faculty' | 'selected_faculty' | 'admins' | 'all_students' | 'selected_students';
  faculty_ids?: string[];
  student_ids?: string[];
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

  /** Lightweight active-student directory for the Send page checklist. Admin-only. */
  async studentsList(): Promise<Array<{ id: string; name: string; studentId: string; department: string; year: string }>> {
    const rows = await this.db.query<any>(
      `select u.id, u.display_name as name, sp.student_id,
              coalesce(sp.department,'—') as department, coalesce(sp.year::text,'—') as year
         from users u join student_profiles sp on sp.user_id = u.id
        where u.role='student' and u.status='active'
        order by sp.student_id`,
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      studentId: r.student_id,
      department: r.department,
      year: r.year,
    }));
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

  // ---------- templates ----------

  /** Predefined messages for the Send page picker. Shared pool across admins. */
  async listTemplates(): Promise<TemplateJson[]> {
    const rows = await this.db.query<TemplateRow>(
      `select id, name, title, message, target_type, created_at, updated_at
         from notification_templates
        order by name asc`,
    );
    return rows.map(mapTemplate);
  }

  async createTemplate(dto: CreateTemplateDto, adminId: string): Promise<TemplateJson> {
    const row = await this.db.queryOne<TemplateRow>(
      `insert into notification_templates (name, title, message, target_type, created_by)
       values ($1, $2, $3, $4::notification_target, $5)
       returning id, name, title, message, target_type, created_at, updated_at`,
      [dto.name.trim(), dto.title.trim(), dto.message.trim(), dto.target_type ?? null, adminId],
    );
    return mapTemplate(row!);
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto): Promise<TemplateJson> {
    await this.findOneTemplateRow(id);

    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (dto.name !== undefined) set('name', dto.name.trim());
    if (dto.title !== undefined) set('title', dto.title.trim());
    if (dto.message !== undefined) set('message', dto.message.trim());
    // explicit null clears the default target
    if (dto.target_type !== undefined) set('target_type', dto.target_type);

    const updated = await this.db.queryOne<TemplateRow>(
      `update notification_templates set ${sets.join(', ')}
        where id = $${params.length + 1}::uuid
        returning id, name, title, message, target_type, created_at, updated_at`,
      [...params, id],
    );
    if (!updated) throw new NotFoundException('Template not found');
    return mapTemplate(updated);
  }

  async deleteTemplate(id: string) {
    await this.findOneTemplateRow(id);
    await this.db.query(`delete from notification_templates where id = $1`, [id]);
    return { deleted: true };
  }

  private async findOneTemplateRow(id: string): Promise<TemplateRow> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Template not found');
    const row = await this.db.queryOne<TemplateRow>(
      `select id, name, title, message, target_type, created_at, updated_at
         from notification_templates where id = $1::uuid`,
      [id],
    );
    if (!row) throw new NotFoundException('Template not found');
    return row;
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
      `select n.id, n.sender_admin_id as "senderAdminId", coalesce(u.display_name, 'System') as "senderName",
              n.message_title as "messageTitle", n.message_body as "messageBody",
              n.target_type as "targetType", n.kind as "kind", n.created_at as "createdAt",
              n.onesignal_notification_id as "onesignalNotificationId",
              count(r.id)::int as "recipientCount"
         from notifications n
         left join users u on u.id=n.sender_admin_id
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
      `select n.id, n.sender_admin_id as "senderAdminId", coalesce(u.display_name, 'System') as "senderName",
              n.message_title as "messageTitle", n.message_body as "messageBody",
              n.target_type as "targetType", n.kind as "kind", n.created_at as "createdAt",
              n.onesignal_notification_id as "onesignalNotificationId"
         from notifications n left join users u on u.id=n.sender_admin_id where n.id=$1`,
      [id],
    );
    if (!notif) throw new BadRequestException('Notification not found');
    const recipients = await this.db.query<any>(
      `select r.id, r.recipient_type as "recipientType", r.recipient_id as "recipientId",
              u.display_name as name, u.email,
              coalesce(f.department, sp.department, ap.title, '—') as department,
              f.faculty_id as "facultyId", ap.admin_id as "adminId", sp.student_id as "studentId",
              r.delivered
         from notification_recipients r
         join users u on u.id=r.recipient_id
         left join faculty_profiles f on f.user_id=u.id
         left join admin_profiles ap on ap.user_id=u.id
         left join student_profiles sp on sp.user_id=u.id
         where r.notification_id=$1
         order by r.recipient_type, u.display_name`,
      [id],
    );
    return { ...notif, recipients, recipientCount: recipients.length };
  }

  // ---------- recipient inbox (in-app) ----------

  /** Notifications addressed to the logged-in user (any role), newest first. */
  async myNotifications(userId: string, limit = 30) {
    const cap = Math.min(50, Math.max(1, Number(limit) || 30));
    const items = await this.db.query<any>(
      `select n.id, n.message_title as title, n.message_body as body,
              n.created_at as "createdAt", r.read_at as "readAt"
         from notification_recipients r
         join notifications n on n.id = r.notification_id
        where r.recipient_id = $1::uuid
        order by n.created_at desc
        limit $2`,
      [userId, cap],
    );
    const unreadRow = await this.db.queryOne<{ c: string }>(
      `select count(*)::text as c from notification_recipients where recipient_id = $1::uuid and read_at is null`,
      [userId],
    );
    return { items, unread: Number(unreadRow?.c ?? 0) };
  }

  /** Mark one notification as read for this recipient. No-op if not addressed to them. */
  async markRead(userId: string, notificationId: string) {
    await this.db.query(
      `update notification_recipients set read_at = coalesce(read_at, now())
        where recipient_id = $1::uuid and notification_id = $2::uuid and read_at is null`,
      [userId, notificationId],
    );
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.db.query(
      `update notification_recipients set read_at = coalesce(read_at, now())
        where recipient_id = $1::uuid and read_at is null`,
      [userId],
    );
    return { ok: true };
  }

  /**
   * Courtesy push sent when a user subscribes for the FIRST time (frontend fires
   * POST /notifications/thanks from OneSignal's PushSubscription change event when
   * a brand-new subscription is created). Not recorded in admin History — it is a
   * welcome, not a college notification.
   */
  async sendSubscriptionThanks(user: { id: string; role: 'faculty' | 'admin' | 'student' }) {
    const app: 'faculty' | 'student' = user.role === 'student' ? 'student' : 'faculty';
    try {
      const nid = await this.callOneSignal({
        title: 'Westin',
        message: 'Thanks for subscribing — college notifications will now reach you here.',
        externalIds: [getOneSignalExternalId(user)],
        app,
      });
      return { sent: !!nid };
    } catch (err) {
      // Courtesy push only — never break the login/subscription flow.
      this.logger.warn(`subscription thanks push failed: ${(err as Error).message}`);
      return { sent: false };
    }
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
    let recipients: Array<{ id: string; role: 'faculty' | 'admin' | 'student' }> = [];

    if (input.target_type === 'all_faculty') {
      recipients = await this.activeFaculty();
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
    } else if (input.target_type === 'all_students') {
      recipients = await this.activeStudents();
      if (recipients.length === 0) throw new BadRequestException('No active students found');
    } else if (input.target_type === 'selected_students') {
      const ids = [...new Set((input.student_ids ?? []).map((s) => s.trim()).filter(Boolean))];
      if (ids.length === 0) throw new BadRequestException('Select at least one student');
      // Validate all ids are active students
      const rows = await this.db.query<{ id: string }>(
        `select u.id from users u join student_profiles sp on sp.user_id = u.id
          where u.id = any($1::uuid[]) and u.role='student' and u.status='active'`,
        [ids],
      );
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => r.id));
        const missing = ids.filter((x) => !found.has(x));
        throw new BadRequestException(`Unknown or inactive students: ${missing.join(', ')}`);
      }
      recipients = rows.map((r) => ({ id: r.id, role: 'student' as const }));
    } else {
      throw new BadRequestException('Invalid target_type');
    }

    // Build OneSignal external IDs (single shared helper)
    const externalIds = recipients.map((r) => getOneSignalExternalId(r));

    // Students subscribe on their own origin → their own OneSignal app
    const app: 'faculty' | 'student' =
      input.target_type === 'all_students' || input.target_type === 'selected_students' ? 'student' : 'faculty';

    // Call OneSignal REST API (modular, never exposed to frontend)
    const onesignalId = await this.callOneSignal({ title, message, externalIds, app });

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

  // ---------- system sends (auto triggers) ----------

  /**
   * System-generated push (announcement posted, event added, student marked
   * absent, daily-report reminder). Recipients are resolved by the caller;
   * this validates, pushes once per OneSignal app (faculty/admin subscribe on
   * the faculty origin, students on their own), and records the audit rows
   * with a null sender. Callers fire-and-forget with a catch: a push failure
   * must never break the business action that triggered it.
   */
  async sendSystem(input: {
    kind: 'announcement' | 'event' | 'attendance_absent' | 'report_reminder';
    title: string;
    message: string;
    recipients: Array<{ id: string; role: 'faculty' | 'admin' | 'student' }>;
  }): Promise<void> {
    const title = input.title?.trim();
    const message = input.message?.trim();
    if (!title || !message || title.length > 120 || message.length > 500) {
      throw new BadRequestException('Invalid system notification payload');
    }

    // Dedupe — a recipient appearing twice (bad trigger input) must not double-push.
    const seen = new Set<string>();
    let recipients = input.recipients.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

    // Kind-scoped audiences: absent marks concern students only, report
    // reminders faculty only. Filter defensively so a caller passing the wrong
    // roles (e.g. a future trigger bug) can never leak across audiences.
    if (input.kind === 'attendance_absent') {
      recipients = recipients.filter((r) => r.role === 'student');
    } else if (input.kind === 'report_reminder') {
      recipients = recipients.filter((r) => r.role === 'faculty');
    }
    if (recipients.length === 0) return;

    const facultySide = recipients.filter((r) => r.role !== 'student');
    const studentSide = recipients.filter((r) => r.role === 'student');

    // Per-app: "nobody on this app has subscribed yet" is a normal early-adoption
    // state for auto triggers — skip that app instead of failing the whole send
    // (manual admin sends still fail loudly by design).
    const pushApp = async (app: 'faculty' | 'student', side: typeof recipients) => {
      try {
        return await this.callOneSignal({
          title,
          message,
          externalIds: side.map(getOneSignalExternalId),
          app,
        });
      } catch (err) {
        if (
          err instanceof BadRequestException &&
          /not subscribed|invalid push subscriptions/i.test(String(err.message))
        ) {
          this.logger.warn(
            `system push (${input.kind}) skipped on ${app} app — none of ${side.length} recipients subscribed`,
          );
          return null;
        }
        throw err;
      }
    };

    const ids: (string | null)[] = [];
    if (facultySide.length > 0) ids.push(await pushApp('faculty', facultySide));
    if (studentSide.length > 0) ids.push(await pushApp('student', studentSide));
    if (ids.every((x) => x === null)) {
      this.logger.warn(`system push (${input.kind}) reached nobody — no audit rows written`);
      return;
    }
    const onesignalId = ids.filter((x): x is string => !!x).join(',') || null;

    await this.db.tx(async (client) => {
      const nres = await client.query(
        `insert into notifications (sender_admin_id, message_title, message_body, target_type, kind, onesignal_notification_id)
         values (null, $1, $2, 'system', $3, $4) returning id`,
        [title, message, input.kind, onesignalId],
      );
      const nid = nres.rows[0].id as string;
      const recipientIds = recipients.map((r) => r.id);
      const types = recipients.map((r) => r.role);
      await client.query(
        `insert into notification_recipients (notification_id, recipient_type, recipient_id)
         select $1::uuid, unnest($2::recipient_type[]), unnest($3::uuid[])`,
        [nid, types, recipientIds],
      );
    });
  }

  /** Shared recipient resolution for broadcast + system sends (also used by trigger modules). */
  async activeFaculty(): Promise<Array<{ id: string; role: 'faculty' }>> {
    const rows = await this.db.query<{ id: string }>(
      `select u.id from users u join faculty_profiles f on f.user_id=u.id
        where u.role='faculty' and u.status='active'`,
    );
    return rows.map((r) => ({ id: r.id, role: 'faculty' as const }));
  }

  async activeStudents(): Promise<Array<{ id: string; role: 'student' }>> {
    const rows = await this.db.query<{ id: string }>(
      `select u.id from users u join student_profiles sp on sp.user_id = u.id
        where u.role='student' and u.status='active'`,
    );
    return rows.map((r) => ({ id: r.id, role: 'student' as const }));
  }

  private async callOneSignal(args: {
    title: string;
    message: string;
    externalIds: string[];
    app: 'faculty' | 'student';
  }): Promise<string | null> {
    // Faculty/admin recipients live in the faculty-portal app; students in the student app
    // (separate origins → separate OneSignal apps, per browser same-origin policy).
    const cfg =
      args.app === 'student'
        ? { appId: env.onesignalStudents.appId, restKey: env.onesignalStudents.restApiKey }
        : { appId: env.onesignal.appId, restKey: env.onesignal.restApiKey };
    const apiUrl = env.onesignal.apiUrl;

    // Key not configured: local dev skips the remote call so the audit flow can still be
    // exercised without OneSignal. Production must fail loudly — a silent skip makes the
    // send look successful in the UI while nothing is ever delivered.
    const keyMissing = !cfg.restKey || cfg.restKey.trim() === '' || cfg.restKey === 'REPLACE_WITH_REAL_REST_API_KEY';
    if (keyMissing) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(`ONESIGNAL REST key for the ${args.app} app not configured in production — rejecting send`);
        throw new ServiceUnavailableException(
          `Push notifications are not configured on the server (missing OneSignal REST key for the ${args.app} app). Nothing was sent.`,
        );
      }
      this.logger.warn(`ONESIGNAL REST key for the ${args.app} app not configured — skipping OneSignal REST call (audit still recorded).`);
      return null;
    }

    // OneSignal caps aliases per request — chunk large blasts (no-op at current scale).
    const CHUNK = 2000;
    const collected: (string | null)[] = [];
    for (let base = 0; base < args.externalIds.length; base += CHUNK) {
      let externalIds = args.externalIds.slice(base, base + CHUNK);
      // OneSignal rejects the ENTIRE send with `invalid_aliases` if any external_id maps to a
      // subscription in an invalid state (e.g. a browser that blocked the permission prompt —
      // notification_types -2, no token). The error lists the bad aliases, so drop them and
      // retry with the valid subset: one poisoned recipient must not block everyone else.
      for (let attempt = 0; ; attempt++) {
        const body: Record<string, unknown> = {
          app_id: cfg.appId,
          include_aliases: { external_id: externalIds },
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
              Authorization: `Key ${cfg.restKey}`,
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

        const invalid: string[] = json?.errors?.invalid_aliases?.external_id ?? [];
        // OneSignal sometimes reports a total no-op as HTTP 200 with an empty id and an
        // errors array (e.g. "All included players are not subscribed" when nobody in the
        // target list has subscribed yet). That is a failed send, not a success.
        const softErrors: string[] = Array.isArray(json?.errors) ? json.errors : [];
        if (res.ok && softErrors.length > 0 && !json?.id) {
          this.logger.error(`OneSignal soft failure: ${JSON.stringify(json)}`);
          throw new BadRequestException(`Push delivery failed: ${softErrors.join('; ').slice(0, 300)}`);
        }
        if (!res.ok && invalid.length > 0 && externalIds.length > invalid.length && attempt < 3) {
          this.logger.warn(
            `OneSignal invalid_aliases (${invalid.length}) — retrying with ${externalIds.length - invalid.length}/${externalIds.length} external_ids`,
          );
          const bad = new Set<string>(invalid);
          externalIds = externalIds.filter((id) => !bad.has(id));
          continue;
        }

        if (!res.ok) {
          const msg =
            invalid.length > 0
              ? `All ${externalIds.length} recipients have invalid push subscriptions (permission blocked or never granted)`
              : (json?.errors?.[0] ?? json?.error ?? json?.message ?? text ?? `OneSignal error ${res.status}`);
          this.logger.error(`OneSignal send failed ${res.status}: ${JSON.stringify(json)}`);
          // Surface as 400 so frontend shows actionable toast instead of 500
          throw new BadRequestException(`Push delivery failed: ${String(msg).slice(0, 300)}`);
        }

        // Response shape: { id: "<onesignal-notification-id>", recipients: <int>, ... }
        const nid: string | null = (json?.id as string) ?? (json?.notification_id as string) ?? null;
        if (!nid) this.logger.warn(`OneSignal sent but no id in response: ${text.slice(0, 500)}`);
        this.logger.log(`OneSignal sent id=${nid ?? 'n/a'} to ${externalIds.length} external_ids`);
        collected.push(nid);
        break;
      }
    }
    const ids = collected.filter((x): x is string => !!x);
    return ids.length === 0 ? null : ids.join(',');
  }
}

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  message: string;
  target_type: 'all_faculty' | 'selected_faculty' | 'admins' | 'all_students' | 'selected_students' | null;
  created_at: Date;
  updated_at: Date;
};

export type TemplateJson = {
  id: string;
  name: string;
  title: string;
  message: string;
  targetType: TemplateRow['target_type'];
  createdAt: string;
  updatedAt: string;
};

function mapTemplate(r: TemplateRow): TemplateJson {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    message: r.message,
    targetType: r.target_type,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
