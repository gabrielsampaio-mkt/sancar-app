// server.js — Backend de verificação de token HubSpot
// Stack: Node.js + Express + Supabase + Nodemailer
// Deploy: Coolify (Docker)

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));
app.use(express.static(join(__dirname, 'public')));

// Bloqueia indexação por buscadores em todas as rotas
app.use((_, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// ─── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role key (server-side apenas!)
);

// ─── Email (Nodemailer) ────────────────────────────────────────
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ─── Criptografia do token ─────────────────────────────────────
// Usamos AES-256-GCM para criptografar o token antes de salvar no banco
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes em hex

function encryptToken(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Salva: iv:tag:encrypted (tudo em base64)
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

// ─── Verificação do token HubSpot ─────────────────────────────
async function verifyHubSpotToken(token) {
  // Testa chamando pipelines de deals — requer crm.pipelines.orders.read
  const res = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 401) return { valid: false, reason: 'Token inválido ou expirado.' };
  if (res.status === 403) return { valid: false, reason: 'Token sem os escopos necessários.' };
  if (!res.ok)            return { valid: false, reason: `Erro inesperado da HubSpot (${res.status}).` };

  const data = await res.json();
  return { valid: true, pipelines: data.results || [] };
}

// ─── Notificação por e-mail ────────────────────────────────────
async function sendNotificationEmail({ company, contact_name, contact_email, pipelinesCount }) {
  await mailer.sendMail({
    from:    `"Sancar · Sistema" <${process.env.SMTP_USER}>`,
    to:      process.env.NOTIFY_EMAIL, // Seu e-mail interno
    subject: `🟢 Novo cliente integrado: ${company}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
        <div style="background:#FF6B2B;padding:20px 28px;border-radius:10px 10px 0 0">
          <h2 style="color:#fff;margin:0;font-size:20px">Novo cliente integrado ✓</h2>
        </div>
        <div style="background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px;border:1px solid #eee;border-top:none">
          <p style="margin:0 0 16px"><strong>Empresa:</strong> ${company}</p>
          <p style="margin:0 0 16px"><strong>Responsável:</strong> ${contact_name}</p>
          <p style="margin:0 0 16px"><strong>E-mail:</strong> ${contact_email}</p>
          <p style="margin:0 0 24px"><strong>Pipelines encontrados:</strong> ${pipelinesCount}</p>
          <p style="font-size:13px;color:#666">
            O token foi verificado e salvo com sucesso no banco de dados (criptografado).<br>
            O agente de geração de dashboard será acionado em breve.
          </p>
        </div>
      </div>
    `,
  });
}

// ─── Rota principal ────────────────────────────────────────────
app.post('/onboarding/verify', async (req, res) => {
  const { company, contact_name, contact_email, hubspot_token } = req.body;

  // Validação básica
  if (!company || !contact_name || !contact_email || !hubspot_token) {
    return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(contact_email)) {
    return res.status(400).json({ success: false, message: 'E-mail inválido.' });
  }

  if (!hubspot_token.startsWith('pat-')) {
    return res.status(400).json({ success: false, message: 'Token inválido. Deve começar com "pat-".' });
  }

  // 1. Verificar token na HubSpot
  const verification = await verifyHubSpotToken(hubspot_token);
  if (!verification.valid) {
    return res.status(422).json({ success: false, message: verification.reason });
  }

  // 2. Criptografar e salvar no Supabase
  const encryptedToken = encryptToken(hubspot_token);
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const { error: dbError } = await supabase
    .from('clients')
    .upsert({
      company,
      contact_name,
      contact_email,
      hubspot_token_enc: encryptedToken,
      slug,
      status: 'token_verified',
      pipelines_count: verification.pipelines.length,
      connected_at: new Date().toISOString(),
    }, { onConflict: 'contact_email' });

  if (dbError) {
    console.error('Supabase error:', dbError);
    return res.status(500).json({ success: false, message: 'Erro ao salvar dados. Tente novamente.' });
  }

  // 3. Notificar equipe Sancar
  try {
    await sendNotificationEmail({
      company,
      contact_name,
      contact_email,
      pipelinesCount: verification.pipelines.length,
    });
  } catch (emailErr) {
    // Não falha o fluxo principal se o e-mail der problema
    console.error('Email error:', emailErr.message);
  }

  // 4. (Futuro) Disparar geração do dashboard aqui
  // await triggerDashboardAgent({ slug, encryptedToken });

  return res.json({
    success: true,
    message: 'Token verificado e integração concluída com sucesso.',
    pipelines_count: verification.pipelines.length,
  });
});

// ─── Health check ──────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Página de onboarding ──────────────────────────────────────
app.get('/', (_, res) => res.sendFile(join(__dirname, 'public', 'onboarding.html')));

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
