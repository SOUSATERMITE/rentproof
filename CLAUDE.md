# CLAUDE.md — RentProof Project Guide

## What Is RentProof

RentProof (rentproof.homes) is an SMS-first rent verification SaaS for small landlords.
The core workflow: landlord sends tenant a text reminder → tenant clicks link and uploads a screenshot of their Zelle/Venmo/CashApp payment → landlord approves → receipt auto-sent. No payment processing, no tenant accounts, no app downloads.

**Domain:** rentproof.homes (Namecheap, nameservers pointed to Netlify for landing page)
**App URL:** https://rentproof-mu.vercel.app
**GitHub:** github.com/SOUSATERMITE/rentproof

---

## Tech Stack

| Layer | Service | Details |
|-------|---------|---------|
| Frontend | Vanilla HTML + React (CDN) | Single-page app via Babel in-browser transform. No build step. |
| Hosting | Vercel | Auto-deploys from GitHub. Serverless functions in `/api/`. |
| Database | Supabase | Project URL in Vercel env var `SUPABASE_URL` |
| Database Key | Supabase anon key | In Vercel env var `SUPABASE_KEY`. Also hardcoded in `index.html` / `pay.html` (publishable key, safe for browser). |
| File Storage | Supabase Storage | Bucket: `rentproof-files` (public). Folders: `/proofs`, `/receipts`, `/vault` |
| SMS | Twilio | Credentials in Vercel env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| SMS Number | Twilio toll-free | `+18884116139` — **PENDING carrier verification** (Error 30032). SMS sends via API but carriers block delivery until Twilio approves toll-free verification. |
| Landing Page | Netlify | rentproof.homes points here. Separate from the app. |
| Email Collection | Formspree | `https://formspree.io/f/mojkklny` (on landing page) |
| Cron | Vercel Cron | `/api/cron-reminders` runs 1st of month at 9am ET (0 14 1 * *) |

---

## Project Structure

```
rentproof/
├── api/
│   ├── send-sms.js          # Twilio SMS endpoint (POST /api/send-sms)
│   └── cron-reminders.js     # Auto-reminder cron (1st of month)
├── public/
│   ├── index.html            # Main dashboard (React SPA, all tabs)
│   ├── pay.html              # Tenant upload page (what tenants see from SMS link)
│   └── sms-test.html         # SMS debugging page
├── package.json
└── vercel.json               # Deployment config + cron schedule
```

---

## Database Schema (Supabase — PostgreSQL)

All tables exist and have RLS policies set to allow all operations (open for MVP, lock down later).

### Tables

**properties**
- `id` uuid PK, `created_at` timestamptz, `name` text NOT NULL, `address` text, `type` text default 'residential', `units` text[] default '{}', `owner_id` uuid

**tenants**
- `id` uuid PK, `created_at` timestamptz, `name` text NOT NULL, `email` text, `phone` text NOT NULL, `unit` text, `property_id` uuid FK→properties, `rent_amount` integer NOT NULL (stored as CENTS — $1500 = 150000), `payment_method` text default 'zelle', `due_day` integer default 1, `grace_days` integer default 5, `late_fee` integer default 50 (CENTS), `lease_start` date, `lease_end` date, `active` boolean default true

**payments**
- `id` uuid PK, `created_at` timestamptz, `tenant_id` uuid FK→tenants NOT NULL, `month` text NOT NULL (format: '2026-03'), `amount` integer NOT NULL (CENTS), `status` text default 'pending' (pending | proof_uploaded | verified | overdue), `due_date` date, `proof_url` text, `proof_uploaded_at` timestamptz, `approved_at` timestamptz, `receipt_sent` boolean default false, `receipt_id` text, `is_late` boolean default false, `days_late` integer default 0, `late_fee_applied` integer default 0 (CENTS), `notes` text

**receipts**
- `id` uuid PK, `created_at` timestamptz, `payment_id` uuid FK→payments, `tenant_id` uuid FK→tenants, `receipt_number` text NOT NULL, `tenant_name` text, `property_address` text, `unit` text, `amount` integer (CENTS), `rental_period` text, `payment_method` text, `date_received` date, `date_verified` timestamptz, `proof_reference` text, `sent_via_sms` boolean, `sent_via_email` boolean, `pdf_url` text

**documents** (Landlord Vault)
- `id` uuid PK, `created_at` timestamptz, `name` text NOT NULL, `type` text NOT NULL (lease|deed|insurance|inspection|tax|certificate|survey|financial|id|photo|other), `file_url` text NOT NULL, `file_size` text, `property_id` uuid FK→properties, `tenant_id` uuid FK→tenants, `uploaded_by` text default 'landlord'

**reminders**
- `id` uuid PK, `created_at` timestamptz, `tenant_id` uuid FK→tenants, `type` text (due_reminder|late_reminder|receipt|custom), `message` text, `sent_via` text default 'sms', `sent_at` timestamptz, `month` text

