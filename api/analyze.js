export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Password check
  const appPassword = req.headers['x-app-password'];
  if (!appPassword || appPassword !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Forward to Anthropic
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    const body = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
