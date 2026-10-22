// Google Drive appDataFolder backup/restore.
// Login is always manual and the OAuth access token is kept in memory only:
// a page reload or tab close requires the user to sign in again.

import { DB } from './db.js';
import { t } from './i18n.js';
import { logError, toErrorMessage } from './errorPolicy.js';
import { escapeHtml } from './utils.js';

const MAX_BACKUP_CHARS = 5 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 2000;
const MAX_SAVED_WORDS = 5000;
const MAX_STRING = 50000;
const MAX_SHORT_STRING = 500;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_JSON_DEPTH = 8;

let _callbacks = { renderHistory: null, loadLastSession: null, renderVocabTab: null };

// Credentials and account details live in module scope so they are not exposed
// as enumerable properties of the exported object.
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let userEmail = '';
let userName = '';
let fileId = null;
let pendingLoginResolve = null;
let legacyPurged = false;

function clearSession() {
    accessToken = null;
    tokenExpiresAt = 0;
    userEmail = '';
    userName = '';
    fileId = null;
}

function isLoggedIn() {
    if (!accessToken) return false;
    if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
        clearSession();
        return false;
    }
    return true;
}

async function driveApiFetch(url, opts = {}) {
    if (!isLoggedIn()) {
        const error = new Error('Not authenticated');
        error.code = 'AUTH_REQUIRED';
        throw error;
    }
    opts.headers = { ...opts.headers, Authorization: `Bearer ${accessToken}` };
    const resp = await fetch(url, opts);
    if (resp.status === 401) {
        clearSession();
        DriveSync.updateUI();
        const error = new Error('Token expired');
        error.code = 'AUTH_REQUIRED';
        throw error;
    }
    return resp;
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value, maxLength = MAX_STRING) {
    if (typeof value !== 'string') return '';
    return value.slice(0, maxLength);
}

function sanitizeOptionalString(value, maxLength = MAX_SHORT_STRING) {
    const text = sanitizeString(value, maxLength);
    return text || null;
}

function sanitizeNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function sanitizeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Math.trunc(sanitizeNumber(value, fallback, min, max));
}

function sanitizeId(value) {
    if (typeof value === 'string') return value.slice(0, 200);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return null;
}

/**
 * Keep the JSON structure (needed for article/exam/speaking records) but bound
 * every value so a crafted backup cannot create huge objects or HTML payloads
 * that later reach unsafe rendering paths.
 */
function sanitizeJsonValue(value, depth = 0) {
    if (depth > MAX_JSON_DEPTH) return null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value.slice(0, MAX_STRING);
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeJsonValue(item, depth + 1));
    }
    if (isObject(value)) {
        const result = {};
        Object.keys(value).slice(0, MAX_OBJECT_KEYS).forEach((key) => {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
            result[key] = sanitizeJsonValue(value[key], depth + 1);
        });
        return result;
    }
    return null;
}

function sanitizeHistoryItem(item) {
    if (!isObject(item)) return null;
    const id = sanitizeId(item.id);
    if (id === null) return null;

    const type = ['article', 'exam', 'speaking'].includes(item.type) ? item.type : null;
    if (!type) return null;

    const createdAt = Number.isFinite(Number(item.createdAt))
        ? Number(item.createdAt)
        : (typeof id === 'number' ? id : Date.now());

    const record = {
        id,
        createdAt,
        date: sanitizeString(item.date, 100),
        type,
        title: sanitizeString(item.title, MAX_SHORT_STRING),
        score: sanitizeNumber(item.score, 0, 0, 990),
        voice: sanitizeOptionalString(item.voice, 100),
        topic: sanitizeOptionalString(item.topic),
        recordStage: sanitizeOptionalString(item.recordStage, 100),
        attemptId: sanitizeOptionalString(item.attemptId, 100),
        examSummary: item.examSummary != null ? sanitizeJsonValue(item.examSummary) : null,
        examSnapshot: item.examSnapshot != null ? sanitizeJsonValue(item.examSnapshot) : null,
        explanations: Array.isArray(item.explanations)
            ? item.explanations.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeJsonValue(entry))
            : null,
        data: item.data != null ? sanitizeJsonValue(item.data) : null,
        logs: Array.isArray(item.logs)
            ? item.logs.slice(0, MAX_ARRAY_ITEMS).map((entry) => ({
                ts: sanitizeInteger(entry?.ts, 0, 0),
                role: sanitizeOptionalString(entry?.role, 50) || '',
                text: sanitizeString(entry?.text, MAX_STRING)
            }))
            : null,
        speakingLevel: sanitizeOptionalString(item.speakingLevel, 50),
        speakingAccent: sanitizeOptionalString(item.speakingAccent, 50),
        resolvedAccentId: sanitizeOptionalString(item.resolvedAccentId, 50),
        liveVoiceName: sanitizeOptionalString(item.liveVoiceName, 100),
        startedAt: sanitizeInteger(item.startedAt, 0, 0),
        endedAt: sanitizeInteger(item.endedAt, 0, 0),
        durationMs: sanitizeInteger(item.durationMs, 0, 0),
        finalStatus: sanitizeOptionalString(item.finalStatus, MAX_SHORT_STRING),
        // Audio is intentionally never restored from the cloud backup.
        audio: null
    };

    if (record.examSnapshot && isObject(record.examSnapshot)) {
        // Cached TTS audio is regenerable and can be very large.
        record.examSnapshot.listeningAudioByQuestion = {};
    }

    return record;
}

