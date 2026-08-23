import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { newId } from '../../lib/tokens.js';
import { log } from '../../lib/logger.js';

/**
 * Email provider abstraction. Development ships only the "capture" provider,
 * which writes RFC 822 messages to disk for inspection — no mail is ever sent.
 */

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function wrapLayout(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:24px;color:#1f1b16;background:#faf7f2;">
<div style="border:1px solid #e4ddd2;padding:32px;border-radius:6px;">
<h2 style="margin-top:0;font-weight:normal;letter-spacing:0.02em;">Cartward</h2>
${bodyHtml}
<p style="color:#63594c;font-size:13px;margin-top:32px;">You are receiving this because you have a Cartward account. This is a demonstration application; no real mail is ever sent.</p>
</div>
</body>
</html>`;
}

export const emailTemplates = {
  verifyEmail: ({ url, hours }) => ({
    subject: 'Verify your Cartward account',
    html: wrapLayout('Verify your account', `
      <p>Welcome to Cartward.</p>
      <p>Confirm your email address using this link, valid for ${hours} hours:</p>
      <p><a href="${url}">${url}</a></p>`),
    text: `Welcome to Cartward.\n\nConfirm your email address using this link, valid for ${hours} hours:\n${url}\n`,
  }),
  passwordReset: ({ url, minutes }) => ({
    subject: 'Reset your Cartward password',
    html: wrapLayout('Reset your password', `
      <p>We received a request to reset the password for this account.</p>
      <p>This link works once and expires in ${minutes} minutes:</p>
      <p><a href="${url}">${url}</a></p>
      <p>If you did not request this, nothing is needed — your password is unchanged.</p>`),
    text: `We received a request to reset the password for this account.\n\nThis link works once and expires in ${minutes} minutes:\n${url}\n\nIf you did not request this, nothing is needed - your password is unchanged.\n`,
  }),
  registrationAttempt: () => ({
    subject: 'A new Cartward account was attempted with this email',
    html: wrapLayout('Registration attempt', `
      <p>Someone just tried to create a Cartward account with this email address.</p>
      <p>An account already exists here. If that was you, sign in as usual or use
      "Forgot your password?" from the sign-in page.</p>
      <p>If it wasn't you, nothing is needed — your account and password are unchanged.</p>`),
    text: 'Someone tried to create a Cartward account with this email. An account already exists here; if that was you, sign in as usual. Otherwise nothing is needed.\n',
  }),
  orderConfirmation: ({ orderNumber, total, lines }) => {
    const rows = lines
      .map((l) => `<tr><td>${escapeHtml(l.name)} × ${l.quantity}</td><td align="right">${l.lineTotal}</td></tr>`)
      .join('');
    return {
      subject: `Order ${orderNumber} confirmed`,
      html: wrapLayout('Order confirmed', `
        <p>Thanks — your order is in. We will email you when it ships.</p>
        <table style="width:100%;border-collapse:collapse;">${rows}
        <tr><td colspan="2"><hr style="border:none;border-top:1px solid #e4ddd2;"></td></tr>
        <tr><td><strong>Total</strong></td><td align="right"><strong>${total}</strong></td></tr></table>
        <p>Order number: <strong>${escapeHtml(orderNumber)}</strong></p>`),
      text: `Thanks - your order is in.\n\n${lines.map((l) => `${l.name} x${l.quantity}: ${l.lineTotal}`).join('\n')}\nTotal: ${total}\nOrder number: ${orderNumber}\n`,
    };
  },
  shippingNotice: ({ orderNumber }) => ({
    subject: `Order ${orderNumber} shipped`,
    html: wrapLayout('Your order has shipped', `<p>Order <strong>${escapeHtml(orderNumber)}</strong> is on its way.</p>`),
    text: `Order ${orderNumber} is on its way.\n`,
  }),
  refundNotice: ({ orderNumber, amount }) => ({
    subject: `Refund issued for order ${orderNumber}`,
    html: wrapLayout('Refund issued', `<p>A refund of <strong>${amount}</strong> was issued for order <strong>${escapeHtml(orderNumber)}</strong>.</p>`),
    text: `A refund of ${amount} was issued for order ${orderNumber}.\n`,
  }),
  twoFactorEnabled: () => ({
    subject: 'Two-factor authentication enabled',
    html: wrapLayout('Two-factor authentication enabled', '<p>Two-factor authentication is now active on your account. Keep your recovery codes somewhere safe.</p>'),
    text: 'Two-factor authentication is now active on your account.\n',
  }),
};

/** Capture provider: writes .eml files to disk and an index row to SQLite. */
export function createCaptureEmailProvider({ emailDir = config.emailDir } = {}) {
  return {
    name: 'capture',
    async send({ to, template, subject, html, text }) {
      const id = newId();
      const filename = `${id}.eml`;
      const eml = [
        `From: Cartward <no-reply@cartward.test>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${id}@cartward.test>`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="cw-${id}"`,
        '',
        `--cw-${id}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text,
        `--cw-${id}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        html,
        `--cw-${id}--`,
        '',
      ].join('\r\n');
      await fs.mkdir(emailDir, { recursive: true });
      await fs.writeFile(path.join(emailDir, filename), eml, { mode: 0o600 });
      db.prepare(
        'INSERT INTO emails_out (id, to_email, subject, template, filename, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, to, subject, template, filename, Date.now());
      log.info('email captured', { to, subject, filename });
      return id;
    },
    sendTemplate(to, templateName, data) {
      const build = emailTemplates[templateName];
      if (!build) throw new Error(`Unknown email template: ${templateName}`);
      const { subject, html, text } = build(data);
      return this.send({ to, template: templateName, subject, html, text });
    },
  };
}

export const mailer = createCaptureEmailProvider();
