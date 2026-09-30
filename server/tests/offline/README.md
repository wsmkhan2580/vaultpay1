# Offline receipt / webhook tests

These tests run the REAL `receiptService`, `pdfService`, `webhookService` and `money` code against an
in-memory fake database, a fake PDFKit (records layout) and fake email/S3. No MongoDB, Stripe, SMTP or
network is needed.

    cd server
    npx tsx tests/offline/run.ts                      # 38 checks
    npx tsx tests/offline/repro-webhook-failures.ts   # prints what happens when storage / the DB fail mid-webhook

Set `SRC=/path/to/other/server/src` to run the same scenarios against a different copy of the code.
They do not replace a real end-to-end run with Stripe test mode (see the checklist in the report).
