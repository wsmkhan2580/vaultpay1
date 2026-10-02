# Prompts.md: AI Transparency Log

This file records how I used AI while building and deploying **VaultPay Financial Core**.

- **AI tool used:** Claude (Anthropic), through the chat app.
- **Why I am sharing this:** the project brief asks for honesty about AI use, especially for the tricky parts (webhooks, PDF generation, email).
- **Language note:** I wrote most of my original prompts in Hinglish (Hindi and English mixed). Below I have rewritten them in simple English so they are easy to read. The meaning and the order are the same as in my real chat.

---

## How I worked with the AI

I followed a few simple rules in every prompt:

1. **Show the real problem.** I shared screenshots of error logs, `package.json`, and the Brevo settings page, instead of describing errors from memory.
2. **Set clear limits.** When I shared my project zip, I told the AI not to change anything except what was needed.
3. **Ask for step-by-step output.** I asked for the updated files one by one, with the path of each file, so I could review each change myself.
4. **Test and report back.** After each change I ran it, then sent the next error or screenshot.
5. **Check the AI's answers.** Some AI suggestions were wrong at first (see "Mistakes I caught"). I corrected them with real evidence.

---

## Prompt 0: Initial code generation

> **[Add here: the original prompt or specification I used to generate the first version of the codebase. Paste it exactly as I wrote it.]**

---

## Part 1: Deploying the backend on Render

**Prompt 1.** I shared a screenshot of the Render build log and wrote: *"Solve this."*
- **Problem:** the build failed with `Cannot find module '.../server.js'`.
- **AI answer:** the root directory and the build command were wrong. It suggested fixing them in the Render settings.

**Prompt 2.** I shared a screenshot of the backend `package.json`.
- **Why:** the AI had guessed the start command, but my backend is written in TypeScript.
- **AI answer:** use `npm install --include=dev && npm run build` as the build command and `npm start` as the start command. It also told me to check `outDir` in `tsconfig.json` and to set the environment variables.

**Prompt 3.** *"What do I do now?"* and later *"The deploy is done, but there is a trace warning."*
- **AI answer:** the warning was a Node deprecation warning, not an error. The service was running.
- **Result:** the backend went live on Render.

## Part 2: Deploying the frontend on Vercel

**Prompts 4 to 7.** I asked how to deploy the frontend, how to add `/api` to the API URL, what the build command is, and where to put `vercel.json`.
- **AI answer:** set the frontend root folder, use `VITE_API_URL` ending in `/api`, use `npm run build`, and place `vercel.json` in the frontend root so React Router works after a refresh.
- **Also covered:** CORS, and cookie settings for a Vercel frontend talking to a Render backend.
- **Result:** the frontend went live on Vercel.

## Part 3: Improving the payment flow

**Prompt 8.** I described three problems in my own words:
1. The receipt should be downloaded and also emailed to the client's registered email instantly.
2. After a payment, the page took about 10 seconds to show "paid" and needed a manual refresh.
3. I wanted to know how to fix both.

- **AI answer:** it explained likely causes (webhook delay, server cold start, no live updates) and warned that Render's free plan blocks SMTP ports, so email needs an HTTP email service.

**Prompt 9.** *"How many files will I have to change?"*
- **AI answer:** about 4 to 7 files, and it asked to see my code.

**Prompt 10.** I uploaded the full project zip and wrote, in short:
- Do not change anything except what is needed.
- Give me the updated files step by step. I will update them myself.
- When the admin creates an invoice, the client must see it instantly, without a refresh.
- When a payment is completed, the page must update without a refresh.
- The PDF must be sent to the registered email instantly.

- **What the AI did:** it read the codebase first, then proposed and built:
  - **Live updates** using Server-Sent Events (new files `realtimeService.ts`, `realtimeRoutes.ts`, `realtime.ts`).
  - **A payment confirm endpoint** (`POST /api/payments/confirm`) that asks Stripe directly if the checkout is paid, so the page does not wait for the webhook. It uses the same finalize code as the webhook.
  - **A fix for duplicate emails**, because the webhook and the confirm call can run at the same time. Only the call that really changes the payment to SUCCEEDED sends the emails.
  - **Email through the Brevo HTTPS API**, with the old SMTP code kept as a fallback.
- **Checks the AI ran:** a syntax check on all changed files, a type check of the new code, and a small test of the live-update message format. It told me clearly that it could not run the full build, because packages could not be installed in its sandbox. I ran the real build and tests myself.

**Prompt 11.** *"Can you give me the files one by one, and tell me what to change in each?"*
- **AI answer:** a numbered list of 14 files (3 new, 11 replaced) with the folder path of each one.

## Part 4: Email setup and testing

**Prompts 12 to 14.** I asked whether the new files are new or replacements, which environment variables to change, and what to do because my SMTP password already had a key in it.
- **AI answer:** the SMTP key does not work for the Brevo API. I needed a separate API key from the "API keys" tab, and I should add `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` next to my existing SMTP variables.

**Prompt 15.** *"How do I test this?"*
- **AI answer:** a test plan for the three features: live invoice, instant payment status, and the PDF email.

**Prompt 16.** I shared a screenshot of my local server terminal after the email failed.
- **Problem:** Brevo returned `401 unrecognised IP address`.
- **AI answer:** Brevo was blocking unknown IP addresses. It told me to deactivate IP blocking for API keys only (not SMTP keys), because my home IP and Render's IPs change.
- **Result:** after I did this, the payment flow and the email worked locally.

## Part 5: Shipping and documentation

- **Git push:** I asked how to push my changes to GitHub. The AI gave the steps and reminded me to confirm that `.env` is not committed. After the push, Render deployed the commit "Add realtime updates, instant payment confirm, Brevo email" successfully.
- **Render logs:** I shared a screenshot of red lines in the logs and asked what they mean.
  - **AI answer:** the 401 lines are normal (a visitor who is not logged in). One `500` on `/api/auth/me` could not be explained from the log alone. It told me how to check it.
- **README:** I asked the AI to update the README with the live link, the repo link, and the new features. It also corrected a wrong line about the cookie setting, after checking my code.
- **Demo video:** I asked for help planning what to say and show for the assignment video.

---

## Mistakes I caught (or the AI corrected)

1. The AI first suggested the start command `node server.js`. My backend is TypeScript, so that was wrong. After I shared `package.json`, it gave the right commands.
2. The AI first told me to rename my SMTP variables to Brevo names. Later it corrected this: the keys are different, so I should add new variables instead.
3. The old README said the refresh cookie uses `SameSite=Strict`. The real code uses `None` in production, and the README was fixed.

## What I checked myself

- I ran the full flow locally: admin creates an invoice, the client sees it, pays with Stripe test card `4242 4242 4242 4242`, the invoice becomes PAID, and the receipt email arrives with the PDF.
- I checked the Render deploy status and logs after each push.
- I read each changed file before replacing it in my project.

## What I learned

- Sharing real logs and screenshots gets much better answers than describing a problem.
- Clear limits ("change only what is needed") keep AI changes small and easy to review.
- Payment status should come from Stripe's own answer, never from the browser.
- A free hosting plan can block SMTP and put the server to sleep, so email and first requests need extra care.
