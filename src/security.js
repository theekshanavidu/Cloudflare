/**
 * StudyTracker Pro - Security & Input Sanitization Engine
 * Comprehensive protection against Cross-Site Scripting (XSS), Script Injections,
 * Malicious URL Redirections, and HTML Template Injections.
 */

/**
 * Sanitize a string input by stripping dangerous tags, inline event handlers,
 * malicious protocols, and escaping HTML metacharacters.
 * @param {any} input 
 * @returns {string} Clean, safe string
 */
export function sanitizeInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') {
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    input = String(input);
  }

  // Remove null bytes and invisible control characters
  let clean = input.replace(/\0/g, '');

  // 1. Remove dangerous executable tag blocks completely (<script>...</script>, <iframe>...</iframe>, etc.)
  clean = clean.replace(/<\s*(script|iframe|object|embed|style|meta|link|base|applet|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  
  // 2. Remove unclosed / self-closing dangerous tags (<script...>, <iframe...>, etc.)
  clean = clean.replace(/<\s*(script|iframe|object|embed|style|meta|link|base|applet|form)[^>]*\/?>/gi, '');

  // 3. Remove inline JavaScript event handlers (e.g., onload=..., onerror=..., onclick=..., onfocus=...)
  clean = clean.replace(/\bon[a-z]{3,20}\s*=\s*(['"]).*?\1/gi, '');
  clean = clean.replace(/\bon[a-z]{3,20}\s*=\s*[^>\s]+/gi, '');

  // 4. Neutralize dangerous pseudo-protocols
  clean = clean.replace(/javascript\s*:/gi, 'blocked:');
  clean = clean.replace(/vbscript\s*:/gi, 'blocked:');
  clean = clean.replace(/data\s*:\s*text\/html/gi, 'blocked:');

  // 5. Escape HTML metacharacters so browser never interprets input as markup
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#96;');
}

/**
 * Escape HTML characters for safe template literal display.
 * @param {any} str 
 * @returns {string}
 */
export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#96;');
}

/**
 * Validate and sanitize web URLs.
 * Strictly permits only http, https, mailto, tel protocols or safe relative paths.
 * Blocks javascript:, vbscript:, data:, and file: schemes.
 * @param {string} url 
 * @returns {string} Safe URL or '#'
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '#';
  const trimmed = url.trim();

  // Explicitly block malicious URI schemes
  if (/^(javascript|vbscript|data\s*:\s*text\/html|file):/i.test(trimmed)) {
    return '#';
  }

  // Allow standard safe protocols or relative paths
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(trimmed)) {
    return trimmed.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // If user entered domain without protocol (e.g., 'youtube.com/...'), safely prefix with https://
  if (/^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}/.test(trimmed)) {
    return `https://${trimmed}`.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  return '#';
}

/**
 * Recursively sanitize all string values in an object or array.
 * Useful for sanitizing form payloads before sending to Firestore.
 * @param {any} data 
 * @returns {any}
 */
export function sanitizeObject(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return sanitizeInput(data);
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => sanitizeObject(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    sanitized[key] = sanitizeObject(value);
  }
  return sanitized;
}

/**
 * Global Real-time Input Protection Listener.
 * Intercepts every input, textarea, and form submit event across the DOM to automatically
 * strip dangerous script payloads in real-time.
 */
export function initGlobalInputProtection() {
  if (typeof document === 'undefined') return;

  const sanitizeInputField = (target) => {
    if (!target || !target.value || typeof target.value !== 'string') return;
    // Don't modify password fields while typing
    if (target.type === 'password') return;

    // Check for suspicious script injection patterns
    const hasScriptPattern = /<\s*(script|iframe|object|embed|style|base|meta)|javascript\s*:|\bon[a-z]{3,15}\s*=/i.test(target.value);
    if (hasScriptPattern) {
      target.value = target.value
        .replace(/<\s*(script|iframe|object|embed|style|meta|link|base|applet|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(script|iframe|object|embed|style|meta|link|base|applet|form)[^>]*\/?>/gi, '')
        .replace(/\bon[a-z]{3,20}\s*=\s*(['"]).*?\1/gi, '')
        .replace(/\bon[a-z]{3,20}\s*=\s*[^>\s]+/gi, '')
        .replace(/javascript\s*:/gi, 'blocked:')
        .replace(/vbscript\s*:/gi, 'blocked:');
    }
  };

  // Real-time listener for typing / changing
  document.addEventListener('input', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      sanitizeInputField(e.target);
    }
  }, true);

  // Real-time listener for copy-pasting
  document.addEventListener('paste', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(() => sanitizeInputField(e.target), 0);
    }
  }, true);

  // Pre-submit defense for all forms
  document.addEventListener('submit', (e) => {
    if (e.target && e.target.tagName === 'FORM') {
      const inputs = e.target.querySelectorAll('input:not([type="password"]):not([type="file"]), textarea');
      inputs.forEach(input => sanitizeInputField(input));
    }
  }, true);
}
