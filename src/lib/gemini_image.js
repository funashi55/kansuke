import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
// Default to the image-preview capable model per request
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image-preview';
const GEMINI_DEBUG = process.env.GEMINI_DEBUG === '1';
const dlog = (...a) => { if (GEMINI_DEBUG) console.log('[GEMINI_IMG]', ...a); };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function generateEditedMascotImage({ instruction, baseImagePath, outDir = 'public/media' }) {
  if (!GEMINI_API_KEY) return null;
  try {
    const absBase = path.isAbsolute(baseImagePath) ? baseImagePath : path.join(process.cwd(), baseImagePath);
    if (!fs.existsSync(absBase)) {
      console.warn('[GEMINI_IMG] base image not found:', absBase);
      return null;
    }
    const bytes = fs.readFileSync(absBase);
    const b64 = bytes.toString('base64');
    const sys = 'あなたは画像編集のアシスタントです。ベース画像のキャラクターの顔立ち・配色・テイストを保ちつつ、指示に沿って自然なイラストに調整してください。背景はシンプルで可読性を重視。応答は画像のみを返し、テキストは返さないでください。';
    const parts = [
      { text: `${sys}\n編集指示: ${instruction}` },
      { inline_data: { mime_type: 'image/png', data: b64 } },
    ];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    dlog('request', { model: GEMINI_IMAGE_MODEL, baseImagePath, outDir, instrLen: String(instruction||'').length, baseSize: bytes.length });
    const resp = await axios.post(
      url,
      {
        // For image-preview models, request image generation by sending text + base image.
        // Do NOT set response_mime_type here (API rejects non-text types for this endpoint).
        contents: [{ role: 'user', parts }],
      },
      { timeout: 45000, headers: { 'content-type': 'application/json' } }
    );
    // Find first inline_data image in candidates
    const candidates = resp.data?.candidates || [];
    dlog('response.candidates', { count: candidates.length });
    let inline = null;
    for (const c of candidates) {
      const parts = c?.content?.parts || [];
      dlog('parts', parts.map((p) => Object.keys(p))[0]);
      inline = parts.find((p) => p.inline_data && p.inline_data.data);
      if (inline) break;
    }
    if (!inline) {
      dlog('no-inline-image', { firstCandidate: candidates[0] ? Object.keys(candidates[0]) : null, rawKeys: Object.keys(resp.data || {}) });
      return null;
    }
    const imgB64 = inline.inline_data.data;
    ensureDir(outDir);
    const name = `kansuke_${crypto.randomUUID()}.png`;
    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, Buffer.from(imgB64, 'base64'));
    dlog('wrote', { outPath, size: Buffer.from(imgB64, 'base64').length });
    return { filename: name, path: outPath };
  } catch (e) {
    const detail = e?.response?.data || e.message;
    console.warn('Gemini image generation failed:', detail);
    return null;
  }
}

export function buildMascotInstruction({ context, stage }) {
  const t = (context || '').toLowerCase();
  const motifs = [];
  if (/ramen|ラーメン/.test(t)) motifs.push('幹助くんがラーメンを美味しそうに食べている様子');
  if (/寿司|すし|sushi/.test(t)) motifs.push('幹助くんが寿司を楽しそうに食べている様子');
  if (/飲み会|乾杯|beer|ビール/.test(t)) motifs.push('幹助くんが乾杯している様子');
  if (stage === 'finalized') motifs.push('幹助くんが笑顔でGoodのハンドサインをしている');
  if (stage === 'poll_created' && motifs.length === 0) motifs.push('幹助くんが日程調整を案内しているポーズ');
  if (stage === 'closing') motifs.push('幹助くんが確認OKのジェスチャーをしている');
  if (motifs.length === 0) motifs.push('幹助くんが明るくフレンドリーに案内している');
  return `${motifs.join('、')}。ベース画像のキャラクター性を維持して、スタンプ風の一枚絵にしてください。`;
}
