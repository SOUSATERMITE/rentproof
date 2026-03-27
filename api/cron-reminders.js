export default async function handler(req, res) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Supabase credentials not configured" });
  }
  const month = new Date().toISOString().slice(0, 7);

  try {
    const tenantsRes = await fetch(`${SB_URL}/rest/v1/tenants?active=eq.true&select=*,properties(name,address)`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    const tenants = await tenantsRes.json();
    let sent = 0;
    let errors = 0;
    let lateUpdated = 0;
    let recordsCreated = 0;

    // ── Ensure every active tenant has a payment record for this month ──
    // MVP NOTE: Before scaling, promote this to a dedicated ledger sync job
    // so it isn't coupled to the reminder cron schedule.
    const existingRes = await fetch(`${SB_URL}/rest/v1/payments?month=eq.${month}&select=tenant_id`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    const existing = await existingRes.json();
    // Check tenant_id + month together — never touches existing records,
    // so old payment amounts are preserved even if rent_amount has since changed
    const existingIds = new Set(Array.isArray(existing) ? existing.map(p => p.tenant_id) : []);
    // Defensive filter: only active tenants (tenants query already filters, but be explicit)
    const activeTenants = Array.isArray(tenants) ? tenants.filter(t => t.active !== false) : [];
    const missingTenants = activeTenants.filter(t => !existingIds.has(t.id));
    await Promise.all(missingTenants.map(async t => {
      const insertRes = await fetch(`${SB_URL}/rest/v1/payments`, {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: t.id, month, amount: t.rent_amount, status: "pending",
          due_date: `${month}-${String(t.due_day || 1).padStart(2, "0")}`,
          // amount set once on INSERT — existing records are never touched
        }),
      });
      if (insertRes.ok) { recordsCreated++; return; }
      const err = await insertRes.json().catch(() => ({}));
      if (err.code === "23505") return; // duplicate key (race condition) — safe to ignore
      throw new Error(`Payment insert failed for tenant ${t.id}: ${err.message || insertRes.status}`);
    }));

    // ── Apply late fees & overdue status to all non-verified payments ──
    const pendingRes = await fetch(
      `${SB_URL}/rest/v1/payments?status=not.eq.verified&select=id,status,due_date,is_late,days_late,late_fee_applied,tenant_id,tenants(grace_days,late_fee)`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const pendingPayments = await pendingRes.json();
    if (Array.isArray(pendingPayments)) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (const p of pendingPayments) {
        if (!p.due_date) continue;
        const due = new Date(p.due_date + "T00:00:00");
        const daysLate = Math.max(0, Math.floor((today - due) / 86400000));
        const grace = p.tenants?.grace_days ?? 5;
        const fee = p.tenants?.late_fee ?? 0;
        if (daysLate > grace) {
          const newStatus = p.status === "pending" ? "overdue" : p.status;
          if (!p.is_late || p.days_late !== daysLate || p.late_fee_applied !== fee || p.status !== newStatus) {
            await fetch(`${SB_URL}/rest/v1/payments?id=eq.${p.id}`, {
              method: "PATCH",
              headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ is_late: true, days_late: daysLate, late_fee_applied: fee, status: newStatus }),
            });
            lateUpdated++;
          }
        }
      }
    }

    for (const tenant of tenants) {
      const tenantPayRes = await fetch(`${SB_URL}/rest/v1/payments?tenant_id=eq.${tenant.id}&month=eq.${month}`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      const tenantPay = await tenantPayRes.json();
      if (!tenantPay || !tenantPay.length) continue;
      if (tenantPay[0].status === "verified") continue;
      const paymentId = tenantPay[0].id;

      const baseUrl = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
      const link = `${baseUrl}/pay.html?id=${paymentId}`;
      const amount = "$" + (tenant.rent_amount / 100).toLocaleString();
      const firstName = tenant.name.split(" ")[0];
      const message = `Hi ${firstName}, your rent of ${amount}${tenant.unit ? ` for Unit ${tenant.unit}` : ""} is due today. Pay via ${tenant.payment_method || "your usual method"} and upload proof here: ${link} Reply STOP to opt out.`;

      try {
        const smsRes = await fetch(`${baseUrl}/api/send-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: tenant.phone, message }),
        });
        if (smsRes.ok) {
          await fetch(`${SB_URL}/rest/v1/reminders`, {
            method: "POST",
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ tenant_id: tenant.id, type: "due_reminder", message, month }),
          });
          sent++;
        } else { errors++; }
      } catch (e) { errors++; }
    }

    return res.status(200).json({ success: true, month, tenants: tenants.length, recordsCreated, sent, errors, lateUpdated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
