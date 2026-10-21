// Dispatch layer: routes API calls to Gemini or an OpenAI-compatible provider
// (built-in OpenAI or a custom self-hosted endpoint) based on state.provider.

import { state } from './state.js';
import * as gemini from './apiGemini.js';
import * as openai from './apiOpenAI.js';

function api() {
    return state.provider === 'gemini' ? gemini : openai;
}

export function fetchGeminiText(score, customTopic) {
    return api().fetchGeminiText(score, customTopic);
}

export function fetchWordDetails(word) {
    return api().fetchWordDetails(word);
}

export function fetchPhraseDetails(phrase) {
    return api().fetchPhraseDetails(phrase);
}

export function fetchExamQuestions(score) {
    return api().fetchExamQuestions(score);
}

export function fetchExamWrongAnswerExplanations(payload) {
    return api().fetchExamWrongAnswerExplanations(payload);
}

export function fetchGeminiTTS(text, voiceName) {
    return api().fetchGeminiTTS(text, voiceName);
}

export { validateWordWithLanguageTool } from './apiGemini.js';
