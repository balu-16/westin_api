import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env';

@Injectable()
export class MailService {
  private transporter: Transporter | null = null;
  private logger = new Logger('Mail');

  private getTransport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.smtp.host,
        port: env.smtp.port,
        secure: false,
        auth: { user: env.smtp.user, pass: env.smtp.pass },
      });
    }
    return this.transporter;
  }

  async sendOtp(to: string, code: string, purpose: string): Promise<void> {
    // Always surface the code in the server log for dev/testing convenience.
    this.logger.log(`OTP for ${to} (${purpose}): ${code}`);
    if (!env.smtp.user || !env.smtp.pass) return;

    await this.getTransport().sendMail({
      from: env.smtp.from,
      to,
      subject: `${code} is your Westin College login code`,
      text: `Your Westin College ${purpose} code is ${code}. It expires in 10 minutes.`,
      html: `<div style="font-family:sans-serif">
        <h2 style="color:#14213d">Westin College</h2>
        <p>Your ${purpose} code is:</p>
        <p style="font-size:28px;letter-spacing:6px;font-weight:bold;color:#3BA7F2">${code}</p>
        <p style="color:#666">This code expires in 10 minutes. If you did not request it, ignore this email.</p>
      </div>`,
    });
  }
}