function sanitizeSavedWord(item) {
    if (!isObject(item)) return null;
    const id = sanitizeId(item.id);
    if (id === null || String(id).trim() === '') return null;
    const en = sanitizeString(item.en, 200);
    if (!en) return null;

    return {
        id: String(id),
        en,
        zh: sanitizeString(item.zh, 2000),
        pos: sanitizeString(item.pos, 50),
        ipa: sanitizeString(item.ipa, 200),
        ex: sanitizeString(item.ex, 5000),
        ex_zh: sanitizeString(item.ex_zh, 5000),
        createdAt: sanitizeInteger(item.createdAt, Date.now(), 0),
        nextReview: sanitizeInteger(item.nextReview, Date.now(), 0),
        level: sanitizeInteger(item.level, 0, 0, 5)
    };
}

function sanitizeBackupPayload(raw) {
    if (!isObject(raw)) throw new Error(t('driveRestoreInvalidPayload'));

    const version = sanitizeNumber(raw.version, 1, 1, 100);
    const exportedAt = sanitizeNumber(raw.exportedAt, Date.now(), 0);

    const history = Array.isArray(raw.history)
        ? raw.history.slice(0, MAX_HISTORY_ITEMS).map(sanitizeHistoryItem).filter(Boolean)
        : [];
    const savedWords = Array.isArray(raw.savedWords)
        ? raw.savedWords.slice(0, MAX_SAVED_WORDS).map(sanitizeSavedWord).filter(Boolean)
        : [];

    if (!history.length && !savedWords.length) {
        throw new Error(t('driveRestoreInvalidPayload'));
    }

    return { version, exportedAt, history, savedWords };
}

