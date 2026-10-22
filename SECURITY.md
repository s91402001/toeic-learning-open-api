# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the maintainer at
`brucefay1115@gmail.com` with:

- a short description and impact,
- steps to reproduce (or a proof-of-concept),
- the browser/OS and app version shown in the About tab.

You will receive an acknowledgement as soon as possible. Please allow time for a
fix before public disclosure.

## Threat model

This is a static, zero-backend PWA. Users bring their own Gemini/OpenAI API key
("BYOK") and may optionally connect Google Drive for backup.

The most important asset is the set of credentials stored in the browser:

- `gemini_api_key`, `openai_api_key`, `custom_api_key`, `custom_tts_api_key`
  in IndexedDB,
- the Google Drive OAuth access token (memory only),
- the user's learning history and vocabulary book.

Because the app is static, **any JavaScript that executes on the app's origin can
read those credentials**. The primary security goal is therefore to prevent
untrusted data (AI output, restored backups, `version.json`) from becoming
executable JavaScript, and to keep the number of third-party scripts on the
origin at zero.

## Implemented controls

- Strict `Content-Security-Policy` in `index.html`: no inline scripts, no inline
  event handlers; script sources limited to the app, Google Identity Services,
  and the pinned `@google/genai` CDN.
- No Google Analytics, GTM, or other third-party tracking scripts.
- All AI/backup-derived values are escaped before being inserted into HTML;
  untrusted text is rendered with `textContent` / DOM APIs where possible.
- Google Drive login is manual on every page load. The OAuth access token is
  kept in memory only and is never written to IndexedDB/localStorage.
  Only the `drive.appdata` scope is requested.
- Legacy cached Drive tokens from older versions are deleted on startup.
- Gemini API keys are sent in the `x-goog-api-key` header, not in URLs.
- Drive restore validates and bounds the backup schema first, then replaces both
  object stores in a single IndexedDB transaction.
- Backup payloads never include API keys, TTS audio, or the Drive access token.
- API key inputs disable autocomplete/spellcheck.
- Custom OpenAI-compatible endpoints show a warning and require confirmation
  before sending a key over non-HTTPS, non-local connections.

## Known residual risks

- **Client-side BYOK cannot be made fully secret.** A compromised browser
  extension, malicious same-origin script, or physical access to the browser
  profile can read stored keys. Use dedicated keys with API restrictions,
  quotas, and spending limits, and revoke them if compromised.
- API keys are stored in IndexedDB in plaintext. This is documented in the UI,
  README, and privacy policy.
- The `@google/genai` SDK is loaded from jsDelivr (`esm.run`) at a pinned
  version. Self-hosting the bundle removes this CDN dependency entirely.
- Because users may point the app at any self-hosted endpoint, `connect-src`
  must allow `https:` and `http:`. The main protection against exfiltration is
  therefore the strict `script-src` (no inline scripts) plus output escaping.
- Custom OpenAI-compatible endpoints may be HTTP and may be controlled by a
  third party; the app warns, but cannot verify their trustworthiness.
- GitHub Pages cannot send custom HTTP response headers. The meta CSP does not
  cover `frame-ancestors`; deploy behind a host that supports headers if
  clickjacking protection is required.

## Deployment checklist

- [ ] Use your own GCP OAuth Client ID and restrict Authorized JavaScript
      origins to the exact production origin.
- [ ] Add the `drive.appdata` scope to the OAuth consent screen; do not request
      `userinfo.profile` / `userinfo.email` unless you actually need them.
- [ ] Restrict the Gemini API key to the Generative Language API and set quotas.
- [ ] Set spending limits on OpenAI keys.
- [ ] Serve the app over HTTPS.
- [ ] Bump `CACHE_NAME` in `sw.js` whenever static assets change.
- [ ] Run `gitleaks detect` before publishing.
- [ ] Re-test XSS payloads in saved words, exam results, history, and restored
      backups after changing rendering code.
