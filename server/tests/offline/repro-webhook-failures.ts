/* eslint-disable */
import { cols, calls, state, req, tick } from './harness';
const save = async () => {};
(async () => {
  console.log('Running against:', process.env.SRC);
  const client = cols.Client.seed({ companyName: 'Acme', contactEmail: 'a@a.test' });
  const invoice = cols.Invoice.seed({ invoiceNumber: 'VP-2026-000001', clientId: client._id, amount: 50, currency: 'usd', items: [{ description: 'x', quantity: 1, unitPrice: 50 }], status: 'PENDING', dueDate: new Date(), save });
  const payment = cols.Payment.seed({ invoiceId: invoice._id, clientId: client._id, amount: 50, currency: 'usd', status: 'PENDING', stripeCheckoutSessionId: 'cs_1', save });
  const webhook = req('services/webhookService');

  // --- Repro A: storage (S3/disk) fails during the webhook -> what happens to the receipt?
  state.uploadOk = false;
  const event: any = { id: 'evt_A', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1' } } };
  await webhook.processStripeEvent(event);
  await tick(50);
  console.log(`A) storage down at payment time -> invoice=${invoice.status}, receipts in DB=${cols.Receipt.docs.length}  (client sees PAID but NO receipt/button)`);

  // --- Repro B: DB hiccup during finalize -> does Stripe's retry still work?
  const inv2 = cols.Invoice.seed({ invoiceNumber: 'VP-2026-000002', clientId: client._id, amount: 70, currency: 'usd', items: [{ description: 'y', quantity: 1, unitPrice: 70 }], status: 'PENDING', dueDate: new Date(), save });
  cols.Payment.seed({ invoiceId: inv2._id, clientId: client._id, amount: 70, currency: 'usd', status: 'PENDING', stripeCheckoutSessionId: 'cs_2', save });
  const ev2: any = { id: 'evt_B', type: 'checkout.session.completed', data: { object: { id: 'cs_2', payment_status: 'paid', payment_intent: 'pi_2' } } };
  const real = cols.Invoice.findById; let boom = true;
  cols.Invoice.findById = (id: any) => { if (boom) { boom = false; throw new Error('transient mongo error'); } return real(id); };
  try { await webhook.processStripeEvent(ev2); } catch {}
  await webhook.processStripeEvent(ev2);   // Stripe's retry
  await tick(50);
  console.log(`B) transient DB error then Stripe retry -> invoice=${inv2.status}  (customer charged, invoice never marked paid)`);
})().catch((e) => console.error('CRASH', e.message));
