// ─── Michel STT (Speech-to-Text via ElevenLabs Scribe) ──────────────────────
// Standalone Apps Script Web App. One action: 'transcribe'.
//
// Setup:
//   1. Project Settings → Script Properties → add ELEVENLABS_API_KEY
//   2. Deploy → New deployment → Web app
//      - Execute as: Me
//      - Who has access: Anyone
//   3. Copy /exec URL into webapp/public/app/index.html as GAS_STT constant.
//
// Frontend call shape:
//   POST { action: 'transcribe', audio: <base64 string>, mimeType: 'audio/webm' }
//   Returns: { text: '...' } or { error: '...' }

function doGet() {
  return jsonOut({ ok: true, service: 'Michel_STT' });
}

function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;

    switch (action) {
      case 'transcribe': result = transcribeAudio(body); break;
      case 'synthesize': result = synthesizeSpeech(body); break;
      default:           result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

function transcribeAudio(body) {
  var key = PropertiesService.getScriptProperties().getProperty('ELEVENLABS_API_KEY');
  if (!key) return { error: 'ELEVENLABS_API_KEY not set in Script Properties' };
  if (!body.audio) return { error: 'Missing audio field (base64)' };

  var mimeType = body.mimeType || 'audio/webm';
  var ext      = mimeType.indexOf('mp4')  !== -1 ? 'mp4'
              : mimeType.indexOf('mpeg') !== -1 ? 'mp3'
              : mimeType.indexOf('wav')  !== -1 ? 'wav'
              : mimeType.indexOf('ogg')  !== -1 ? 'ogg'
              : 'webm';

  var blob = Utilities.newBlob(Utilities.base64Decode(body.audio), mimeType, 'audio.' + ext);

  var res = UrlFetchApp.fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'post',
    headers: { 'xi-api-key': key },
    payload: {
      model_id: 'scribe_v1',
      file: blob
    },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    return { error: 'ElevenLabs HTTP ' + code + ': ' + text };
  }

  var parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return { error: 'Invalid JSON from ElevenLabs: ' + text }; }

  return { text: parsed.text || '', raw: parsed };
}

function synthesizeSpeech(body) {
  var key = PropertiesService.getScriptProperties().getProperty('ELEVENLABS_API_KEY');
  if (!key) return { error: 'ELEVENLABS_API_KEY not set in Script Properties' };
  if (!body.text || !body.text.trim()) return { error: 'Missing text field' };

  var voiceId = body.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
  var modelId = body.modelId || 'eleven_flash_v2_5';

  var res = UrlFetchApp.fetch(
    'https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?output_format=mp3_22050_32',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'xi-api-key': key, 'accept': 'audio/mpeg' },
      payload: JSON.stringify({
        text: body.text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      }),
      muteHttpExceptions: true
    }
  );

  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    return { error: 'ElevenLabs TTS HTTP ' + code + ': ' + res.getContentText().slice(0, 200) };
  }

  var bytes = res.getBlob().getBytes();
  return { audio: Utilities.base64Encode(bytes), mimeType: 'audio/mpeg' };
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
