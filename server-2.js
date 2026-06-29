/**
 * Velvet Capital — Production Backend
 * Stack: Express + Multer + fluent-ffmpeg + Supabase (service role)
 *
 * Environment variables required (.env or Railway/Render config):
 *   SUPABASE_URL            — your project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (NOT the publishable key)
 *   PORT                    — optional, defaults to 3000
 */

import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

// ─── Supabase (service role — never expose this key on the client) ─────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow your Netlify frontend to reach this backend
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Set FRONTEND_URL=https://yoursite.netlify.app in prod
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// ─── Multer — temp disk storage for uploaded videos ──────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'tmp/'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only MP4, MOV, AVI, WebM allowed.'));
  },
});

// ─── Helper: authenticate request via Bearer token ───────────────────────────
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header.');
  }
  const token = authHeader.split(' ')[1];

  // Verify the JWT with Supabase admin client
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) throw new Error('Invalid or expired session token.');
  return user;
}

// ─── Helper: fetch subscription row for user ─────────────────────────────────
async function getUserSubscription(userId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('id, plan_name, credits_remaining, total_usage_count')
    .eq('id', userId)
    .single();

  if (error || !data) throw new Error('Subscription record not found.');
  return data;
}

// ─── Helper: clean up temp files ─────────────────────────────────────────────
function cleanupFiles(...files) {
  for (const f of files) {
    if (f && fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

// ─── Feature gate map — mirrors payments.html ────────────────────────────────
// tool_id → minimum plan required
const TOOL_PLAN_REQUIREMENTS = {
  upscale_4k:      ['studio', 'network'],
  asset_merger:    ['creators', 'studio', 'network'],
  batch_compress:  ['creators', 'studio', 'network'],
  audio_declipper: ['studio', 'network'],
  voice_booster:   ['studio', 'network'],
  contrast:        ['creators', 'studio', 'network'],
  font_assistant:  ['creators', 'studio', 'network'],
  caption_styling: ['studio', 'network'],
  template_library:['creators', 'studio', 'network'],
  sync:            ['network'],
  watermark:       ['casual'], // Casual only, paid plans don't watermark
};

// ─── /health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── /process ─────────────────────────────────────────────────────────────────
app.post('/process', upload.single('video'), async (req, res) => {
  const inputPath = req.file?.path;
  let outputPath = null;

  try {
    // 1. Authenticate
    const user = await getAuthenticatedUser(req);

    // 2. Fetch subscription
    const subscription = await getUserSubscription(user.id);
    const { plan_name, credits_remaining } = subscription;
    const isCasual = plan_name === 'casual';

    // 3. Credit check for Casual users
    if (isCasual && credits_remaining <= 0) {
      cleanupFiles(inputPath);
      return res.status(402).json({
        error: 'No credits remaining.',
        hint: 'Upgrade your plan at /payments.html',
      });
    }

    // 4. Tool authorization check
    const requestedTool = req.body.tool; // e.g. "upscale_4k"
    if (requestedTool && TOOL_PLAN_REQUIREMENTS[requestedTool]) {
      const allowedPlans = TOOL_PLAN_REQUIREMENTS[requestedTool];
      if (!allowedPlans.includes(plan_name)) {
        cleanupFiles(inputPath);
        return res.status(403).json({
          error: `The "${requestedTool}" tool is not available on the ${plan_name} plan.`,
          hint: 'Upgrade to access this feature.',
        });
      }
    }

    // 5. Process with FFmpeg
    if (!req.file) throw new Error('No video file uploaded.');
    outputPath = path.join(__dirname, 'tmp/', `out_${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath);

      // Apply processing based on requested tool
      switch (requestedTool) {
        case 'upscale_4k':
          command = command
            .videoFilters('scale=3840:2160:flags=lanczos')
            .outputOptions(['-c:v libx264', '-preset slow', '-crf 18', '-c:a copy']);
          break;

        case 'batch_compress':
          command = command
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 28', '-c:a aac', '-b:a 128k']);
          break;

        case 'audio_declipper':
          command = command
            .audioFilters('acompressor=threshold=0.8:ratio=4:attack=5:release=50')
            .outputOptions(['-c:v copy']);
          break;

        case 'voice_booster':
          command = command
            .audioFilters('equalizer=f=3000:width_type=o:width=2:g=5,dynaudnorm')
            .outputOptions(['-c:v copy']);
          break;

        case 'contrast':
          command = command
            .videoFilters('eq=contrast=1.4:brightness=0.05:saturation=1.2')
            .outputOptions(['-c:a copy']);
          break;

        case 'watermark':
          // Casual plan: burn a text watermark
          command = command
            .videoFilters("drawtext=text='Velvet Capital':fontsize=24:fontcolor=white@0.5:x=10:y=10")
            .outputOptions(['-c:a copy']);
          break;

        default:
          // Generic passthrough — just re-encode to a clean MP4
          command = command
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac']);
      }

      command
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 6. Decrement credits for Casual users
    if (isCasual) {
      await supabaseAdmin
        .from('subscriptions')
        .update({
          credits_remaining: credits_remaining - 1,
          total_usage_count: subscription.total_usage_count + 1,
        })
        .eq('id', user.id);
    } else {
      // Still track usage for paid users (no credit deduction)
      await supabaseAdmin
        .from('subscriptions')
        .update({ total_usage_count: subscription.total_usage_count + 1 })
        .eq('id', user.id);
    }

    // 7. Stream processed file back to client
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="velvet_processed_${Date.now()}.mp4"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('end', () => cleanupFiles(inputPath, outputPath));
    readStream.on('error', () => cleanupFiles(inputPath, outputPath));

  } catch (err) {
    cleanupFiles(inputPath, outputPath);
    console.error('[/process error]', err.message);
    const status = err.message.includes('session') ? 401
                 : err.message.includes('Subscription') ? 404
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── /subscription — lightweight endpoint the dashboard calls on load ─────────
app.get('/subscription', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const subscription = await getUserSubscription(user.id);
    res.json(subscription);
  } catch (err) {
    console.error('[/subscription error]', err.message);
    res.status(401).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
// Create tmp dir if it doesn't exist
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

app.listen(PORT, () => {
  console.log(`Velvet Capital backend running on port ${PORT}`);
});
