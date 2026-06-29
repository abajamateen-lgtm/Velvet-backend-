/**
 * Velvet Capital — Frontend Config
 * ─────────────────────────────────
 * This file is loaded BEFORE dashboard-logic.js in your HTML.
 *
 * HOW TO USE:
 *  • In development: point BACKEND_URL to http://localhost:3000
 *  • In production:  point BACKEND_URL to your Railway/Render URL
 *
 * NOTE: SUPABASE_ANON_KEY (publishable key) is safe to include here.
 *       NEVER put your SERVICE_ROLE_KEY in any frontend file.
 */

window.VELVET_CONFIG = {
  // ── Supabase (publishable key — safe in frontend) ──
  SUPABASE_URL:      'https://vfqtgnlvfqeuybhtbutt.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_-Xd4ZFAiRqTu9jPzA1LStA_raLDkZL5',

  // ── Backend URL ───────────────────────────────────
  // Change this to your Railway/Render URL once deployed.
  // Example: 'https://velvet-capital-api.up.railway.app'
  BACKEND_URL: 'https://velvet-backend-dqq6.onrender.com',
};
