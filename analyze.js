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

  try {
    let transcription = null;
    let transcriptionText = '';

    // Step 1: If there's a recording URL, download and transcribe with Whisper
    if (recordingUrl && recordingUrl.trim()) {
      try {
        // Download the audio file
        const audioResp = await fetch(recordingUrl);
        if (!audioResp.ok) throw new Error(`Audio download failed: ${audioResp.status}`);
        
        const audioBuffer = await audioResp.arrayBuffer();
        const audioBlob = new Uint8Array(audioBuffer);
        
        // Build multipart form for Whisper API
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        
        // Determine file extension from URL
        const urlPath = recordingUrl.split('?')[0];
        const ext = urlPath.split('.').pop().toLowerCase() || 'mp3';
        const mimeType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
        const filename = `audio.${ext}`;

        // Build multipart body manually
        const encoder = new TextEncoder();
        const parts = [];
        
        parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
        parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`));
        parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
        parts.push(audioBlob);
        parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

        const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.length;
        }

        const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: body
        });

        if (whisperResp.ok) {
          const whisperData = await whisperResp.json();
          transcription = whisperData.text || '';
          transcriptionText = transcription.trim();
        } else {
          const errData = await whisperResp.json();
          transcriptionText = `[Transcription failed: ${errData.error?.message || whisperResp.status}]`;
        }
      } catch (audioErr) {
        transcriptionText = `[Audio error: ${audioErr.message}]`;
      }
    }

    // Step 2: Send to Claude for classification
    const dur = callData.duration || '0:00';
    const durSec = callData.durSec || 0;
    const hasRec = !!(recordingUrl && recordingUrl.trim());
    const ringbaTranscription = callData.ringbaTranscription || '';

    const transcriptForAnalysis = transcriptionText || ringbaTranscription || '';

    const prompt = `You are analyzing a phone call recording for a call center. Classify this call accurately based on the actual transcription provided.

Call metadata:
- Duration: ${dur} (${durSec} seconds)
- Has recording: ${hasRec}
- Revenue generated: ${callData.revenue || '0'}
- End call source: ${callData.endCallSource || 'unknown'}
- Time to connect: ${callData.timeToConnect || 'unknown'}

${transcriptionText ? `Whisper transcription of actual audio:
"${transcriptionText}"` : ''}
${ringbaTranscription && !transcriptionText ? `Ringba transcription:
"${ringbaTranscription}"` : ''}
${!transcriptForAnalysis ? 'No transcription available.' : ''}

Classify this call. Return ONLY valid JSON, no markdown, no explanation:
{
  "classification": "Legitimate" | "Dead Air" | "Static/Noise" | "Short Hang-up" | "No Audio",
  "confidence": "High" | "Medium" | "Low",
  "notes": "one clear sentence describing what actually happened on this call",
  "transcript_summary": "brief summary of what was said, or null if no audio"
}

Classification rules:
- "Legitimate": Real conversation between two people, even if brief
- "Dead Air": Connected but only silence, no speech detected
- "Static/Noise": Connected but only background noise, static, robocall tones, or unintelligible sounds
- "Short Hang-up": Someone connected for 1-5 seconds then immediately hung up
- "No Audio": No recording URL or completely empty/failed audio
- If transcription has real words and sentences = almost certainly Legitimate
- Revenue > 0 supports Legitimate but transcription content takes priority`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeResp.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    const text = claudeData.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    return res.status(200).json({
      classification: parsed.classification,
      confidence: parsed.confidence,
      notes: parsed.notes,
      transcript_summary: parsed.transcript_summary,
      transcription: transcriptionText || null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
