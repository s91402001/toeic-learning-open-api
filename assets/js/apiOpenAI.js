// OpenAI-compatible API calls: text generation, TTS, exam generation, and explanations.
// Mirrors the interface of apiGemini.js so apiProvider.js can dispatch transparently.
// The same implementation serves the built-in OpenAI provider and the custom
// (self-hosted, OpenAI-compatible) provider.

import { state, OPENAI_TEXT_MODEL, OPENAI_TTS_MODEL, OPENAI_VOICE_NAMES } from './state.js';
import { DB } from './db.js';
import { getLocaleMeta } from './i18n.js';
import { normalizeExamOutput } from './examNormalize.js';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const JSON_MODE_RETRY_STATUSES = [400, 404, 415, 422];

function isCustomProvider() {
    return state.provider === 'custom';
}

/**
 * Accepts a variety of user inputs and returns a canonical base URL without a
 * trailing slash, e.g.:
 *   localhost:11434                  -> http://localhost:11434/v1
 *   http://localhost:11434/v1/       -> http://localhost:11434/v1
 *   http://host/v1/chat/completions  -> http://host/v1
 *   http://host/v1/audio/speech      -> http://host/v1
 * Returns '' when the input cannot be parsed.
 */
export function normalizeApiBaseUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) return '';
    url = url.split(/[?#]/)[0].trim();
    if (!url) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        url = `http://${url}`;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/i, '');
    url = url.replace(/\/audio\/speech$/i, '');
    url = url.replace(/\/models$/i, '');
    url = url.replace(/\/+$/, '');
    if (!/\/v\d+(?:beta|alpha)?$/i.test(url)) {
        url = `${url}/v1`;
    }
    return url;
}

function authHeaders(apiKey) {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function getTextConfig() {
    if (isCustomProvider()) {
        return {
            baseUrl: normalizeApiBaseUrl(state.customApiBaseUrl),
            apiKey: state.customApiKey,
            model: getTextModel(),
            isCustom: true
        };
    }
    return {
        baseUrl: OPENAI_DEFAULT_BASE_URL,
        apiKey: state.openaiApiKey,
        model: getTextModel(),
        isCustom: false
    };
}

function getTextModel() {
    const m = state.selectedModel;
    return (m && m !== '__custom__') ? m : (isCustomProvider() ? '' : OPENAI_TEXT_MODEL);
}

function getTtsConfig() {
    if (isCustomProvider()) {
        return {
            baseUrl: normalizeApiBaseUrl(state.customTtsBaseUrl),
            apiKey: state.customTtsApiKey,
            model: state.customTtsModel || OPENAI_TTS_MODEL
        };
    }
    return {
        baseUrl: OPENAI_DEFAULT_BASE_URL,
        apiKey: state.openaiApiKey,
        model: OPENAI_TTS_MODEL
    };
}

function extractJsonObject(text) {
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1));
        }
        throw new Error('模型回傳內容不是有效 JSON');
    }
}

function readMessageContent(data) {
    const content = data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.message?.content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    return typeof content === 'string' ? content : '';
}

async function fetchJsonFromPrompt(prompt) {
    const cfg = getTextConfig();
    if (!cfg.baseUrl) throw new Error('請先設定自訂 API Endpoint');
    if (!cfg.model) throw new Error('請先選擇或輸入模型');

    const baseBody = {
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }]
    };
    const url = `${cfg.baseUrl}/chat/completions`;
    const attempts = cfg.isCustom ? [true, false] : [true];
    let lastError = null;

    for (const useJsonMode of attempts) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(cfg.apiKey)
            },
            body: JSON.stringify(useJsonMode
                ? { ...baseBody, response_format: { type: 'json_object' } }
                : baseBody)
        });

        const rawText = await response.text();
        let data = null;
        try { data = rawText ? JSON.parse(rawText) : null; } catch { /* non-JSON error body */ }

        if (!response.ok || data?.error) {
            const message = data?.error?.message
                || (rawText ? rawText.slice(0, 300) : '')
                || `API error (${response.status})`;
            lastError = new Error(`${message} [${url}]`);
            if (cfg.isCustom && useJsonMode && JSON_MODE_RETRY_STATUSES.includes(response.status)) {
                continue;
            }
            throw lastError;
        }

        const text = readMessageContent(data);
        if (!text) throw new Error('模型回傳內容為空');
        return extractJsonObject(text);
    }

    throw lastError || new Error('API 請求失敗');
}

