// server.js — Backend de verificação de token HubSpot
// Stack: Node.js + Express + Supabase + Nodemailer
// Deploy: Coolify (Docker)

import express from 'express';
import { generateDashboard } from './agent.js';
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
    from:    `"Sancar Consultoria" <${process.env.SMTP_USER}>`,
    to:      process.env.NOTIFY_EMAIL,
    subject: `Novo cliente integrado: ${company}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0F0F0F">

        <div style="background:#0B2C24;padding:28px 32px;border-radius:8px 8px 0 0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
            <div style="width:28px;height:28px;background:#BEC61C;border-radius:3px;display:inline-flex;align-items:center;justify-content:center">
              <span style="font-weight:900;font-size:15px;color:#0B2C24">S</span>
            </div>
            <span style="color:#EAEAEA;font-size:14px;font-weight:600;letter-spacing:0.3px">Sancar Consultoria</span>
          </div>
          <h2 style="color:#BEC61C;margin:0;font-size:22px;font-weight:700;letter-spacing:-0.5px">Novo cliente integrado</h2>
          <p style="color:rgba(234,234,234,0.6);margin:6px 0 0;font-size:13px">Token HubSpot verificado com sucesso</p>
        </div>

        <div style="background:#ffffff;padding:28px 32px;border:1px solid #e8e8e8;border-top:none">
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.8px;width:120px">Empresa</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;font-weight:600;color:#0B2C24">${company}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.8px">Responsável</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#0F0F0F">${contact_name}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.8px">E-mail</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#0F0F0F">${contact_email}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.8px">Pipelines</td>
              <td style="padding:10px 0;font-size:14px;color:#0F0F0F">${pipelinesCount} encontrado${pipelinesCount !== 1 ? 's' : ''}</td>
            </tr>
          </table>

          <div style="margin-top:24px;padding:14px 16px;background:#f7f9f7;border-left:3px solid #BEC61C;border-radius:0 4px 4px 0">
            <p style="margin:0;font-size:12.5px;color:#555;line-height:1.6">
              Token criptografado e salvo no banco de dados.<br>
              <strong style="color:#0B2C24">Próximo passo:</strong> acessar o HubSpot do cliente e iniciar o mapeamento de pipelines.
            </p>
          </div>
        </div>

        <div style="background:#f5f5f3;padding:16px 32px;border-radius:0 0 8px 8px;border:1px solid #e8e8e8;border-top:none">
          <p style="margin:0;font-size:11px;color:#999;text-align:center">
            Sancar Consultoria · Sistema automatizado · <a href="https://app.sancar.space" style="color:#0B2C24">app.sancar.space</a>
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

// ─── Dashboard do cliente ──────────────────────────────────────
app.get('/u/:slug', async (req, res) => {
  const { data: client } = await supabase
    .from('clients')
    .select('dashboard_html')
    .eq('slug', req.params.slug)
    .single();

  if (!client?.dashboard_html) {
    return res.status(404).send('<p style="font-family:sans-serif;padding:40px">Dashboard ainda não gerado. Entre em contato com a Sancar.</p>');
  }

  res.setHeader('Content-Type', 'text/html');
  res.send(client.dashboard_html);
});

// ─── Geração de dashboard (uso interno Sancar) ─────────────────
// Responde imediatamente e gera em segundo plano (evita timeout do Cloudflare)
app.post('/admin/generate/:slug', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: 'Não autorizado.' });
  }

  const slug = req.params.slug;
  res.json({ success: true, message: 'Geração iniciada.', url: `https://app.sancar.space/u/${slug}` });

  generateDashboard(slug).catch(err => {
    console.error(`Erro ao gerar dashboard (${slug}):`, err.message);
  });
});

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
