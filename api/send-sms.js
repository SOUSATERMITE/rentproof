export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "Missing to or message" });

  const ACCOUNT_SID = "AC932fcb18a26c09c496b38e977971947e";
  const AUTH_TOKEN = "ad97e1682b0b40d689b0c54b172ce933";
  const FROM_NUMBER = "+18884116139";

  try {
    const auth = btoa(ACCOUNT_SID + ":" + AUTH_TOKEN);
    const response = await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" + ACCOUNT_SID + "/Messages.json",
      {
        method: "POST",
        headers: {
          "Authorization": "Basic " + auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "To=" + encodeURIComponent(to) + "&From=" + encodeURIComponent(FROM_NUMBER) + "&Body=" + encodeURIComponent(message),
      }
    );

    const data = await response.json();
    if (response.ok) {
      return res.status(200).json({ success: true, sid: data.sid });
    } else {
      return res.status(400).json({ error: data.message, code: data.code });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
