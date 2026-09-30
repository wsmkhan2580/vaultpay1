# VaultPay – analysis, fixes and test report

## 1. Why the receipt button never appeared (root causes)

| # | Cause | Where | Effect |
|---|-------|-------|--------|
| 1 | Button rendered only if `receipts.length > 0` | `ClientInvoiceDetail.tsx` | Paid invoice + no receipt row = no button |
| 2 | Receipt row created only inside the Stripe webhook, AFTER PDF + S3/disk upload + email; any failure was swallowed into a log line | `receiptService.generateAndDeliverReceipt`, `webhookService` | Invoice PAID, zero receipts |
| 3 | `server/src/services/storageService.ts` was corrupted: client code pasted on top, git conflict markers, no `uploadReceiptPdf`, no imports | storageService.ts | Server does not compile; receipt upload can never work |
| 4 | Unresolved merge conflicts in `package.json` (invalid JSON) and `authController.ts` | server | `npm install` → EJSONPARSE, `tsc` → 6× TS1185 |
| 5 | Client polled only 30 s, and stopped as soon as the invoice flipped to PAID (receipt is created a moment later) | client | Even when it worked, the button needed a manual refresh |
| 6 | Payment email awaited before receipt; SMTP has no timeout (Render free tier blocks SMTP) | webhookService/emailService | Webhook hangs for minutes; receipt delayed |
| 7 | `emailSentAt` set even when the email failed | receiptService/emailService | False "sent" state |

## 2. What was changed

**Receipt flow (the fix)**
- Receipt = DB record only, created instantly. PDF is rendered on demand from the DB. S3/disk archive and email run in the background and can never block or prevent a receipt.
- Self-healing: listing receipts or clicking download for a PAID invoice creates the missing receipt (race-safe, deterministic receipt number, unique indexes). Already-paid customers get their receipt automatically.
- New endpoint `GET /api/receipts/me/invoice/:invoiceId/download` (ownership-checked) streams the PDF in one step.
- UI: PAID invoice always shows **Download receipt (PDF)**; real server error text is shown on failure; polling extended to ~2 min.
- PDF: pagination for long invoices, stable "Issued" date, safe fonts/currency (₹ → "INR 300.00"; optional Noto Sans for full Unicode, see `server/assets/fonts/README.md`).
- Email sent at most once (atomic claim), reports real success/failure, 10–20 s SMTP timeouts.

**Loopholes / bugs found and fixed**
1. **Webhook idempotency burn (HIGH, money):** event ID was stored before processing; if processing failed, Stripe's retry was ignored as "duplicate" → customer charged, invoice never PAID. Claim is now released on failure.
2. **Zero-decimal currencies (HIGH, money):** `amount*100` charged JPY/KRW etc. 100× too much. New `utils/money.ts`.
3. **Stale Checkout Session (MEDIUM):** editing/cancelling an invoice left the old session payable at the old amount. Open sessions are now expired.
4. **Amount/currency mismatch** between Stripe session and DB is now written to the audit log (`PAYMENT_AMOUNT_MISMATCH`).
5. **Auth rate limiter counted successful `/auth/refresh`** (every page load) → users locked out after ~10 loads/15 min per IP. Now only failures count; registration has its own limiter.
6. **CLIENT_URL with trailing slash** silently broke all CORS; multiple origins broke Stripe redirect URLs. Normalised.
7. Invoice e-mail link pointed to a non-existent route (`/invoices/:id` → `/client/invoices/:id`).
8. Invalid ObjectId in URL returned 500; now 400.
9. Seed script refuses the built-in demo admin password in production.
10. Local-file path check used a bare `startsWith` (sibling-directory bypass); fixed.

## 3. Remaining risks (not changed – need your decision)
- **Cross-site refresh cookie** (Vercel ↔ Render, `SameSite=None`): Safari/Firefox often block it → random logouts. Best fix: serve API under the same site (custom domain, or a Vercel rewrite `/api → Render`).
- Login reveals account state (locked/suspended) and registration reveals existing emails (user enumeration); response-time difference for unknown users. No email verification on self-registration.
- Only one refresh session per user (login on a 2nd device logs out the 1st).
- Double payment of one invoice (two sessions) is not detected/refunded automatically. `checkout.session.expired` is not handled (payments stay PENDING).
- Stripe minimum charge (~$0.50) and unsupported currencies surface as generic 500s; validate currency against a whitelist.
- Mongo transactions need a replica set (Atlas is fine; a local standalone mongod is not).
- `npm ci` will fail until you run `npm install` once in `server/` and commit the refreshed `package-lock.json` (the lock is out of sync with package.json: type packages are in `dependencies`, needed for production builds).

## 4. Testing done (offline sandbox – no network)
- Reproduced on the ORIGINAL zip: `npm install` EJSONPARSE; `tsc` 6× TS1185; webhook + storage failure → invoice PAID with 0 receipts; DB hiccup + Stripe retry → invoice stays PENDING.
- Fixed code: 38/38 offline checks pass (`server/tests/offline`): self-heal, idempotency, 12-way race → 1 receipt, IDOR (other client → 404), unpaid → 400, S3+SMTP down → receipt still created, email exactly once, PDF pagination (80 items → 3 pages, nothing outside margins), currency/glyph handling, JPY conversion, webhook retry/duplicate/mismatch.
- Type-check of server + client with stubbed third-party types: no errors in project code.
- **Not possible here:** installing real `pdfkit`/`express`/`mongoose`, real Stripe, real browser. PDF layout was verified with a recording fake, not by looking at a rendered PDF.

## 5. Your 10-minute verification (after deploy)
1. `cd server && npm install && npm run build` (must pass); commit the lock file.
2. Set on Render: `CLIENT_URL` (no trailing slash), `SERVER_URL`, Stripe keys, `STRIPE_WEBHOOK_SECRET`.
3. Open one of the already-paid invoices as the client → **Download receipt (PDF)** → open the PDF, check totals/dates.
4. New test payment with card 4242 4242 4242 4242 → page shows PAID → button appears → PDF downloads.
5. Stripe dashboard → resend the same event → no second receipt/email.
