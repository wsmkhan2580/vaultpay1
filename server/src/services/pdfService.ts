import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { IInvoice } from '../models/Invoice';
import { IPayment } from '../models/Payment';
import { IClient } from '../models/Client';

export interface ReceiptPdfInput {
  invoice: IInvoice;
  payment: IPayment;
  client: IClient;
  receiptNumber: string;
  /** When the receipt was issued. Must come from the stored receipt so re-downloads never change it. */
  issuedAt?: Date;
}

const BRAND_INK = '#0F1A2B';
const BRAND_ACCENT = '#2E6F5E';
const BRAND_MUTED = '#6B7280';
const LINE = '#E2E5EA';
const MARGIN = 56;

/**
 * Optional Unicode fonts. PDFKit's built-in Helvetica only covers Latin-1/WinAnsi, so a company
 * name such as "टेक सॉल्यूशंस" or a symbol like ₹ would be garbled. Drop these two files into
 * server/assets/fonts/ (e.g. Noto Sans) to enable full Unicode; without them text is sanitised.
 */
const FONT_DIR = path.resolve(__dirname, '../../assets/fonts');
const UNICODE_REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const UNICODE_BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');
const HAS_UNICODE_FONT = fs.existsSync(UNICODE_REGULAR) && fs.existsSync(UNICODE_BOLD);

const WINANSI_EXTRA = new Set([0x20ac, 0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2022, 0x2026, 0x2122]);

function isWinAnsiSafe(input: string): boolean {
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    const ok = c === 10 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(c);
    if (!ok) return false;
  }
  return true;
}

/** Replaces characters the built-in font cannot draw so they don't turn into garbage glyphs. */
function pdfSafe(input: unknown): string {
  const str = String(input ?? '');
  if (HAS_UNICODE_FONT) return str;
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0) as number;
    if (c === 9) out += ' ';
    else if (isWinAnsiSafe(ch)) out += ch;
    else out += '?';
  }
  return out;
}

