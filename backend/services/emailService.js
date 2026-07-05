// services/emailService.js
// Minimal transactional email sender. Uses SMTP if configured; otherwise logs
// the email to the console so local development and testing never break just
// because no mail provider is set up yet.
//
// Works with any standard SMTP provider — SendGrid, Postmark, Amazon SES,
// Mailgun, or even a personal Gmail account with an app password. Set
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / EMAIL_FROM in .env.

const nodemailer = require('nodemailer');

const IS_CONFIGURED = !!process.env.SMTP_HOST;

let transporter = null;
if (IS_CONFIGURED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

const FROM = process.env.EMAIL_FROM || 'TradeMind AI <no-reply@trademind.example.com>';

/**
 * Sends an email, or — if SMTP isn't configured — logs it to the console.
 * Never throws on a missing SMTP config, so password-reset etc. keep working
 * in local dev without a mail provider; it WILL throw if SMTP is configured
 * but the send genuinely fails, so callers can surface a real error.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!IS_CONFIGURED) {
    console.warn('\n📧 [DEV EMAIL — SMTP not configured, printing instead of sending]');
    console.warn(`   To: ${to}`);
    console.warn(`   Subject: ${subject}`);
    console.warn(`   ${text || html}\n`);
    return { simulated: true };
  }

  return transporter.sendMail({ from: FROM, to, subject, html, text });
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  return sendEmail({
    to: toEmail,
    subject: 'Reset your TradeMind AI password',
    text: `We received a request to reset your TradeMind AI password. Open this link to choose a new one (valid for 30 minutes): ${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0F3460">Reset your password</h2>
        <p>We received a request to reset your TradeMind AI password. This link is valid for 30 minutes.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#0F3460;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Reset password</a></p>
        <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email — your password won't change.</p>
      </div>`,
  });
}

module.exports = { sendEmail, sendPasswordResetEmail, IS_CONFIGURED };
