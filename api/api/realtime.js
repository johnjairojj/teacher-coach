// /api/realtime.js
// Relay del SDP hacia OpenAI Realtime para evitar CORS (se hace server-side).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // El modelo viene por query (?model=...)
  const model = (req.query?.model || 'gpt-4o-realtime-preview') + '';
  // El cliente envía el token efímero en Authorization (Bearer ...)
  const auth = req.headers['authorization'];
  if (!auth) {
    return res.status(401).json({ error: 'Missing Authorization (ephemeral key)' });
  }

  // Leer el cuerpo como texto (SDP)
  let sdp = '';
  try {
    await new Promise((resolve, reject) => {
      req.setEncoding('utf8');
      req.on('data', (chunk) => (sdp += chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: 'Could not read SDP body' });
  }
  if (!sdp || typeof sdp !== 'string') {
    return res.status(400).json({ error: 'Empty SDP body' });
  }

  try {
    const upstream = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        Authorization: auth,              // <-- forward Bearer <ephemeral>
        'Content-Type': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: sdp,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    // Devolver como SDP a la app
    res.setHeader('Content-Type', 'application/sdp');
    return res.send(text);
  } catch (e) {
    console.error('[api/realtime] relay error', e);
    return res.status(502).json({ error: 'Upstream relay failed' });
  }
}