export const DriveSync = {
    CLIENT_ID: '577652285741-f97oivf3f7h2u9b02hhq9man1f807v16.apps.googleusercontent.com',
    SCOPES: 'https://www.googleapis.com/auth/drive.appdata',
    BACKUP_FILENAME: 'toeic-tutor-backup.json',

    setCallbacks(cbs) {
        _callbacks = { ..._callbacks, ...cbs };
    },

    init() {
        this._purgeLegacyTokenSettings();
        if (typeof google === 'undefined' || !google.accounts) return;
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: this.CLIENT_ID,
            scope: this.SCOPES,
            callback: (resp) => {
                if (resp.error) {
                    logError('GIS auth error', resp);
                    if (pendingLoginResolve) pendingLoginResolve(false);
                    pendingLoginResolve = null;
                    return;
                }
                // Memory only: never persist the OAuth access token.
                accessToken = resp.access_token;
                tokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
                this._fetchUserInfo().finally(() => this.updateUI());
                if (pendingLoginResolve) pendingLoginResolve(true);
                pendingLoginResolve = null;
            },
        });
    },

    /** Remove credentials left behind by older versions that cached them in IndexedDB. */
    async _purgeLegacyTokenSettings() {
        if (legacyPurged) return;
        try {
            await Promise.all([
                DB.setSetting('gis_access_token', null),
                DB.setSetting('gis_token_expires_at', null),
                DB.setSetting('cloud_sync_enabled', null),
                DB.setSetting('cloud_user_email', null),
                DB.setSetting('cloud_user_name', null)
            ]);
            legacyPurged = true;
        } catch (e) {
            logError('Legacy Drive token purge failed', e);
        }
    },

    async login() {
        if (!tokenClient) {
            this.init();
            if (!tokenClient) { alert(t('driveGisNotLoaded')); return false; }
        }
        const ok = await new Promise((resolve) => {
            pendingLoginResolve = resolve;
            // No background/silent login: this only runs after an explicit click.
            tokenClient.requestAccessToken({ prompt: '' });
        });
        return ok;
    },

    async logout() {
        const token = accessToken;
        clearSession();
        if (token && typeof google !== 'undefined' && google.accounts?.oauth2?.revoke) {
            try {
                google.accounts.oauth2.revoke(token);
            } catch (e) {
                logError('GIS revoke failed', e);
            }
        }
        await this._purgeLegacyTokenSettings();
        this.updateUI();
    },

    async _fetchUserInfo() {
        if (!accessToken) return;
        try {
            // drive.appdata is enough for about.get's user fields, so we do not
            // need the separate userinfo.profile / userinfo.email scopes.
            const resp = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!resp.ok) throw new Error(`about HTTP ${resp.status}`);
            const info = await resp.json();
            userEmail = sanitizeString(info?.user?.emailAddress, 320);
            userName = sanitizeString(info?.user?.displayName, 200) || userEmail;
        } catch (e) {
            logError('Failed to fetch user info', e);
        }
    },

    async exportData() {
        const [history, savedWords] = await Promise.all([
            DB.getHistory(),
            DB.getSavedWords(),
        ]);
        const lightHistory = history.map((item) => {
            const copy = { ...item, audio: null };
            if (copy.examSnapshot && typeof copy.examSnapshot === 'object') {
                copy.examSnapshot = { ...copy.examSnapshot, listeningAudioByQuestion: {} };
            }
            return copy;
        });
        return JSON.stringify({
            version: 1,
            exportedAt: Date.now(),
            history: lightHistory,
            savedWords,
        });
    },

    async importData(jsonStr) {
        if (typeof jsonStr === 'string' && jsonStr.length > MAX_BACKUP_CHARS) {
            throw new Error(t('driveRestoreInvalidPayload'));
        }
        const parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        const data = sanitizeBackupPayload(parsed);
        // Validate everything first, then replace both stores in one transaction.
        await DB.replaceAll(data.history, data.savedWords);
    },

    async findBackupFile() {
        if (fileId) return fileId;
        const resp = await driveApiFetch(
            `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D'${this.BACKUP_FILENAME}'&fields=files(id,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=1`
        );
        if (!resp.ok) throw new Error(`Drive list failed (${resp.status})`);
        const data = await resp.json();
        if (data.files && data.files.length > 0) {
            fileId = data.files[0].id;
            return fileId;
        }
        return null;
    },

    async upload(jsonStr) {
        const fileId = await this.findBackupFile();
        const metadata = { name: this.BACKUP_FILENAME, mimeType: 'application/json' };
        if (!fileId) metadata.parents = ['appDataFolder'];

        const boundary = `-------DriveBackupBoundary${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
        const body =
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonStr}\r\n` +
            `--${boundary}--`;

        const url = fileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

        const resp = await driveApiFetch(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body,
        });
        if (!resp.ok) throw new Error(`Drive upload failed (${resp.status})`);
        const result = await resp.json();
        if (result.id) fileId = result.id;

        const now = new Date().toLocaleString();
        await DB.setSetting('cloud_last_sync', now);
        this.updateUI();
    },

    async download() {
        const fileId = await this.findBackupFile();
        if (!fileId) return null;
        const resp = await driveApiFetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
        );
        if (!resp.ok) throw new Error(`Drive download failed (${resp.status})`);
        const text = await resp.text();
        if (text.length > MAX_BACKUP_CHARS) {
            throw new Error(t('driveRestoreInvalidPayload'));
        }
        return JSON.parse(text);
    },

    _handleDriveError(error, fallbackKey) {
        if (error?.code === 'AUTH_REQUIRED') {
            alert(t('driveLoginRequired'));
            return;
        }
        alert(t(fallbackKey, { message: toErrorMessage(error) }));
    },

    async backupNow() {
        if (!isLoggedIn()) { alert(t('driveLoginRequired')); return; }
        const btn = document.getElementById('btnBackupNow');
        if (btn) { btn.disabled = true; btn.textContent = t('driveBackupInProgress'); }
        try {
            const json = await this.exportData();
            await this.upload(json);
            if (btn) {
                btn.textContent = t('driveBackupDone');
                setTimeout(() => { btn.textContent = t('cloudBackupNowBtn'); btn.disabled = false; }, 2000);
            }
        } catch (e) {
            this._handleDriveError(e, 'driveBackupFailed');
            if (btn) { btn.textContent = t('cloudBackupNowBtn'); btn.disabled = false; }
        }
    },

    async restore() {
        if (!isLoggedIn()) { alert(t('driveLoginRequired')); return; }
        const btn = document.getElementById('btnRestore');
        if (btn) { btn.disabled = true; btn.textContent = t('driveRestoreChecking'); }
        try {
            const data = await this.download();
            if (!data) {
                alert(t('driveRestoreNotFound'));
                if (btn) { btn.textContent = t('cloudRestoreBtn'); btn.disabled = false; }
                return;
            }
            const sanitized = sanitizeBackupPayload(data);
            const date = sanitized.exportedAt ? new Date(sanitized.exportedAt).toLocaleString() : t('driveUnknownDate');
            this._showRestorePrompt(sanitized, date, btn);
        } catch (e) {
            this._handleDriveError(e, 'driveRestoreFailed');
            if (btn) { btn.textContent = t('cloudRestoreBtn'); btn.disabled = false; }
        }
    },

    _showRestorePrompt(data, dateStr, triggerBtn) {
        const overlay = document.createElement('div');
        overlay.className = 'restore-overlay';
        overlay.innerHTML = `<div class="restore-card">
            <h3>${t('driveRestoreDetectedTitle')}</h3>
            <p>${t('driveRestoreDetectedSummary', { date: escapeHtml(dateStr), historyCount: (data.history || []).length, vocabCount: (data.savedWords || []).length })}</p>
            <div class="restore-btns">
                <button class="btn-cancel">${t('driveCancelBtn')}</button>
                <button class="btn-restore">${t('driveRestoreBtn')}</button>
            </div>
        </div>`;
        overlay.querySelector('.btn-cancel').onclick = () => {
            overlay.remove();
            if (triggerBtn) { triggerBtn.textContent = t('cloudRestoreBtn'); triggerBtn.disabled = false; }
        };
        overlay.querySelector('.btn-restore').onclick = async () => {
            overlay.querySelector('.btn-restore').textContent = t('driveRestoring');
            overlay.querySelector('.btn-restore').disabled = true;
            try {
                await this.importData(data);
                overlay.remove();
                if (_callbacks.renderHistory) _callbacks.renderHistory();
                if (_callbacks.loadLastSession) await _callbacks.loadLastSession();
                if (_callbacks.renderVocabTab) _callbacks.renderVocabTab();
                if (triggerBtn) { triggerBtn.textContent = t('cloudRestoreBtn'); triggerBtn.disabled = false; }
                alert(t('driveRestoreSuccess'));
            } catch (e) {
                alert(t('driveRestoreFailed', { message: toErrorMessage(e) }));
                overlay.remove();
                if (triggerBtn) { triggerBtn.textContent = t('cloudRestoreBtn'); triggerBtn.disabled = false; }
            }
        };
        document.body.appendChild(overlay);
    },

    async updateUI() {
        const loggedIn = isLoggedIn();
        const authArea = document.getElementById('cloudAuthArea');
        const userArea = document.getElementById('cloudUserArea');
        if (!authArea || !userArea) return;

        if (loggedIn) {
            authArea.classList.add('hidden');
            userArea.classList.remove('hidden');
            const name = userName || userEmail || 'Google';
            const nameEl = document.getElementById('cloudUserName');
            const emailEl = document.getElementById('cloudUserEmail');
            const avatarEl = document.getElementById('cloudAvatar');
            const lastSyncEl = document.getElementById('cloudLastSync');
            if (nameEl) nameEl.textContent = name;
            if (emailEl) emailEl.textContent = userEmail;
            if (avatarEl) avatarEl.textContent = name[0].toUpperCase();
            const lastSync = await DB.getSetting('cloud_last_sync');
            if (lastSyncEl) {
                lastSyncEl.textContent = lastSync
                    ? t('driveLastSync', { value: lastSync })
                    : t('driveNotSynced');
            }
        } else {
            authArea.classList.remove('hidden');
            userArea.classList.add('hidden');
            const nameEl = document.getElementById('cloudUserName');
            const emailEl = document.getElementById('cloudUserEmail');
            if (nameEl) nameEl.textContent = '';
            if (emailEl) emailEl.textContent = '';
        }
    },
};
