// Browser speech synthesis playback (Web Speech API).
// Used when the custom provider selects the "browser voice" TTS mode.
// Speaks the article sentence by sentence so the existing sentence highlight
// and per-sentence replay controls keep working without server audio.

import { state } from './state.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

let queue = [];
let queuePos = 0;
let playing = false;
let paused = false;
let cancelled = false;

export function isSpeechSynthesisSupported() {
    return !!(synth && typeof window.SpeechSynthesisUtterance === 'function');
}

export function isBrowserTtsMode() {
    return state.provider === 'custom' && state.customTtsMode === 'browser';
}

export function isTtsDisabled() {
    return state.provider === 'custom' && state.customTtsMode === 'off';
}

export function getBrowserVoices() {
    if (!synth || typeof synth.getVoices !== 'function') return [];
    return synth.getVoices().filter((voice) => /^en(-|$)/i.test(String(voice.lang || '')));
}

export function resolveBrowserVoice() {
    const voices = getBrowserVoices();
    if (!voices.length) return null;
    return voices.find((voice) => voice.voiceURI === state.browserVoiceURI)
        || voices.find((voice) => voice.default)
        || voices.find((voice) => /^en-US/i.test(String(voice.lang || '')))
        || voices[0];
}

function emitState() {
    document.dispatchEvent(new CustomEvent('browser-tts-state', {
        detail: { playing, paused, supported: isSpeechSynthesisSupported() }
    }));
}

function emitProgress(pct) {
    document.dispatchEvent(new CustomEvent('browser-tts-progress', {
        detail: { pct: Math.max(0, Math.min(1, pct)) }
    }));
}

function clearActiveSegment() {
    if (state.activeSegmentIndex >= 0 && state.segmentMetadata[state.activeSegmentIndex]) {
        state.segmentMetadata[state.activeSegmentIndex].element.classList.remove('active');
    }
    state.activeSegmentIndex = -1;
}

function setActiveSegment(index) {
    if (state.activeSegmentIndex >= 0 && state.segmentMetadata[state.activeSegmentIndex]) {
        state.segmentMetadata[state.activeSegmentIndex].element.classList.remove('active');
    }
    const item = state.segmentMetadata[index];
    if (item) item.element.classList.add('active');
    state.activeSegmentIndex = Number.isInteger(index) ? index : -1;
}

function makeUtterance(text) {
    const utterance = new SpeechSynthesisUtterance(String(text || ''));
    utterance.lang = 'en-US';
    const rate = Number(state.playbackSpeed) || 1;
    utterance.rate = Math.min(2, Math.max(0.1, rate));
    const voice = resolveBrowserVoice();
    if (voice) utterance.voice = voice;
    return utterance;
}

function resetPlaybackState() {
    cancelled = true;
    queue = [];
    queuePos = 0;
    playing = false;
    paused = false;
    if (synth && typeof synth.cancel === 'function') synth.cancel();
    clearActiveSegment();
}

export function stopBrowserSpeech() {
    resetPlaybackState();
    emitState();
    emitProgress(0);
}

function finishPlayback() {
    playing = false;
    paused = false;
    queue = [];
    queuePos = 0;
    clearActiveSegment();
    emitState();
    emitProgress(0);
}

function speakNext() {
    if (cancelled) return;
    if (queuePos >= queue.length) {
        finishPlayback();
        return;
    }
    const item = queue[queuePos];
    setActiveSegment(item.index);
    emitProgress(queue.length ? queuePos / queue.length : 0);

    const utterance = makeUtterance(item.text);
    utterance.onend = () => {
        if (cancelled) return;
        queuePos += 1;
        speakNext();
    };
    utterance.onerror = (event) => {
        if (cancelled) return;
        const reason = event?.error;
        if (reason === 'interrupted' || reason === 'canceled') {
            // Someone else (e.g. word pronunciation) cancelled speech; reset UI.
            finishPlayback();
            return;
        }
        queuePos += 1;
        speakNext();
    };

    try {
        synth.speak(utterance);
    } catch {
        finishPlayback();
    }
}

export function getArticleSegments() {
    if (Array.isArray(state.currentData?.segments) && state.currentData.segments.length) {
        return state.currentData.segments;
    }
    if (state.currentData) {
        return [{ en: state.currentData.article || '', zh: state.currentData.translation || '' }];
    }
    return [];
}

export function startArticleSpeech(startIndex = 0, endIndex = Infinity) {
    if (!isSpeechSynthesisSupported()) return false;
    const segments = getArticleSegments();
    const from = Math.max(0, Number(startIndex) || 0);
    const to = Number.isFinite(endIndex) ? Math.max(from, Number(endIndex)) : Infinity;
    const nextQueue = segments
        .map((segment, index) => ({ text: String(segment?.en || '').trim(), index }))
        .filter((item) => item.text && item.index >= from && item.index <= to);
    if (!nextQueue.length) return false;

    resetPlaybackState();
    queue = nextQueue;
    cancelled = false;
    playing = true;
    paused = false;
    queuePos = 0;
    emitState();
    // Let cancel() settle before queueing the first utterance (Chrome quirk).
    setTimeout(speakNext, 0);
    return true;
}

export function speakArticleSegment(index) {
    return startArticleSpeech(index, index);
}

export function toggleArticleSpeech() {
    if (!isSpeechSynthesisSupported()) return 'unsupported';
    if (paused) {
        synth.resume();
        paused = false;
        emitState();
        return 'resumed';
    }
    if (playing) {
        synth.pause();
        paused = true;
        emitState();
        return 'paused';
    }
    return startArticleSpeech(0) ? 'started' : 'empty';
}

/** Speak one short text (used by exam listening questions). */
export function speakBrowserText(text) {
    return new Promise((resolve) => {
        if (!isSpeechSynthesisSupported()) {
            resolve(false);
            return;
        }
        resetPlaybackState();
        cancelled = false;
        const utterance = makeUtterance(text);
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve(true);
        };
        utterance.onend = done;
        utterance.onerror = done;
        try {
            synth.speak(utterance);
        } catch {
            resolve(false);
        }
    });
}