/** Fetch the model list from any OpenAI-compatible endpoint. */
export async function fetchModelsFromEndpoint({ baseUrl, apiKey } = {}) {
    const base = normalizeApiBaseUrl(baseUrl);
    if (!base) throw new Error('請輸入有效的 API Endpoint');
    const url = `${base}/models`;
    const response = await fetch(url, { headers: { ...authHeaders(apiKey) } });
    const rawText = await response.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    if (!response.ok || data?.error) {
        const message = data?.error?.message || (rawText ? rawText.slice(0, 200) : '') || `HTTP ${response.status}`;
        throw new Error(`${message} [${url}]`);
    }
    const rows = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
            ? data.models
            : Array.isArray(data)
                ? data
                : [];
    const ids = rows
        .map((row) => (typeof row === 'string' ? row : row?.id || row?.name || row?.model))
        .filter(Boolean)
        .map(String);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Send a tiny chat request to verify endpoint, key and model. */
export async function testCustomEndpoint({ baseUrl, apiKey, model } = {}) {
    const base = normalizeApiBaseUrl(baseUrl);
    if (!base) throw new Error('請輸入有效的 API Endpoint');
    if (!model) throw new Error('請先選擇或輸入模型');
    const url = `${base}/chat/completions`;
    const send = (withMaxTokens) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
            ...(withMaxTokens ? { max_tokens: 8 } : {})
        })
    });

    let response = await send(true);
    if (!response.ok && [400, 422].includes(response.status)) {
        await response.text();
        response = await send(false);
    }
    const rawText = await response.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch { /* ignore */ }
    if (!response.ok || data?.error) {
        const message = data?.error?.message || (rawText ? rawText.slice(0, 200) : '') || `HTTP ${response.status}`;
        throw new Error(`${message} [${url}]`);
    }
    return true;
}

/** Verify that an external OpenAI-compatible TTS endpoint returns audio. */
export async function testCustomTtsEndpoint({ baseUrl, apiKey, model } = {}) {
    const base = normalizeApiBaseUrl(baseUrl);
    if (!base) throw new Error('請輸入有效的 TTS Endpoint');
    const url = `${base}/audio/speech`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
        body: JSON.stringify({
            model: model || OPENAI_TTS_MODEL,
            input: 'Hello, this is a test.',
            voice: 'alloy',
            response_format: 'mp3'
        })
    });
    if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        let message = rawText.slice(0, 200);
        try {
            const data = JSON.parse(rawText);
            message = data?.error?.message || message;
        } catch { /* ignore */ }
        throw new Error(`${message || `HTTP ${response.status}`} [${url}]`);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error('TTS 回傳空白音訊');
    return true;
}

export async function fetchGeminiText(score, customTopic) {
    const locale = getLocaleMeta();
    const targetLang = `${locale.name} (${locale.inLocal})`;
    const topicLine = customTopic
        ? `about "${customTopic}" suitable for this level.`
        : `about one random TOEIC-friendly scenario from this range: office communication, meetings, email updates, travel arrangements, customer service, logistics and shipping, human resources, marketing campaigns, product launches, scheduling conflicts, workplace problem-solving, announcements, and professional daily-life errands.`;
    const prompt = `
        You are a strict TOEIC tutor. Target Score: ${score}.
        Task: Generate a SHORT reading comprehension passage (approx 60-80 words, 30 seconds reading time) ${topicLine}
        Output JSON strictly:
        {
            "segments": [{"en": "Sentence 1 English", "zh": "Sentence 1 ${targetLang} translation"}],
            "vocabulary": [{"word": "word", "pos": "v.", "ipa": "/ipa/", "def": "${targetLang} definition", "ex": "English example sentence ONLY (No translation, No special symbols)", "ex_zh": "${targetLang} translation of the example sentence"}],
            "phrases": [{"phrase": "phrase from passage", "meaning": "${targetLang} meaning", "explanation": "Brief ${targetLang} explanation", "example": "English example sentence", "example_zh": "${targetLang} translation of the example sentence"}]
        }
        For "phrases": pick 2-3 commonly used phrases from the passage. Return ONLY raw JSON.
    `;
    return fetchJsonFromPrompt(prompt);
}

