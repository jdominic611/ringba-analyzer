export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const appPassword = req.headers['x-app-password'];
  if (!appPassword || appPassword !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!claudeKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { recordingUrl, callData } = req.body;

  let transcriptionText = '';

  // Step 1: Download and transcribe with Whisper
  if (recordingUrl && recordingUrl.trim()) {
    try {
      const audioResp = await fetch(recordingUrl, { signal: AbortSignal.timeout(20000) });
      if (!audioResp.ok) throw new Error(`Download failed: HTTP ${audioResp.status}`);

      const audioBuffer = await audioResp.arrayBuffer();
      const audioBytes = new Uint8Array(audioBuffer);

      const urlPath = recordingUrl.split('?')[0];
      const ext = urlPath.split('.').pop().toLowerCase() || 'mp3';
      const mimeType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const filename = `audio.${ext}`;

      const boundary = '----WB' + Math.random().toString(36).slice(2);
      const encoder = new TextEncoder();

      const partA = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      const partB = encoder.encode(`\r\n--${boundary}--\r\n`);

      const body = new Uint8Array(partA.length + audioBytes.length + partB.length);
      body.set(partA, 0);
      body.set(audioBytes, partA.length);
      body.set(partB, partA.length + audioBytes.length);

      const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body,
        signal: AbortSignal.timeout(25000)
      });

      if (whisperResp.ok) {
        const whisperData = await whisperResp.json();
        transcriptionText = (whisperData.text || '').trim();
      } else {
        const errText = await whisperResp.text();
        let errMsg = `Whisper error ${whisperResp.status}`;
        try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch {}
        transcriptionText = `[${errMsg}]`;
      }
    } catch (audioErr) {
      const msg = audioErr.name === 'TimeoutError' ? 'Audio download timed out' : (audioErr.message || String(audioErr));
      transcriptionText = `[${msg}]`;
    }
  }

  // Step 2: Claude classification
  try {
    const dur = callData.duration || '0:00';
    const durSec = callData.durSec || 0;
    const hasRec = !!(recordingUrl && recordingUrl.trim());
    const ringbaTranscription = callData.ringbaTranscription || '';
    const transcriptForPrompt = transcriptionText || ringbaTranscription || '';

    const prompt = `You are analyzing a phone call for a call center. Classify it based on the transcript below.

Call metadata:
- Duration: ${dur} (${durSec} seconds)
- Has recording: ${hasRec}
- Revenue: ${callData.revenue || '0'}
- End call source: ${callData.endCallSource || 'unknown'}

${transcriptForPrompt
  ? `Transcript:\n"${transcriptForPrompt}"`
  : 'No transcript available — no recording or transcription failed.'}

Return ONLY valid JSON, no markdown:
{"classification":"Legitimate"|"Dead Air"|"Static/Noise"|"Short Hang-up"|"No Audio","confidence":"High"|"Medium"|"Low","notes":"one sentence describing what happened","transcript_summary":"brief summary or null"}

Rules:
- Transcript has real words/sentences = Legitimate
- Only silence detected = Dead Air  
- Only noise/static/robocall tones = Static/Noise
- Connected then immediately dropped (1-5s) = Short Hang-up
- No recording at all = No Audio
- Transcription error in brackets = classify by metadata only`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(15000)
    });

    const claudeData = await claudeResp.json();
    if (claudeData.error) throw new Error(claudeData.error.message || JSON.stringify(claudeData.error));

    const rawText = claudeData.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(rawText);

    return res.status(200).json({
      classification: parsed.classification,
      confidence: parsed.confidence,
      notes: parsed.notes,
      transcript_summary: parsed.transcript_summary || null,
      transcription: transcriptionText || null
    });

  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Claude request timed out' : (err.message || String(err));
    return res.status(500).json({ error: msg });
  }
}
