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

    for (const tenant of tenants) {
      const existingRes = await fetch(`${SB_URL}/rest/v1/payments?tenant_id=eq.${tenant.id}&month=eq.${month}`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      const existing = await existingRes.json();

      let paymentId;
      if (!existing || existing.length === 0) {
        const createRes = await fetch(`${SB_URL}/rest/v1/payments`, {
          method: "POST",
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({
            tenant_id: tenant.id, month, amount: tenant.rent_amount, status: "pending",
            due_date: `${month}-${String(tenant.due_day || 1).padStart(2, "0")}`,
          }),
        });
        const created = await createRes.json();
        paymentId = created[0]?.id;
      } else {
        if (existing[0].status === "verified") continue;
        paymentId = existing[0].id;
      }

      const baseUrl = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
      const link = `${baseUrl}/pay.html?id=${paymentId}`;
      const amount = "$" + (tenant.rent_amount / 100).toLocaleString();
      const firstName = tenant.name.split(" ")[0];
      const message = `Hi ${firstName}, your rent of ${amount}${tenant.unit ? ` for Unit ${tenant.unit}` : ""} is due today. Pay via ${tenant.payment_method || "your usual method"} and upload proof here: ${link}`;

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

    return res.status(200).json({ success: true, month, tenants: tenants.length, sent, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