**settings** (single row)
- `id` uuid PK, `business_name` text, `landlord_name` text, `landlord_email` text, `landlord_phone` text, `reminder_day` integer default 1, `late_reminder_days` integer default 3, `auto_send_receipts` boolean default true, `receipt_branding` text

### Storage Policies
- SELECT: allowed for anon on bucket `rentproof-files`
- INSERT: allowed for anon on bucket `rentproof-files`
- UPDATE: allowed for anon on bucket `rentproof-files`
- DELETE: allowed for anon on bucket `rentproof-files`

### CRITICAL: Money is stored in CENTS
- Rent $1,500/mo → stored as `150000`
- Late fee $50 → stored as `5000`
- When displaying: divide by 100
- When saving from user input: multiply by 100
- Format for display: `"$" + (cents / 100).toLocaleString()`

### CRITICAL: Phone numbers
- Stored in E.164 format: `+19085551234`
- User may input: `9085551234`, `(908) 555-1234`, `908-555-1234`
- Always normalize before saving: strip non-digits, prepend +1 if 10 digits

---

## What's Built (15 features — all working)

### Core SMS Workflow
1. **SMS Reminder** — Landlord taps 📱 on a tenant → creates payment record → sends SMS via Twilio with rent amount + unique upload link
2. **Tenant Upload Page** (`pay.html`) — Tenant clicks link, sees their name/unit/amount, uploads screenshot of payment. No login, no app.
3. **Landlord Approve** — Payments tab shows proof_uploaded payments → landlord clicks "View Proof" → sees image → taps "Approve"
4. **Receipt SMS** — On approval, receipt record created + SMS sent to tenant with receipt number
5. **Bulk Reminders** — "Send All Reminders" button sends to every active tenant

### Dashboard Tabs
6. **Dashboard** — Stats: properties count, collected vs expected, needs approval count, not paid count
7. **Properties** — Add/delete properties with name, address, type, comma-separated units. Shows assigned tenants. Blocks delete if tenants exist.
8. **Tenants** — Add tenants with ALL fields (name, phone, email, property, unit, rent, payment method, due day, grace days, late fee, lease start/end). MUST select a property. Grouped by property. Individual 📱 reminder button per tenant.
9. **Payments** — Filter by all/review/verified/overdue. View proof image in modal. One-tap approve. Shows days late + auto-calculated late fee.
10. **Rent Roll** — Monthly one-page grid: every tenant, property/unit, rent due, status (Paid/Proof/Pending/None), days late, late fee. Month selector. CSV export. Print. Per-tenant "📄 History" button opens court-ready doc.
11. **Vault** — Upload documents with type (lease/deed/insurance/etc), assign to property AND/OR tenant. Grouped by property. View + delete.
12. **Settings** — Business name, landlord name/email/phone, reminder day, late reminder days, auto-receipt toggle.

### Auto-Calculations
13. **Late Fee Auto-Calc** — Compares today vs due_date. If days_late > tenant.grace_days, shows tenant.late_fee on Payments and Rent Roll tabs.
14. **CSV Export** — Rent Roll monthly export + per-tenant payment history export
15. **Court-Ready Documents** — Modal with formal payment history table, tenant/property info, landlord info, print-to-PDF button

### Cron Job
- `/api/cron-reminders` runs on 1st of each month at 9am ET
- Loops all active tenants, creates payment records, sends SMS reminders
- Skips tenants who already have a verified payment for the month

---

## What's NOT Working / Pending

### SMS Delivery Blocked (Error 30032)
- Twilio API calls succeed (return `success: true` with SID)
- But carriers block delivery because toll-free number `+18884116139` hasn't passed verification
- Phil submitted the toll-free verification form in Twilio Console → Messaging → Compliance
- **Once approved, all SMS features work immediately with zero code changes**
- Check status: Twilio Console → Messaging → Compliance → Toll-Free Verification

### Domain Routing
- `rentproof.homes` currently points to Netlify (landing page)
- App is on Vercel at `rentproof-mu.vercel.app`
- Decision needed: keep Netlify for landing + Vercel for app, OR move everything to Vercel
- If moving to Vercel: update Namecheap nameservers to Vercel, add domain in Vercel project settings

---

## What Needs To Be Built / Improved

### High Priority (MVP completeness)
- [ ] **pay.html needs testing end-to-end** — The tenant upload page exists but hasn't been tested with a real payment record + real file upload + status change to proof_uploaded. Test: send reminder → click link → upload image → verify payment status changes in dashboard.
- [ ] **Receipt PDF generation** — Currently receipts are text-only SMS. Should generate actual PDF receipts stored in Supabase Storage and optionally emailed.
- [ ] **Demand letter generation** — Court doc modal shows payment history but doesn't generate a formal demand letter. Add a "Generate Demand Letter" button that creates a pre-filled letter with tenant name, amount owed, dates, and landlord signature block.
- [ ] **Edit tenant** — Can add and remove tenants but can't edit existing tenant details (phone, rent amount, unit, etc.). Need an edit modal or inline editing.
- [ ] **Edit property** — Can add and delete properties but can't edit name/address/units.

