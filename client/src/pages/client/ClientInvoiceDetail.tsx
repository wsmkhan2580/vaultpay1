
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { invoiceApi, paymentApi, receiptApi } from '../../services/resources';
import { useRealtime } from '../../services/realtime';
import type { Invoice, Receipt } from '../../types';
import LoadingSpinner from '../../components/LoadingSpinner';
import StatusBadge from '../../components/StatusBadge';
import { formatCurrency, formatDate } from '../../utils/format';
import { extractDownloadErrorMessage, extractErrorMessage, saveBlobAsFile } from '../../services/api';

const POLL_INTERVAL_MS = 3000;
// ~2 minutes. A sleeping free-tier backend can take a minute just to wake up and receive Stripe's webhook.
const POLL_MAX_ATTEMPTS = 40;

export default function ClientInvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paymentFlag = searchParams.get('payment');

  // silent = true refreshes in the background without showing the spinner
  const load = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setLoading(true);
      try {
        const invoiceRes = await invoiceApi.getMine(id);
        const loaded = invoiceRes.data.data;
        setInvoice(loaded);
        if (loaded.status === 'PAID') {
          // The receipt list is a nice-to-have: the download button below works without it.
          const receiptRes = await receiptApi
            .listForInvoice(id)
            .catch(() => ({ data: { data: [] as Receipt[] } }));
          setReceipts(receiptRes.data.data);
        }
      } catch {
        // keep whatever is already on screen; the "not found" state handles first-load failures
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live updates: the server pushes an event the moment the payment is finalized, so the page flips to
  // PAID (and the receipt button appears) without any refresh.
  useRealtime((event) => {
    if (event === 'invoice:paid' || event === 'invoice:created' || event === 'resync') load(true);
  });

  // Right after returning from Stripe Checkout, ask the server to verify the payment with Stripe directly
  // instead of waiting for the webhook. The webhook still works as a backup; both paths are idempotent.
  useEffect(() => {
    if (paymentFlag !== 'success' || !id) return;
    paymentApi
      .confirm(id)
      .then(() => load(true))
      .catch(() => undefined);
  }, [paymentFlag, id, load]);

  // After returning from Stripe Checkout, the invoice is finalized by a webhook
  // a few seconds later. Poll quietly until it flips to PAID.
  const waitingForWebhook = paymentFlag === 'success' && !!invoice && invoice.status !== 'PAID';
  useEffect(() => {
    if (!waitingForWebhook) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      load(true);
      if (attempts >= POLL_MAX_ATTEMPTS) clearInterval(timer);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [waitingForWebhook, load]);

  async function handlePay() {
    if (!id) return;
    setError(null);
    setPaying(true);
    try {
      const res = await paymentApi.checkout(id);
      window.location.href = res.data.data.checkoutUrl;
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not start checkout. Please try again.'));
      setPaying(false);
    }
  }

  /**
   * Downloads the receipt PDF. Without a receiptId it uses the invoice-level endpoint, which creates
   * the receipt on the server if it doesn't exist yet — so a PAID invoice can ALWAYS be downloaded,
   * even if the automatic receipt generation after the webhook hadn't happened (or had failed).
   */
  async function handleDownloadReceipt(receipt?: Receipt) {
    if (!id) return;
    setError(null);
    setDownloading(receipt?._id ?? 'invoice');
    try {
      const res = receipt ? await receiptApi.downloadMine(receipt._id) : await receiptApi.downloadForInvoice(id);
      const blob = new Blob([res.data], { type: 'application/pdf' });
      saveBlobAsFile(blob, `${receipt?.receiptNumber ?? `receipt-${invoice?.invoiceNumber ?? id}`}.pdf`);
      if (!receipt) load(true); // pick up the receipt that may have just been created
    } catch (err) {
      setError(await extractDownloadErrorMessage(err, 'Could not download the receipt. Please try again.'));
    } finally {
      setDownloading(null);
    }
  }

  if (loading) return <LoadingSpinner label="Loading invoice…" />;
  if (!invoice) return <p className="text-sm text-ink-700/60">Invoice not found.</p>;

  const canPay = invoice.status === 'PENDING' || invoice.status === 'OVERDUE';
  const isPaid = invoice.status === 'PAID';

  return (
    <div className="max-w-2xl">
      <Link to="/client" className="text-xs text-ink-700/50 hover:text-ink mb-4 inline-block">
        ← Back to dashboard
      </Link>

      {paymentFlag === 'success' && !isPaid && (
        <div className="mb-4 text-sm bg-vault-amber/10 border border-vault-amber/25 text-vault-amber rounded-md px-4 py-3">
          Payment received by Stripe — we're confirming it now. This page will update automatically once our
          webhook finalizes the invoice (usually within a few seconds). Refresh if it doesn't update shortly.
        </div>
      )}
      {paymentFlag === 'cancelled' && (
        <div className="mb-4 text-sm bg-ink-700/5 border border-ink-700/10 text-ink-700/70 rounded-md px-4 py-3">
          Checkout was cancelled. No payment was made.
        </div>
      )}

      <div className="card p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="font-display text-xl font-semibold text-ink">{invoice.invoiceNumber}</h1>
            <p className="text-sm text-ink-700/60 mt-1">
              {isPaid && invoice.paidAt ? `Paid ${formatDate(invoice.paidAt)}` : `Due ${formatDate(invoice.dueDate)}`}
            </p>
          </div>
          <StatusBadge status={invoice.status} />
        </div>

        <div className="mb-6">
          <div className="text-xs text-ink-700/50 mb-1">{isPaid ? 'Amount paid' : 'Amount due'}</div>
          <div className="font-display text-3xl font-semibold text-ink">{formatCurrency(invoice.amount, invoice.currency)}</div>
        </div>

        {invoice.description && <p className="text-sm text-ink-700/70 mb-6">{invoice.description}</p>}

        <div className="border border-line rounded-md overflow-hidden mb-6">
          {invoice.items.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between px-4 py-2.5 text-sm border-b border-line last:border-0">
              <span className="text-ink">{item.description}</span>
              <span className="text-ink-700/60">
                {item.quantity} × {formatCurrency(item.unitPrice, invoice.currency)}
              </span>
            </div>
          ))}
        </div>

        {error && (
          <div role="alert" className="mb-4 text-sm text-vault-rust bg-vault-rust/5 border border-vault-rust/20 rounded-md px-3 py-2.5">
            {error}
          </div>
        )}

        {canPay && (
          <button onClick={handlePay} disabled={paying} className="btn-primary w-full sm:w-auto">
            {paying ? 'Redirecting to secure checkout…' : `Pay ${formatCurrency(invoice.amount, invoice.currency)}`}
          </button>
        )}

        {isPaid && (
          <div>
            <h2 className="text-xs font-medium text-ink-700/50 mb-2">Receipt</h2>
            {/* Always shown for a PAID invoice — it no longer depends on the receipt list having loaded. */}
            <button
              onClick={() => handleDownloadReceipt()}
              disabled={downloading !== null}
              className="btn-primary w-full sm:w-auto"
            >
              {downloading === 'invoice' ? 'Preparing your receipt…' : 'Download receipt (PDF)'}
            </button>

            {receipts.length > 1 && (
              <div className="mt-4">
                <h3 className="text-xs font-medium text-ink-700/50 mb-2">All receipts for this invoice</h3>
                <div className="space-y-2">
                  {receipts.map((r) => (
                    <button
                      key={r._id}
                      onClick={() => handleDownloadReceipt(r)}
                      disabled={downloading !== null}
                      className="btn-secondary w-full sm:w-auto justify-between"
                    >
                      <span>{r.receiptNumber}</span>
                      <span className="text-ink-700/40">{downloading === r._id ? 'Preparing…' : 'Download →'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}