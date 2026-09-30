import { Receipt, IReceipt } from '../models/Receipt';
import { Invoice, IInvoice } from '../models/Invoice';
import { Payment, IPayment } from '../models/Payment';
import { Client, IClient } from '../models/Client';
import { generateReceiptPdf } from './pdfService';
import { uploadReceiptPdf, getSignedDownloadUrl } from './storageService';
import { sendReceiptEmail } from './emailService';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { recordAudit } from './auditService';

/**
 * Deterministic per payment (no timestamp), so two racing creators — the Stripe
 * webhook and a client opening the page at the same moment — always produce the
 * same number and the unique indexes turn the loser into a harmless duplicate.
 */
function buildReceiptNumber(invoice: IInvoice, payment: IPayment): string {
  return `RCPT-${invoice.invoiceNumber.replace('VP-', '')}-${payment._id.toString().slice(-6).toUpperCase()}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000);
}

/**
 * Creates (or returns the existing) receipt RECORD for a successful payment.
 *
 * This is deliberately database-only: no PDF, no storage, no SMTP. Those are
 * slow, can fail, and must never decide whether a paid invoice has a receipt.
 * The PDF itself is rendered on demand from these records (renderReceiptPdf).
 */
export async function ensureReceiptForPayment(
  invoice: IInvoice,
  payment: IPayment,
  client: IClient
): Promise<{ receipt: IReceipt; created: boolean }> {
  const existing = await Receipt.findOne({ paymentId: payment._id });
  if (existing) return { receipt: existing, created: false };

  try {
    const receipt = await Receipt.create({
      invoiceId: invoice._id,
      paymentId: payment._id,
      clientId: client._id,
      receiptNumber: buildReceiptNumber(invoice, payment),
      storageKey: '',
      storageProvider: 'NONE',
      generatedAt: new Date(),
    });

    await recordAudit({
      actor: null,
      action: 'RECEIPT_GENERATED',
      resource: 'Receipt',
      resourceId: receipt._id.toString(),
      metadata: { invoiceId: invoice._id.toString(), paymentId: payment._id.toString() },
    });

    return { receipt, created: true };
  } catch (err) {
    // Lost a race with a concurrent creator: use the record it made.
    if (isDuplicateKeyError(err)) {
      const winner = await Receipt.findOne({ paymentId: payment._id });
      if (winner) return { receipt: winner, created: false };
    }
    throw err;
  }
}

async function loadReceiptContext(receipt: {
  invoiceId: unknown;
  paymentId: unknown;
  clientId: unknown;
}): Promise<{ invoice: IInvoice; payment: IPayment; client: IClient }> {
  const [invoice, payment, client] = await Promise.all([
    Invoice.findById(receipt.invoiceId),
    Payment.findById(receipt.paymentId),
    Client.findById(receipt.clientId),
  ]);
  if (!invoice || !payment || !client) throw ApiError.notFound('Receipt data not found');
  return { invoice, payment, client };
}

/**
 * Rebuilds the receipt PDF on demand from the database records instead of
 * reading a stored file. Works on hosts with ephemeral disks (e.g. Render
 * free tier) and needs no S3. Callers must have already authorized access.
 */
export async function renderReceiptPdf(receipt: {
  invoiceId: unknown;
  paymentId: unknown;
  clientId: unknown;
  receiptNumber: string;
  generatedAt?: Date;
}): Promise<Buffer> {
  const { invoice, payment, client } = await loadReceiptContext(receipt);
  return generateReceiptPdf({
    invoice,
    payment,
    client,
    receiptNumber: receipt.receiptNumber,
    issuedAt: receipt.generatedAt,
  });
}

/**
 * Emails the receipt at most once. The emailSentAt flag is claimed atomically
 * BEFORE sending, so the webhook and a self-healing request can't both send it;
 * if sending fails or SMTP isn't configured the claim is released again.
 * Never throws.
 */
export async function deliverReceiptEmailOnce(receiptId: string): Promise<void> {
  try {
    const claimed = await Receipt.findOneAndUpdate(
      { _id: receiptId, emailSentAt: null },
      { $set: { emailSentAt: new Date() } }
    );
    if (!claimed) return; // already emailed (or being emailed by someone else)

    let sent = false;
    try {
      const { invoice, client } = await loadReceiptContext(claimed);
      const pdf = await renderReceiptPdf(claimed);
      sent = await sendReceiptEmail(client, invoice, claimed.receiptNumber, pdf);
    } finally {
      if (!sent) await Receipt.updateOne({ _id: receiptId }, { $set: { emailSentAt: null } });
    }
  } catch (err) {
    logger.error('Receipt email delivery failed', {
      receiptId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** Optional archive copy (S3 / local disk). Best effort; downloads never depend on it. Never throws. */
export async function archiveReceiptPdf(receiptId: string): Promise<void> {
  try {
    const receipt = await Receipt.findById(receiptId);
    if (!receipt || receipt.storageProvider !== 'NONE') return;
    const pdf = await renderReceiptPdf(receipt);
    const key = `receipts/${receipt.clientId.toString()}/${receipt.receiptNumber}.pdf`;
    const upload = await uploadReceiptPdf(pdf, key);
    await Receipt.updateOne(
      { _id: receipt._id, storageProvider: 'NONE' },
      { $set: { storageKey: upload.storageKey, storageProvider: upload.provider } }
    );
  } catch (err) {
    logger.warn('Receipt archive upload failed (non-fatal; PDF is still downloadable on demand)', {
      receiptId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** Slow, failure-prone side effects for a freshly created receipt. Fire-and-forget. */
function runBackgroundDelivery(receiptId: string): void {
  void archiveReceiptPdf(receiptId);
  void deliverReceiptEmailOnce(receiptId);
}

/**
 * Called from the Stripe webhook after the payment/invoice were finalized.
 * The receipt record is created synchronously (fast, DB only); archiving and
 * emailing continue in the background so an unreachable SMTP server or S3 can
 * neither delay the webhook response nor prevent the receipt from existing.
 */
export async function generateAndDeliverReceipt(invoice: IInvoice, payment: IPayment, client: IClient): Promise<IReceipt> {
  const { receipt, created } = await ensureReceiptForPayment(invoice, payment, client);
  if (created || !receipt.emailSentAt) runBackgroundDelivery(receipt._id.toString());
  return receipt;
}

/**
 * Finds the receipt(s) for a PAID invoice, creating the missing one from the
 * payment record. This is the self-healing path: invoices that were paid while
 * receipt generation was broken (or before the receipt existed when the page
 * polled) get their receipt the first time anyone asks for it.
 */
export async function ensureReceiptsForPaidInvoice(invoice: IInvoice): Promise<IReceipt[]> {
  const existing = await Receipt.find({ invoiceId: invoice._id }).sort({ generatedAt: 1 });
  if (existing.length > 0 || invoice.status !== 'PAID') return existing;

  const payment = await Payment.findOne({ invoiceId: invoice._id, status: 'SUCCEEDED' }).sort({ paidAt: -1 });
  if (!payment) throw ApiError.badRequest('No successful payment record found for this invoice.');

  const client = await Client.findById(invoice.clientId);
  if (!client) throw ApiError.notFound('Client for this invoice not found');

  const { receipt, created } = await ensureReceiptForPayment(invoice, payment, client);
  if (created) runBackgroundDelivery(receipt._id.toString());
  return [receipt];
}

/** IDOR-safe: only returns a receipt that belongs to the requesting client. */
export async function getReceiptForClient(receiptId: string, clientId: string) {
  const receipt = await Receipt.findOne({ _id: receiptId, clientId });
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return receipt;
}

export async function getReceiptForAdmin(receiptId: string) {
  const receipt = await Receipt.findById(receiptId);
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return receipt;
}

/**
 * Lists receipts for one of the client's own invoices. For a PAID invoice with no receipt
 * yet, the receipt is created on the spot instead of returning an empty list.
 */
export async function listReceiptsForInvoiceClient(invoiceId: string, clientId: string) {
  // Ownership check on the invoice first, then fetch its receipts.
  const invoice = await Invoice.findOne({ _id: invoiceId, clientId });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  try {
    return await ensureReceiptsForPaidInvoice(invoice);
  } catch (err) {
    // A listing must not fail because of a heal attempt; the download endpoint reports real errors.
    logger.error('Could not auto-create missing receipt while listing', {
      invoiceId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    const fallback = await Receipt.find({ invoiceId: invoice._id }).sort({ generatedAt: 1 });
    return fallback;
  }
}

/**
 * One-step "download my receipt" for a PAID invoice: ownership check, create the
 * receipt if it doesn't exist yet, render the PDF. Errors propagate with a real message.
 */
export async function renderReceiptPdfForClientInvoice(
  invoiceId: string,
  clientId: string
): Promise<{ buffer: Buffer; receiptNumber: string }> {
  const invoice = await Invoice.findOne({ _id: invoiceId, clientId });
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (invoice.status !== 'PAID') {
    throw ApiError.badRequest('A receipt is only available once the invoice is paid.');
  }
  const receipts = await ensureReceiptsForPaidInvoice(invoice);
  const receipt = receipts[receipts.length - 1]; // newest
  if (!receipt) throw ApiError.internal('Receipt could not be prepared. Please try again.');
  const buffer = await renderReceiptPdf(receipt);
  return { buffer, receiptNumber: receipt.receiptNumber };
}

export function signedUrlForReceipt(
  receipt: { storageKey: string; storageProvider: 'S3' | 'LOCAL' | 'NONE' },
  baseUrl?: string
): string {
  if (receipt.storageProvider === 'NONE' || !receipt.storageKey) {
    throw ApiError.badRequest('This receipt has no archived file; download it through the authenticated download endpoint.');
  }
  return getSignedDownloadUrl(receipt.storageKey, receipt.storageProvider, 300, baseUrl);
}

/** Admin view: all receipts for an invoice, no client ownership check. */
export async function listReceiptsForInvoiceAdmin(invoiceId: string) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  return Receipt.find({ invoiceId }).sort({ generatedAt: 1 });
}

/**
 * Manually (re)generates a receipt for a PAID invoice from the admin UI.
 * Idempotent — returns the existing receipt instead of creating a duplicate.
 * Unlike the webhook path, real errors propagate so they show up in the UI.
 */
export async function generateReceiptForInvoiceAdmin(invoiceId: string) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (invoice.status !== 'PAID') {
    throw ApiError.badRequest('Invoice is not paid yet — a receipt can only be generated for a paid invoice.');
  }
  const receipts = await ensureReceiptsForPaidInvoice(invoice);
  const receipt = receipts[receipts.length - 1];
  if (!receipt) throw ApiError.internal('Receipt generation did not produce a record — check server logs.');
  if (!receipt.emailSentAt) void deliverReceiptEmailOnce(receipt._id.toString());
  return receipt;
}