### Medium Priority (Post-launch)
- [ ] **Authentication** — Currently no login. Anyone with the URL can access the dashboard. Add Supabase Auth (email/password or magic link).
- [ ] **Multi-user / owner_id** — The `owner_id` column exists on properties but isn't used. Once auth is added, filter all data by the logged-in user's ID.
- [ ] **Tenant portal** — A page where tenants can see their own payment history and download receipts. Access via unique link (no account needed).
- [ ] **Email receipts** — Send receipt as email attachment (PDF) in addition to SMS.
- [ ] **Late fee auto-apply** — Currently late fees are displayed but not actually written to the `late_fee_applied` column on the payment record. Should auto-update payment records when grace period expires.
- [ ] **Overdue status auto-update** — Payments with status "pending" should auto-change to "overdue" after the grace period. Could be done via cron or on dashboard load.
- [ ] **Payment history chart** — Visual chart on Dashboard showing monthly collection trends.

### Low Priority (Future features from business plan)
- [ ] **Plaid bank connection** — Auto-detect incoming Zelle/Venmo deposits (eliminates manual proof upload)
- [ ] **Tenant credit reporting** — Report on-time payments to credit bureaus
- [ ] **QuickBooks/Xero integration** — Export to accounting software
- [ ] **Mobile app** — React Native iOS + Android
- [ ] **White-label receipts** — Landlord logo on receipts
- [ ] **Lease template marketplace** — State-specific lease templates

---

## API Endpoints

### POST /api/send-sms
Sends an SMS via Twilio.
```json
{
  "to": "+19085551234",
  "message": "Hi John, your rent of $1,500 for Unit 2A is due..."
}
```
Returns: `{ "success": true, "sid": "SM..." }` or `{ "error": "...", "code": 30032 }`

### GET /api/cron-reminders
Triggered by Vercel Cron on 1st of month. Loops all active tenants, creates payment records, sends SMS reminders. Returns: `{ "success": true, "month": "2026-04", "tenants": 5, "sent": 5, "errors": 0 }`

---

## Supabase REST API Pattern

All database operations use the Supabase REST API directly from the browser (no backend needed for CRUD):

```javascript
// GET
const data = await fetch(`${SB_URL}/rest/v1/tenants?active=eq.true&order=name`, {
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
}).then(r => r.json());

// POST (create)
const created = await fetch(`${SB_URL}/rest/v1/tenants`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ name: "John", phone: "+19085551234", rent_amount: 150000, property_id: "uuid-here" })
}).then(r => r.json());

// PATCH (update)
await fetch(`${SB_URL}/rest/v1/tenants?id=eq.${id}`, {
  method: "PATCH",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ active: false })
});

// DELETE
await fetch(`${SB_URL}/rest/v1/documents?id=eq.${id}`, {
  method: "DELETE",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
});

// JOIN (select related data)
// Tenants with their property: select=*,properties(id,name,address)
// Payments with tenant and property: select=*,tenants(name,unit,phone,properties(name,address))
```

### File Upload to Supabase Storage
```javascript
const res = await fetch(`${SB_URL}/storage/v1/object/rentproof-files/${path}`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": file.type },
  body: file
});
const publicUrl = `${SB_URL}/storage/v1/object/public/rentproof-files/${path}`;
```

---

## Deployment

Push to `main` branch on GitHub → Vercel auto-deploys in ~60 seconds.

```bash
git add .
git commit -m "description of changes"
git push origin main
```

Vercel config (`vercel.json`):
- Build command: `echo done` (no build step — static HTML)
- Output directory: `public`
- API functions auto-detected from `/api/` folder
- Cron: `/api/cron-reminders` at `0 14 1 * *` (1st of month, 2pm UTC = 9am ET)

---

## Pricing (from business plan)

| Tier | Units | Price |
|------|-------|-------|
| Free | 1 | $0/mo |
| Pro | Up to 5 | $19/mo |
| Business | Up to 15 | $39/mo |

---

## Key Rules

1. **ALWAYS store money as cents (integer).** $1,500 = 150000. Never store as float or dollars.
2. **ALWAYS normalize phone to +1XXXXXXXXXX** before saving to database or sending to Twilio.
3. **ALWAYS grep the entire file** for old text before declaring any text replacement is done (learned from Sousa SEO project).
4. **Tenants MUST be assigned to a property.** The UI blocks adding a tenant without selecting a property.
5. **Properties can't be deleted if they have tenants.** Remove tenants first.
6. **The `pay.html` page is public** — tenants access it via SMS link with a payment ID. No auth required.
7. **Vercel serverless functions** in `/api/` are Node.js ES modules (use `export default`).
