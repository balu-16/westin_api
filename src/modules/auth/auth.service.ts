import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { StorageService, BUCKETS } from '../storage/storage.service';
import { hmacSha256, randomOtp, randomToken, safeEqual, sha256, verifyPassword } from '../../common/util/crypto';

const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 7;
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_THROTTLE_SECONDS = 30;
const OTP_MAX_ATTEMPTS = 5;
const MAX_ACTIVE_SESSIONS = 2;

export type UserPayload = {
  id: string;
  role: 'student' | 'faculty' | 'admin';
  name: string;
  firstName: string;
  email: string;
  department: string | null;
  designation: string | null;
  studentId: string | null;
  facultyId: string | null;
  adminId: string | null;
  year: number | null;
  sectionId: string | null;
  sectionLabel: string | null;
  rollNo: string | null;
  overallAttendance: number | null;
  avatarUrl: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private mail: MailService,
    private storage: StorageService,
  ) {}

  /** Find an active user by email or portal id (STU-…, FAC-…, ADM-…). */
  private findUser(identifier: string) {
    const id = identifier.trim().toLowerCase();
    return this.db.queryOne<any>(
      `select u.id, u.role, u.email, u.password_hash, u.display_name, u.status, u.avatar_path,
              f.faculty_id, f.designation, f.department,
              a.admin_id,
              s.student_id, s.year as student_year, s.department as student_dept,
              s.section_id, s.roll_no, sec.label as section_label
         from users u
         left join faculty_profiles f on f.user_id = u.id
         left join admin_profiles a on a.user_id = u.id
         left join student_profiles s on s.user_id = u.id
         left join sections sec on sec.id = s.section_id
        where lower(u.email) = $1
           or lower(f.faculty_id) = $1
           or lower(s.student_id) = $1
           or lower(a.admin_id) = $1
        limit 1`,
      [id],
    );
  }

  /** Password login is for students only — faculty/admin accounts are
   *  OTP-only and have no password hash at all. */
  async login(identifier: string, password: string, meta: { ip?: string; device?: string }) {
    const user = await this.findUser(identifier);
    if (!user) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_REGISTERED',
        message: 'This email is not registered. Please contact your college administration.',
      });
    }
    if (user.role !== 'student') {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'This account cannot sign in with password. Please use the correct portal.',
      });
    }
    if (!verifyPassword(password, user.password_hash)) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'The password is incorrect.',
      });
    }
    if (user.status !== 'active') throw new ForbiddenException({ code: 'ACCOUNT_INACTIVE', message: 'This account is inactive. Contact your college administration.' });
    return this.issueSession(user, meta);
  }

  async requestOtp(identifier: string, portal?: string) {
    const user = await this.findUser(identifier);
    if (!user) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_REGISTERED',
        message: portal
          ? `This email is not registered for the Westin ${portal === 'admin' ? 'Admin' : 'Faculty'} Portal.`
          : 'This email is not registered. Please contact your college administration.',
      });
    }
    if (user.status !== 'active') {
      throw new ForbiddenException({ code: 'ACCOUNT_INACTIVE', message: 'This account is inactive. Contact your college administration.' });
    }
    if (user.role === 'student') {
      throw new ForbiddenException({
        code: 'PORTAL_ACCESS_DENIED',
        message: 'This account cannot sign in to the Faculty/Admin Portal.',
      });
    }
    if (portal && user.role !== portal) {
      throw new ForbiddenException({
        code: 'PORTAL_ACCESS_DENIED',
        message: `This account cannot sign in to the Westin ${portal === 'admin' ? 'Admin' : 'Faculty'} Portal.`,
      });
    }

    const recent = await this.db.queryOne<any>(
      `select created_at from otp_codes
        where user_id = $1 and created_at > now() - interval '${OTP_RESEND_THROTTLE_SECONDS} seconds'
        order by created_at desc limit 1`,
      [user.id],
    );
    if (recent) {
      throw new BadRequestException(
        `Please wait ${OTP_RESEND_THROTTLE_SECONDS}s before requesting a new code`,
      );
    }

    const code = randomOtp();
    const inserted = await this.db.query<{ id: string }>(
      `insert into otp_codes (user_id, code_hash, expires_at)
       values ($1, $2, now() + interval '${OTP_TTL_MINUTES} minutes') returning id`,
      [user.id, hmacSha256(env.otpPepper, code)],
    );
    const otpId = (inserted[0] as any)?.id;
    try {
      await this.mail.sendOtp(user.email, code, 'portal login');
    } catch (err: any) {
      // Clean up the OTP row so a failed delivery doesn't leave a usable code
      if (otpId) await this.db.query(`delete from otp_codes where id=$1`, [otpId]).catch(() => {});
      throw new BadRequestException(err.message || 'Failed to send OTP — please try again');
    }
    return { sent: true, expiresIn: OTP_TTL_MINUTES * 60 };
  }

  async verifyOtp(identifier: string, code: string, meta: { ip?: string; device?: string }) {
    const user = await this.findUser(identifier);
    if (!user) {
      throw new UnauthorizedException({ code: 'ACCOUNT_NOT_REGISTERED', message: 'This email is not registered.' });
    }
    if (user.status !== 'active') throw new ForbiddenException({ code: 'ACCOUNT_INACTIVE', message: 'This account is inactive.' });
    if (user.role === 'student') {
      throw new ForbiddenException({ code: 'PORTAL_ACCESS_DENIED', message: 'This account cannot sign in to the Faculty/Admin Portal.' });
    }

    const otp = await this.db.queryOne<any>(
      `select * from otp_codes
        where user_id = $1 and consumed_at is null and expires_at > now()
        order by created_at desc limit 1`,
      [user.id],
    );
    if (!otp) throw new UnauthorizedException('Invalid code');

    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts — request a new code');
    }
    if (!safeEqual(otp.code_hash, hmacSha256(env.otpPepper, code.trim()))) {
      await this.db.query(`update otp_codes set attempts = attempts + 1 where id = $1`, [otp.id]);
      throw new UnauthorizedException('Invalid code');
    }

    // Atomic consume — the WHERE guard means only one of two concurrent
    // verifications of the same code can win; the loser is rejected.
    const consumed = await this.db.query(
      `update otp_codes set consumed_at = now()
        where id = $1 and consumed_at is null returning id`,
      [otp.id],
    );
    if (consumed.length === 0) throw new UnauthorizedException('Invalid code');
    return this.issueSession(user, meta);
  }

  async refresh(refreshToken: string) {
    const hash = sha256(refreshToken);
    const row = await this.db.queryOne<any>(
      `select r.id, r.user_id, r.expires_at, r.revoked_at
         from refresh_tokens r where r.token_hash = $1`,
      [hash],
    );
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.db.query(`update refresh_tokens set revoked_at = now() where id = $1`, [row.id]);

    const user = await this.db.queryOne<any>(
      `select u.*, f.faculty_id, f.designation, f.department,
              a.admin_id,
              s.student_id, s.year as student_year, s.department as student_dept,
              s.section_id, s.roll_no, sec.label as section_label
         from users u
         left join faculty_profiles f on f.user_id = u.id
         left join admin_profiles a on a.user_id = u.id
         left join student_profiles s on s.user_id = u.id
         left join sections sec on sec.id = s.section_id
        where u.id = $1`,
      [row.user_id],
    );
    if (!user || user.status !== 'active') throw new UnauthorizedException('Invalid refresh token');
    return this.issueTokens(user);
  }

  async logout(refreshToken: string | undefined) {
    if (refreshToken) {
      await this.db.query(
        `update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`,
        [sha256(refreshToken)],
      );
    }
    return { loggedOut: true };
  }

  async me(userId: string): Promise<UserPayload> {
    const user = await this.db.queryOne<any>(
      `select u.*, f.faculty_id, f.designation, f.department,
              a.admin_id,
              s.student_id, s.year as student_year, s.department as student_dept,
              s.section_id, s.roll_no, sec.label as section_label
         from users u
         left join faculty_profiles f on f.user_id = u.id
         left join admin_profiles a on a.user_id = u.id
         left join student_profiles s on s.user_id = u.id
         left join sections sec on sec.id = s.section_id
        where u.id = $1`,
      [userId],
    );
    if (!user) throw new UnauthorizedException();
    return this.buildPayload(user);
  }

  // ---------- internals ----------

  private async issueSession(user: any, meta: { ip?: string; device?: string }) {
    await this.db.query(
      `insert into login_logs (user_id, device, ip) values ($1, $2, $3)`,
      [user.id, meta.device ?? null, meta.ip ?? null],
    );
    this.purgeExpired().catch(() => {});
    return this.issueTokens(user);
  }

  /**
   * Fire-and-forget maintenance piggybacked on logins (no cron in this stack).
   * Empty params => pg simple protocol, so the multi-statement string is fine.
   */
  private purgeExpired() {
    return this.db.query(`
      delete from refresh_tokens where revoked_at is not null or expires_at < now() - interval '1 day';
      delete from otp_codes where created_at < now() - interval '1 day';
      delete from login_logs where created_at < now() - interval '90 days';
    `);
  }

  private async issueTokens(user: any) {
    const accessToken = jwt.sign(
      { sub: user.id, role: user.role, name: user.display_name, email: user.email },
      env.jwtSecret,
      { expiresIn: ACCESS_TTL },
    );
    const refreshToken = randomToken();
    await this.db.query(
      `insert into refresh_tokens (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '${REFRESH_TTL_DAYS} days')`,
      [user.id, sha256(refreshToken)],
    );
    const payload = await this.buildPayload(user);
    return { accessToken, refreshToken, user: payload };
  }

  private async buildPayload(user: any): Promise<UserPayload> {
    let overallAttendance: number | null = null;
    if (user.role === 'student') {
      const row = await this.db.queryOne<{ pct: number | null }>(
        `select round(100.0 * sum(case when r.status = 'present' then 1 else 0 end)
                / nullif(count(*), 0), 0) as pct
           from attendance_records r
          where r.student_id = $1`,
        [user.id],
      );
      overallAttendance = row?.pct ?? null;
    }
    let avatarUrl: string | null = null;
    if (user.avatar_path) {
      try {
        avatarUrl = await this.storage.signedUrl(BUCKETS.profileAvatars, user.avatar_path, 3600);
      } catch {
        avatarUrl = null;
      }
    }
    return {
      id: user.id,
      role: user.role,
      name: user.display_name,
      firstName: user.display_name.split(' ')[0],
      email: user.email,
      department: user.department ?? user.student_dept ?? null,
      designation: user.designation ?? null,
      studentId: user.student_id ?? null,
      facultyId: user.faculty_id ?? null,
      adminId: user.admin_id ?? null,
      year: user.student_year ?? null,
      sectionId: user.section_id ?? null,
      sectionLabel: user.section_label ?? null,
      rollNo: user.roll_no ?? null,
      overallAttendance,
      avatarUrl,
    };
  }
}
