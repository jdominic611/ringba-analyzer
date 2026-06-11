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
      // Follow redirects, detect real content type
      const audioResp = await fetch(recordingUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(25000)
      });

      if (!audioResp.ok) throw new Error(`Download failed: HTTP ${audioResp.status}`);

      const audioBuffer = await audioResp.arrayBuffer();
      const audioBytes = new Uint8Array(audioBuffer);

      // Detect format from Content-Type header first, then URL, then magic bytes
      const contentType = audioResp.headers.get('content-type') || '';
      let mimeType = 'audio/mpeg';
      let filename = 'audio.mp3';

      if (contentType.includes('wav') || contentType.includes('wave')) {
        mimeType = 'audio/wav'; filename = 'audio.wav';
      } else if (contentType.includes('mp4') || contentType.includes('m4a')) {
        mimeType = 'audio/mp4'; filename = 'audio.mp4';
      } else if (contentType.includes('flac')) {
        mimeType = 'audio/flac'; filename = 'audio.flac';
      } else if (contentType.includes('webm')) {
        mimeType = 'audio/webm'; filename = 'audio.webm';
      } else if (contentType.includes('ogg')) {
        mimeType = 'audio/ogg'; filename = 'audio.ogg';
      } else {
        // Try magic bytes to detect format
        const header = audioBytes.slice(0, 12);
        if (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) {
          mimeType = 'audio/mpeg'; filename = 'audio.mp3';
        } else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
          mimeType = 'audio/wav'; filename = 'audio.wav';
        } else if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
          mimeType = 'audio/mp4'; filename = 'audio.mp4';
        } else if (header[0] === 0x66 && header[1] === 0x4C && header[2] === 0x61 && header[3] === 0x43) {
          mimeType = 'audio/flac'; filename = 'audio.flac';
        } else if (header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3) {
          mimeType = 'audio/webm'; filename = 'audio.webm';
        } else {
          // Fall back to URL extension
          const urlPath = recordingUrl.split('?')[0].toLowerCase();
          if (urlPath.endsWith('.wav')) { mimeType = 'audio/wav'; filename = 'audio.wav'; }
          else if (urlPath.endsWith('.m4a')) { mimeType = 'audio/mp4'; filename = 'audio.mp4'; }
          else if (urlPath.endsWith('.flac')) { mimeType = 'audio/flac'; filename = 'audio.flac'; }
          else if (urlPath.endsWith('.webm')) { mimeType = 'audio/webm'; filename = 'audio.webm'; }
          else if (urlPath.endsWith('.ogg')) { mimeType = 'audio/ogg'; filename = 'audio.ogg'; }
          else { mimeType = 'audio/mpeg'; filename = 'audio.mp3'; }
        }
      }

      // Build multipart form for Whisper
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

  // Step 2: Claude classification
  try {
    const dur = callData.duration || '0:00';
    const durSec = callData.durSec || 0;
    const hasRec = !!(recordingUrl && recordingUrl.trim());
    const ringbaTranscription = callData.ringbaTranscription || '';
    const transcriptForPrompt = transcriptionText || ringbaTranscription || '';
    const transcriptFailed = transcriptionText.startsWith('[') && transcriptionText.endsWith(']');

    const prompt = `You are analyzing a phone call for a call center. Classify it accurately.

Call metadata:
- Duration: ${dur} (${durSec} seconds)
- Has recording: ${hasRec}
- Revenue: ${callData.revenue || '0'}
- End call source: ${callData.endCallSource || 'unknown'}

${!transcriptFailed && transcriptForPrompt ? `Transcript:\n"${transcriptForPrompt}"` : ''}
${transcriptFailed ? `Transcription failed: ${transcriptionText}\nClassify using metadata only.` : ''}
${!transcriptForPrompt ? 'No transcript available.' : ''}

Return ONLY valid JSON, no markdown:
{"classification":"Legitimate"|"Dead Air"|"Static/Noise"|"Short Hang-up"|"No Audio","confidence":"High"|"Medium"|"Low","notes":"one sentence describing what happened","transcript_summary":"brief summary or null"}

Rules:
- Real words/sentences in transcript = Legitimate
- Silence only = Dead Air
- Noise/static/tones only = Static/Noise
- Connected 1-5s then dropped = Short Hang-up
- No recording = No Audio
- Revenue > 0 supports Legitimate`;

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
    const msg = err.name === 'TimeoutError' ? 'Claude timed out' : (err.message || String(err));
    return res.status(500).json({ error: msg });
  }
}
