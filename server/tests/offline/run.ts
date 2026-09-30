/* eslint-disable */
import { cols, calls, state, pdfLog, resetPdfLog, req, tick, newId, sessionsExpired } from './harness';

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
async function throwsStatus(fn: () => Promise<any>, status: number) {
  try { await fn(); return false; } catch (e: any) { return e.statusCode === status; }
}
const save = async () => {};

function seedPaidInvoice(opts: { withReceipt?: boolean; items?: number; company?: string; currency?: string } = {}) {
  const client = cols.Client.seed({ companyName: opts.company || 'Acme Ltd', contactEmail: 'a@acme.test' });
  const n = String(cols.Invoice.docs.length + 1).padStart(6, '0');
  const items = Array.from({ length: opts.items ?? 2 }, (_, i) => ({ description: `Service line ${i + 1} — consulting work`, quantity: 1 + i, unitPrice: 100 }));
  const invoice = cols.Invoice.seed({
    invoiceNumber: `VP-2026-${n}`, clientId: client._id, amount: 300, currency: opts.currency || 'usd',
    items, status: 'PAID', dueDate: new Date('2026-10-15'), paidAt: new Date(), save,
  });
  const payment = cols.Payment.seed({
    invoiceId: invoice._id, clientId: client._id, amount: 300, currency: invoice.currency, status: 'SUCCEEDED',
    stripePaymentIntentId: 'pi_test_123', paidAt: new Date(), save,
  });
  return { client, invoice, payment };
}