function formatMoney(amount: number, currency: string): string {
  const code = String(currency || 'usd').toUpperCase();
  try {
    const symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount).replace(/\u00a0/g, ' ');
    if (HAS_UNICODE_FONT || isWinAnsiSafe(symbol)) return symbol;
    // e.g. the rupee sign is not drawable with Helvetica -> "INR 1,000.00" instead
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code' })
      .format(amount)
      .replace(/\u00a0/g, ' ');
  } catch {
    return `${Number(amount).toFixed(2)} ${code}`;
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatDateTime(d: Date): string {
  return `${d.toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
}

export function generateReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  const { invoice, payment, client, receiptNumber } = input;
  const issuedAt = input.issuedAt || new Date();

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `Receipt ${receiptNumber}`,
        Author: 'VaultPay Financial Core',
        Subject: `Payment receipt for invoice ${invoice.invoiceNumber}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let FONT = 'Helvetica';
    let FONT_BOLD = 'Helvetica-Bold';
    if (HAS_UNICODE_FONT) {
      doc.registerFont('Body', UNICODE_REGULAR);
      doc.registerFont('BodyBold', UNICODE_BOLD);
      FONT = 'Body';
      FONT_BOLD = 'BodyBold';
    }

    const L = MARGIN;
    const W = doc.page.width - MARGIN * 2;
    const R = L + W;

    // Table columns (x offsets from the left margin)
    const descX = L;
    const descW = 220;
    const qtyX = L + 225;
    const qtyW = 35;
    const unitX = L + 265;
    const unitW = 105;
    const amtX = L + 375;
    const amtW = W - 375;

    const pageBottom = () => doc.page.height - MARGIN;

    // Every text() call below passes explicit x, y and width so PDFKit's implicit
    // cursor never decides layout. Page breaks are handled by hand (ensureSpace).

    // ---- Header --------------------------------------------------------------------------
    doc.font(FONT_BOLD).fontSize(20).fillColor(BRAND_INK).text('VaultPay Financial Core', L, MARGIN, {
      width: W * 0.6,
      lineBreak: false,
    });
    doc
      .font(FONT)
      .fontSize(10)
      .fillColor(BRAND_MUTED)
      .text('Operated on behalf of Nexus Corporate Services', L, MARGIN + 26, { width: W * 0.7 });

    doc.font(FONT_BOLD).fontSize(14).fillColor(BRAND_ACCENT).text('PAYMENT RECEIPT', L, MARGIN, {
      width: W,
      align: 'right',
      lineBreak: false,
    });
    doc.font(FONT).fontSize(10).fillColor(BRAND_MUTED);
    doc.text(`Receipt #: ${pdfSafe(receiptNumber)}`, L, MARGIN + 22, { width: W, align: 'right', lineBreak: false });
    doc.text(`Issued: ${formatDate(issuedAt)}`, L, MARGIN + 36, { width: W, align: 'right', lineBreak: false });

    let y = MARGIN + 66;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 18;

    // ---- Billed to / invoice meta ------------------------------------------------------------
    const colW = 235;
    const rightX = L + 265;
    let leftY = y;
    let rightY = y;

    doc.font(FONT_BOLD).fontSize(11).fillColor(BRAND_INK).text('Billed To', L, leftY, { width: colW, lineBreak: false });
    leftY += 18;
    doc.font(FONT).fontSize(10).fillColor(BRAND_MUTED);
    const billedLines = [client.companyName, client.contactEmail, client.billingAddress].filter(Boolean).map(pdfSafe);
    for (const line of billedLines) {
      doc.text(line, L, leftY, { width: colW });
      leftY += doc.heightOfString(line, { width: colW }) + 3;
    }

    doc.font(FONT_BOLD).fontSize(11).fillColor(BRAND_INK).text('Invoice', rightX, rightY, {
      width: R - rightX,
      lineBreak: false,
    });
    rightY += 18;
    doc.font(FONT).fontSize(10).fillColor(BRAND_MUTED);
    const metaLines = [
      `Invoice #: ${invoice.invoiceNumber}`,
      `Due: ${invoice.dueDate ? formatDate(new Date(invoice.dueDate)) : '-'}`,
      `Transaction ID: ${payment.stripePaymentIntentId || payment._id.toString()}`,
    ].map(pdfSafe);
    for (const line of metaLines) {
      doc.text(line, rightX, rightY, { width: R - rightX });
      rightY += doc.heightOfString(line, { width: R - rightX }) + 3;
    }

    y = Math.max(leftY, rightY) + 24;

    // ---- Line items ----------------------------------------------------------------------------
    const drawTableHeader = () => {
      doc.font(FONT_BOLD).fontSize(10).fillColor(BRAND_INK);
      doc.text('Description', descX, y, { width: descW, lineBreak: false });
      doc.text('Qty', qtyX, y, { width: qtyW, align: 'right', lineBreak: false });
      doc.text('Unit Price', unitX, y, { width: unitW, align: 'right', lineBreak: false });
      doc.text('Amount', amtX, y, { width: amtW, align: 'right', lineBreak: false });
      y += 16;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
      y += 8;
    };

    const ensureSpace = (needed: number, redrawHeader: boolean) => {
      if (y + needed <= pageBottom()) return;
      doc.addPage();
      y = MARGIN;
      if (redrawHeader) drawTableHeader();
    };

    drawTableHeader();

    const items =
      invoice.items && invoice.items.length
        ? invoice.items
        : [{ description: invoice.description || 'Services rendered', quantity: 1, unitPrice: invoice.amount }];

    for (const item of items) {
      const desc = pdfSafe(item.description);
      doc.font(FONT).fontSize(10);
      const rowH = Math.max(doc.heightOfString(desc, { width: descW }), 12) + 8;
      ensureSpace(rowH, true);

      doc.fillColor(BRAND_MUTED).font(FONT).fontSize(10);
      doc.text(desc, descX, y, { width: descW });
      doc.text(String(item.quantity), qtyX, y, { width: qtyW, align: 'right', lineBreak: false });
      doc.text(formatMoney(item.unitPrice, invoice.currency), unitX, y, { width: unitW, align: 'right', lineBreak: false });
      doc.text(formatMoney(item.quantity * item.unitPrice, invoice.currency), amtX, y, {
        width: amtW,
        align: 'right',
        lineBreak: false,
      });
      y += rowH;
    }

    // ---- Total + PAID stamp --------------------------------------------------------------------
    ensureSpace(140, false);
    y += 2;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 14;

    doc.font(FONT_BOLD).fontSize(12).fillColor(BRAND_INK);
    doc.text('Total Paid', unitX - 40, y, { width: unitW + 40, align: 'right', lineBreak: false });
    doc.text(formatMoney(payment.amount, payment.currency), amtX, y, { width: amtW, align: 'right', lineBreak: false });

    const stampX = L + 8;
    const stampY = y - 4;
    doc.save();
    doc.rotate(-8, { origin: [stampX + 42, stampY + 17] });
    doc.opacity(0.85).lineWidth(2).strokeColor(BRAND_ACCENT);
    doc.roundedRect(stampX, stampY, 84, 34, 4).stroke();
    doc.font(FONT_BOLD).fontSize(22).fillColor(BRAND_ACCENT).text('PAID', stampX, stampY + 6, {
      width: 84,
      align: 'center',
      lineBreak: false,
    });
    doc.restore();

    y += 64;

    // ---- Footer note ---------------------------------------------------------------------------
    const note =
      `Payment date: ${formatDateTime(payment.paidAt ? new Date(payment.paidAt) : issuedAt)}\n` +
      'This receipt confirms a Stripe-verified payment and was generated automatically. ' +
      'For questions, contact billing@nexuscorporateservices.com.';
    doc.font(FONT).fontSize(9).fillColor(BRAND_MUTED);
    ensureSpace(doc.heightOfString(note, { width: W }) + 4, false);
    doc.font(FONT).fontSize(9).fillColor(BRAND_MUTED).text(note, L, y, { width: W });

    doc.end();
  });
}