function lexicalCacheKey(query) {
    return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function fetchWordDetails(word) {
    const key = lexicalCacheKey(word);
    const cached = await DB.getWord(key);
    if (cached) return cached;
    const locale = getLocaleMeta();
    const targetLang = `${locale.name} (${locale.inLocal})`;
    const q = JSON.stringify(key);
    const prompt = `Explain the English word ${q} for a TOEIC student. Keep it concise like a vocabulary card. Output JSON strictly with this shape: {"word":string (the headword, lowercase),"pos":"part of speech (e.g. n./v./adj./vi./vt.)","ipa":"IPA or empty string if unclear","def":"Brief ${targetLang} definition (one short phrase)","ex":"One simple short English example sentence.","ex_zh":"${targetLang} translation of the example sentence","verb_forms":null OR {"base":string,"past":string,"past_participle":string} — use verb_forms only when pos is a verb (v./vi./vt.); otherwise verb_forms must be null.}`;
    const result = await fetchJsonFromPrompt(prompt);
    await DB.setWord(key, result);
    return result;
}

export async function fetchPhraseDetails(phrase) {
    const key = lexicalCacheKey(phrase);
    const cached = await DB.getWord(key);
    if (cached) return cached;
    const locale = getLocaleMeta();
    const targetLang = `${locale.name} (${locale.inLocal})`;
    const q = JSON.stringify(key);
    const prompt = `Explain the English phrase or collocation ${q} for a TOEIC student. Keep it concise like a vocabulary card. Output JSON strictly: {"word":string (the phrase, natural casing ok but match input meaning),"pos":"phr.","ipa":"","def":"Brief ${targetLang} meaning (one short phrase)","ex":"One simple short English example sentence using the phrase.","ex_zh":"${targetLang} translation of the example sentence"}`;
    const result = await fetchJsonFromPrompt(prompt);
    await DB.setWord(key, result);
    return result;
}

export async function fetchExamQuestions(score) {
    const locale = getLocaleMeta();
    const targetLang = `${locale.name} (${locale.inLocal})`;
    const prompt = `
        You are a TOEIC mock exam generator.
        Target score: ${score}.
        Output STRICT JSON only with this shape:
        {
          "listening": [{"id":"L1","question":"...","audioText":"text to speak","options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],"answerKey":"A","explanationSeed":"..."}],
          "reading": [{"id":"R1","passage":"...","question":"...","options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],"answerKey":"A","explanationSeed":"..."}],
          "vocabulary": [{"id":"V1","question":"...","options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],"answerKey":"A","explanationSeed":"..."}],
          "grammar": [{"id":"G1","question":"...","options":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],"answerKey":"A","explanationSeed":"..."}]
        }
        Rules:
        - listening must have exactly 3 questions.
        - reading must have exactly 3 items.
        - Each reading item must include its own complete "passage" and one related question.
        - Do not reuse the same reading passage for all 3 items.
        - vocabulary must have exactly 3 questions.
        - grammar must have exactly 3 questions.
        - Questions should match target score difficulty.
        - options must contain meaningful English option text, not only letters.
        - answerKey must be exactly one option key from options.
        - Use ${targetLang} for explanations if needed, but question can be English.
        - Return raw JSON only.
    `;
    const raw = await fetchJsonFromPrompt(prompt);
    return normalizeExamOutput(raw);
}

export async function fetchExamWrongAnswerExplanations(payload) {
    const locale = getLocaleMeta();
    const targetLang = `${locale.name} (${locale.inLocal})`;
    const prompt = `
        You are a TOEIC teacher. Explain each wrong answer one by one.
        Output STRICT JSON:
        {
          "items":[
            {
              "id":"question id",
              "whyWrong":"Why the selected answer is wrong (${targetLang})",
              "keyPoint":"Key point for the correct answer (${targetLang})",
              "trap":"Common trap (${targetLang})"
            }
          ]
        }
        Wrong-answer payload:
        ${JSON.stringify(payload)}
    `;
    const result = await fetchJsonFromPrompt(prompt);
    return Array.isArray(result?.items) ? result.items : [];
}

const GEMINI_TO_OPENAI_VOICE = {
    kore: 'nova',
    aoede: 'shimmer',
    puck: 'echo',
    charon: 'onyx',
    fenrir: 'fable'
};

function pickRandomOpenAIVoice() {
    return OPENAI_VOICE_NAMES[Math.floor(Math.random() * OPENAI_VOICE_NAMES.length)];
}

function normalizeOpenAIVoice(voiceName) {
    const name = String(voiceName || '').toLowerCase();
    if (name === 'random' || !name) return pickRandomOpenAIVoice();
    if (OPENAI_VOICE_NAMES.includes(name)) return name;
    return GEMINI_TO_OPENAI_VOICE[name] || 'alloy';
}

export async function fetchGeminiTTS(text, voiceName) {
    const cfg = getTtsConfig();
    if (!cfg.baseUrl) throw new Error('請先設定外接 TTS Endpoint');
    const voice = normalizeOpenAIVoice(voiceName);
    const response = await fetch(`${cfg.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(cfg.apiKey)
        },
        body: JSON.stringify({
            model: cfg.model,
            input: text,
            voice,
            response_format: 'mp3'
        })
    });
    if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        let message = rawText.slice(0, 200);
        try {
            const data = JSON.parse(rawText);
            message = data?.error?.message || message;
        } catch { /* ignore */ }
        const error = new Error(message || `TTS error (${response.status})`);
        error.code = response.status;
        throw error;
    }
    const arrayBuffer = await response.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    return 'mp3:' + btoa(binary);
}