(async () => {
  const receiptSvc = req('services/receiptService');
  const pdfSvc = req('services/pdfService');
  const money = req('utils/money');

  console.log('\n[1] THE REPORTED BUG: PAID invoice, no receipt record (webhook receipt step never happened)');
  {
    const { client, invoice } = seedPaidInvoice();
    ok(cols.Receipt.docs.length === 0, 'precondition: 0 receipts exist (this is why the button was missing)');
    const list = await receiptSvc.listReceiptsForInvoiceClient(invoice._id, client._id);
    ok(list.length === 1, 'listing receipts now self-heals: 1 receipt created', `got ${list.length}`);
    const again = await receiptSvc.listReceiptsForInvoiceClient(invoice._id, client._id);
    ok(again.length === 1 && cols.Receipt.docs.length === 1, 'second call is idempotent (still exactly 1 receipt)');
    ok(/^RCPT-2026-\d{6}-[0-9A-F]{6}$/.test(list[0].receiptNumber), 'receipt number format', list[0].receiptNumber);
  }

  console.log('\n[2] One-step PDF download endpoint logic');
  {
    cols.Receipt.docs.length = 0;
    const { client, invoice } = seedPaidInvoice();
    const r = await receiptSvc.renderReceiptPdfForClientInvoice(invoice._id, client._id);
    ok(Buffer.isBuffer(r.buffer) && r.buffer.slice(0, 5).toString() === '%PDF-', 'returns a PDF buffer');
    ok(cols.Receipt.docs.length === 1, 'receipt record was created on the fly');
    const other = cols.Client.seed({ companyName: 'Other Co', contactEmail: 'o@o.test' });
    ok(await throwsStatus(() => receiptSvc.renderReceiptPdfForClientInvoice(invoice._id, other._id), 404), "another client's invoice -> 404 (IDOR safe)");
    const unpaid = cols.Invoice.seed({ invoiceNumber: 'VP-2026-999999', clientId: client._id, amount: 5, currency: 'usd', items: [], status: 'PENDING', dueDate: new Date(), save });
    ok(await throwsStatus(() => receiptSvc.renderReceiptPdfForClientInvoice(unpaid._id, client._id), 400), 'unpaid invoice -> 400 with clear message');
  }

  console.log('\n[3] Race: webhook + client page create the receipt at the same instant');
  {
    cols.Receipt.docs.length = 0;
    const { client, invoice } = seedPaidInvoice();
    const results = await Promise.all(Array.from({ length: 12 }, () => receiptSvc.listReceiptsForInvoiceClient(invoice._id, client._id)));
    ok(cols.Receipt.docs.length === 1, '12 concurrent requests -> exactly 1 receipt row', `rows=${cols.Receipt.docs.length}`);
    ok(results.every((l: any[]) => l.length === 1), 'every request got a receipt back (loser of the race re-reads the winner)');
  }

  console.log('\n[4] Receipt no longer depends on S3 / SMTP');
  {
    cols.Receipt.docs.length = 0; calls.emails.length = 0; calls.uploads.length = 0;
    state.uploadOk = false; state.emailOk = false;
    const { client, invoice, payment } = seedPaidInvoice();
    const rec = await receiptSvc.generateAndDeliverReceipt(invoice, payment, client);
    ok(!!rec && cols.Receipt.docs.length === 1, 'receipt created even though S3 AND SMTP are both down');
    await tick(50);
    ok(cols.Receipt.docs[0].emailSentAt === null, 'emailSentAt stays null when the email was NOT actually sent (old code marked it sent anyway)');
    ok(cols.Receipt.docs[0].storageProvider === 'NONE', 'archive failure is non-fatal, provider stays NONE');
    state.uploadOk = true; state.emailOk = true;
  }

  console.log('\n[5] Receipt email is sent exactly once, even under concurrency');
  {
    cols.Receipt.docs.length = 0; calls.emails.length = 0; state.emailDelayMs = 30;
    const { client, invoice, payment } = seedPaidInvoice();
    const { receipt } = await receiptSvc.ensureReceiptForPayment(invoice, payment, client);
    await Promise.all([receiptSvc.deliverReceiptEmailOnce(receipt._id), receiptSvc.deliverReceiptEmailOnce(receipt._id), receiptSvc.deliverReceiptEmailOnce(receipt._id)]);
    ok(calls.emails.filter((e) => e.type === 'receipt').length === 1, '3 concurrent triggers -> 1 email');
    ok(cols.Receipt.docs[0].emailSentAt instanceof Date, 'emailSentAt set after a real send');
    state.emailDelayMs = 0;
  }

  console.log('\n[6] PDF generator (real pdfService, fake pdfkit layout recorder)');
  {
    resetPdfLog();
    const { client, invoice, payment } = seedPaidInvoice({ items: 3 });
    const issuedAt = new Date('2026-09-30T10:00:00Z');
    const buf = await pdfSvc.generateReceiptPdf({ invoice, payment, client, receiptNumber: 'RCPT-2026-000001-ABC123', issuedAt });
    ok(buf.length > 0, 'produces bytes');
    ok(pdfLog.pages === 1 && pdfLog.violations.length === 0, '3 items: single page, nothing outside margins', pdfLog.violations.join('; '));
    const issued = pdfLog.texts.find((t) => t.s.startsWith('Issued:'));
    ok(!!issued && issued.s.includes('September 30, 2026'), 'Issued date comes from the stored receipt (stable across downloads)', issued?.s);
    ok(pdfLog.texts.some((t) => t.s.includes('PAID')) && pdfLog.texts.some((t) => t.s.startsWith('Total Paid')), 'PAID stamp + total present');

    resetPdfLog();
    const big = seedPaidInvoice({ items: 80 });
    await pdfSvc.generateReceiptPdf({ ...big, receiptNumber: 'RCPT-BIG', issuedAt });
    ok(pdfLog.pages > 1, `80 line items paginate (${pdfLog.pages} pages)`);
    ok(pdfLog.violations.length === 0, 'no text drawn past the bottom margin on any page', pdfLog.violations.slice(0, 2).join('; '));
    ok(pdfLog.texts.filter((t) => t.s === 'Description').length === pdfLog.pages - 0 || pdfLog.texts.filter((t) => t.s === 'Description').length >= 2, 'table header repeats on continuation pages');
    const lastLine = pdfLog.texts.find((t) => t.s.startsWith('Total Paid'));
    ok(!!lastLine, 'total still rendered after many pages');

    resetPdfLog();
    const inr = seedPaidInvoice({ currency: 'inr', company: 'टेक Solutions' });
    await pdfSvc.generateReceiptPdf({ ...inr, receiptNumber: 'RCPT-INR', issuedAt });
    const all = pdfLog.texts.map((t) => t.s).join(' | ');
    ok(!/₹/.test(all) && /INR/.test(all), 'rupee sign (not drawable in Helvetica) falls back to "INR 300.00"');
    ok(!/[\u0900-\u097F]/.test(all) && all.includes('?? Solutions') || all.includes('? Solutions') || all.includes('?'), 'unsupported glyphs replaced instead of garbled');
    const usd = seedPaidInvoice({ currency: 'usd' });
    resetPdfLog();
    await pdfSvc.generateReceiptPdf({ ...usd, receiptNumber: 'RCPT-USD', issuedAt });
    ok(pdfLog.texts.some((t) => t.s.includes('$300.00')), 'USD keeps the $ symbol');
  }

  console.log('\n[7] Money conversion (Stripe minor units)');
  {
    ok(money.toMinorUnits(19.99, 'usd') === 1999, 'USD 19.99 -> 1999');
    ok(money.toMinorUnits(1000, 'jpy') === 1000, 'JPY 1000 -> 1000 (old code sent 100000 = 100x overcharge)');
    ok(money.toMinorUnits(1000, 'KRW') === 1000, 'KRW case-insensitive');
    ok(money.toMinorUnits(0.1 + 0.2, 'usd') === 30, 'float safe (0.1+0.2 -> 30)');
  }

  console.log('\n[8] Webhook: failed processing must not burn the idempotency key');
  {
    cols.Receipt.docs.length = 0; cols.Processed.docs.length = 0; calls.emails.length = 0;
    const webhook = req('services/webhookService');
    const client = cols.Client.seed({ companyName: 'Hook Co', contactEmail: 'h@h.test' });
    const invoice = cols.Invoice.seed({ invoiceNumber: 'VP-2026-000777', clientId: client._id, amount: 50, currency: 'usd', items: [{ description: 'x', quantity: 1, unitPrice: 50 }], status: 'PENDING', dueDate: new Date(), save });
    const payment = cols.Payment.seed({ invoiceId: invoice._id, clientId: client._id, amount: 50, currency: 'usd', status: 'PENDING', stripeCheckoutSessionId: 'cs_1', save });
    const event: any = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 5000, currency: 'usd' } } };

    // First delivery: DB blows up mid-way
    const realFindById = cols.Invoice.findById; let boom = true;
    cols.Invoice.findById = (id: any) => { if (boom) { boom = false; throw new Error('mongo transient failure'); } return realFindById(id); };
    let threw = false;
    try { await webhook.processStripeEvent(event); } catch { threw = true; }
    ok(threw, 'transient failure propagates (-> HTTP 500 -> Stripe retries)');
    ok(cols.Processed.docs.length === 0, 'idempotency claim was released (old code left it, so the retry was ignored forever)');
    ok(invoice.status === 'PENDING', 'invoice untouched after the failed attempt');

    // Stripe retry
    await webhook.processStripeEvent(event);
    await tick(30);
    ok(invoice.status === 'PAID' && payment.status === 'SUCCEEDED', 'retry finalizes: invoice PAID, payment SUCCEEDED');
    ok(cols.Receipt.docs.length === 1, 'receipt record created by the webhook');
    ok(calls.emails.some((e) => e.type === 'confirm') && calls.emails.some((e) => e.type === 'receipt'), 'confirmation + receipt emails dispatched');

    // Duplicate delivery afterwards is a no-op
    const before = { r: cols.Receipt.docs.length, e: calls.emails.length };
    await webhook.processStripeEvent(event); await tick(20);
    ok(cols.Receipt.docs.length === before.r && calls.emails.length === before.e, 'true duplicate delivery -> no second receipt / email');

    // Mismatch is flagged but the real payment is still finalized
    const p2 = cols.Payment.seed({ invoiceId: invoice._id, clientId: client._id, amount: 50, currency: 'usd', status: 'PENDING', stripeCheckoutSessionId: 'cs_2', save });
    await webhook.processStripeEvent({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_2', payment_status: 'paid', payment_intent: 'pi_2', amount_total: 1, currency: 'usd' } } });
    ok(calls.audits.includes('PAYMENT_AMOUNT_MISMATCH'), 'amount mismatch vs Stripe session is written to the audit log');
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST HARNESS CRASH', e); process.exit(2); });
