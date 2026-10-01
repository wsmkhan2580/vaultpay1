


import https from 'https';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { IInvoice } from '../models/Invoice';
import { IClient } from '../models/Client';
import { IPayment } from '../models/Payment';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPassword) {
    logger.warn('SMTP not configured — emails will be logged instead of sent (development only)');
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPassword },
      // Never let an unreachable/blocked SMTP server hold a request or webhook open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

function wrapTemplate(title: string, bodyHtml: string): string {
  return `
  <div style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background:#F3F5F7; padding:32px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #E5E8EC;">
      <div style="background:#0F1A2B;padding:20px 28px;">
        <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:0.2px;">VaultPay Financial Core</span>
      </div>
      <div style="padding:28px;color:#1F2937;">
        <h1 style="font-size:18px;margin:0 0 16px;color:#0F1A2B;">${title}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:#F9FAFB;color:#6B7280;font-size:12px;">
        Nexus Corporate Services · This is an automated message from VaultPay.
      </div>
    </div>
  </div>`;
}

/**
 * Sends through Brevo's HTTPS API (port 443), which is never blocked by hosting providers, unlike SMTP.
 * Uses Node's built-in https module, so no new dependency is needed.
 */
function sendViaBrevo(
  to: string,
  subject: string,
  html: string,
  attachment?: { filename: string; content: Buffer }
): Promise<boolean> {
  const body = JSON.stringify({
    sender: { email: env.brevoSenderEmail, name: env.brevoSenderName },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    ...(attachment ? { attachment: [{ name: attachment.filename, content: attachment.content.toString('base64') }] } : {}),
  });

  return new Promise<boolean>((resolve) => {
    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': env.brevoApiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const ok = (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300;
          if (!ok) logger.error('Brevo rejected the email', { to, subject, status: res.statusCode, response: data.slice(0, 300) });
          resolve(ok);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Brevo request timed out')));
    req.on('error', (err) => {
      logger.error('Failed to send email via Brevo', { to, subject, error: err.message });
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Returns true only when the message was actually handed to the SMTP server.
 * Failures are logged and swallowed (email must never break the business flow),
 * but callers can still tell "sent" from "not sent" — e.g. so a receipt is not
 * marked as emailed when SMTP is missing or down.
 */
async function sendMail(
  to: string,
  subject: string,
  html: string,
  attachment?: { filename: string; content: Buffer }
): Promise<boolean> {
  if (env.brevoApiKey && env.brevoSenderEmail) return sendViaBrevo(to, subject, html, attachment);

  const t = getTransporter();
  if (!t) {
    logger.info('Email suppressed (SMTP not configured)', { to, subject });
    return false;
  }
  try {
    await t.sendMail({
      from: env.smtpFrom,
      to,
      subject,
      html,
      attachments: attachment ? [{ filename: attachment.filename, content: attachment.content }] : undefined,
    });
    return true;
  } catch (err) {
    // Email failures must never crash the calling business flow (e.g. a payment
    // finalizing) — log and move on; the receipt/invoice remains retrievable in-app.
    logger.error('Failed to send email', { to, subject, error: err instanceof Error ? err.message : 'unknown' });
    return false;
  }
}

export async function sendInvoiceCreatedEmail(client: IClient, invoice: IInvoice): Promise<void> {
  const link = `${env.clientBaseUrl}/client/invoices/${invoice._id.toString()}`;
  const html = wrapTemplate(
    'A new invoice is ready',
    `<p>Hello ${escapeHtml(client.companyName)},</p>
     <p>Invoice <strong>${escapeHtml(invoice.invoiceNumber)}</strong> for
     <strong>${formatCurrency(invoice.amount, invoice.currency)}</strong> has been issued, due
     ${invoice.dueDate.toLocaleDateString('en-US')}.</p>
     <p><a href="${link}" style="display:inline-block;background:#2E6F5E;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">View invoice</a></p>`
  );
  await sendMail(client.contactEmail, `New invoice ${invoice.invoiceNumber} from Nexus Corporate Services`, html);
}

export async function sendPaymentConfirmationEmail(client: IClient, invoice: IInvoice, payment: IPayment): Promise<boolean> {
  const html = wrapTemplate(
    'Payment received',
    `<p>Hello ${escapeHtml(client.companyName)},</p>
     <p>We've received your payment of <strong>${formatCurrency(payment.amount, payment.currency)}</strong>
     for invoice <strong>${escapeHtml(invoice.invoiceNumber)}</strong>.</p>
     <p>Payment date: ${(payment.paidAt || new Date()).toLocaleString('en-US')}<br/>
     Reference: ${payment.stripePaymentIntentId || payment._id.toString()}</p>`
  );
  return sendMail(client.contactEmail, `Payment confirmed for invoice ${invoice.invoiceNumber}`, html);
}

export async function sendReceiptEmail(
  client: IClient,
  invoice: IInvoice,
  receiptNumber: string,
  pdfBuffer: Buffer
): Promise<boolean> {
  const html = wrapTemplate(
    'Your receipt is attached',
    `<p>Hello ${escapeHtml(client.companyName)},</p>
     <p>Attached is your official receipt <strong>${escapeHtml(receiptNumber)}</strong> for invoice
     <strong>${escapeHtml(invoice.invoiceNumber)}</strong>. You can also view it anytime from your VaultPay portal.</p>`
  );
  return sendMail(client.contactEmail, `Receipt ${receiptNumber}`, html, {
    filename: `${receiptNumber}.pdf`,
    content: pdfBuffer,
  });
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}