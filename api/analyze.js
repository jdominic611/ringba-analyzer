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
      const audioResp = await fetch(recordingUrl, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (!audioResp.ok) throw new Error(`Download failed: HTTP ${audioResp.status}`);

      const audioBuffer = await audioResp.arrayBuffer();
      const audioBytes = new Uint8Array(audioBuffer);

      const contentType = audioResp.headers.get('content-type') || '';
      let mimeType = 'audio/mpeg', filename = 'audio.mp3';

      if (contentType.includes('wav') || contentType.includes('wave')) { mimeType = 'audio/wav'; filename = 'audio.wav'; }
      else if (contentType.includes('mp4') || contentType.includes('m4a')) { mimeType = 'audio/mp4'; filename = 'audio.mp4'; }
      else if (contentType.includes('flac')) { mimeType = 'audio/flac'; filename = 'audio.flac'; }
      else if (contentType.includes('webm')) { mimeType = 'audio/webm'; filename = 'audio.webm'; }
      else if (contentType.includes('ogg')) { mimeType = 'audio/ogg'; filename = 'audio.ogg'; }
      else {
        const h = audioBytes.slice(0, 12);
        if (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0) { mimeType = 'audio/mpeg'; filename = 'audio.mp3'; }
        else if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) { mimeType = 'audio/wav'; filename = 'audio.wav'; }
        else if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) { mimeType = 'audio/mp4'; filename = 'audio.mp4'; }
        else if (h[0] === 0x66 && h[1] === 0x4C && h[2] === 0x61 && h[3] === 0x43) { mimeType = 'audio/flac'; filename = 'audio.flac'; }
        else if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) { mimeType = 'audio/webm'; filename = 'audio.webm'; }
        else {
          const urlPath = recordingUrl.split('?')[0].toLowerCase();
          if (urlPath.endsWith('.wav')) { mimeType = 'audio/wav'; filename = 'audio.wav'; }
          else if (urlPath.endsWith('.m4a')) { mimeType = 'audio/mp4'; filename = 'audio.mp4'; }
          else if (urlPath.endsWith('.flac')) { mimeType = 'audio/flac'; filename = 'audio.flac'; }
          else if (urlPath.endsWith('.webm')) { mimeType = 'audio/webm'; filename = 'audio.webm'; }
          else { mimeType = 'audio/mpeg'; filename = 'audio.mp3'; }
        }
      }

      const boundary = '----WB' + Math.random().toString(36).slice(2);
      const encoder = new TextEncoder();
      const partA = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      const partB = encoder.encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(partA.length + audioBytes.length + partB.length);
      body.set(partA, 0); body.set(audioBytes, partA.length); body.set(partB, partA.length + audioBytes.length);

      const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(30000)
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
      const msg = audioErr.name === 'TimeoutError' ? 'Audio timed out' : (audioErr.message || String(audioErr));
      transcriptionText = `[${msg}]`;
    }
  }

  // Step 2: Claude classification + review flag
  try {
    const dur = callData.duration || '0:00';
    const durSec = callData.durSec || 0;
    const hasRec = !!(recordingUrl && recordingUrl.trim());
    const revenue = parseFloat(callData.revenue || '0') || 0;
    const ringbaTranscription = callData.ringbaTranscription || '';
    const transcriptForPrompt = transcriptionText || ringbaTranscription || '';
    const transcriptFailed = transcriptionText.startsWith('[') && transcriptionText.endsWith(']');

    const prompt = `You are a call quality analyst reviewing short phone calls for a life insurance call center. Analyze this call and return two things: a classification and a review flag.

Call metadata:
- Duration: ${dur} (${durSec} seconds)
- Has recording: ${hasRec}
- Revenue billed: $${revenue}
- End call source: ${callData.endCallSource || 'unknown'}

${!transcriptFailed && transcriptForPrompt ? `Transcript:\n"${transcriptForPrompt}"` : ''}
${transcriptFailed ? `Transcription failed: ${transcriptionText}\nClassify using metadata only.` : ''}
${!transcriptForPrompt ? 'No transcript available.' : ''}

Return ONLY valid JSON, no markdown:
{
  "classification": "Legitimate - Real Call" | "Legitimate - Wrong Number" | "Legitimate - Voicemail" | "Dead Air" | "Static/Noise" | "Short Hang-up" | "No Audio",
  "confidence": "High" | "Medium" | "Low",
  "notes": "one sentence describing what actually happened",
  "transcript_summary": "brief summary of conversation or null",
  "review_flag": "Pay" | "Review" | "Dispute" | null
}

Classification rules:
- "Legitimate - Real Call": Customer has actual intent related to the business (insurance inquiry, billing, policy question, complaint)
- "Legitimate - Wrong Number": Real human conversation but caller dialed wrong number / unrelated inquiry
- "Legitimate - Voicemail": Call hit voicemail/IVR system, may or may not have left message
- "Dead Air": Connected but only silence
- "Static/Noise": Only background noise, static, or robocall tones
- "Short Hang-up": Connected 1-5 seconds then immediately dropped
- "No Audio": No recording at all

Review flag rules (ONLY assign if revenue > 0, otherwise return null):
- "Pay": Legitimate - Real Call with clear customer intent and genuine business interaction worth the $${revenue}
- "Review": Connected and real conversation happened BUT questionable value — wrong number, voicemail only, caller confused, incoherent, or disconnected before any real service
- "Dispute": Strong case to not pay — Dead Air, Static/Noise, IVR voicemail with no real message, or completely worthless interaction billed anyway

Be strict with "Pay" — only real customers with genuine insurance-related intent qualify.`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
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
      review_flag: parsed.review_flag || null,
      transcription: transcriptionText || null
    });

  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Claude timed out' : (err.message || String(err));
    return res.status(500).json({ error: msg });
  }
}
