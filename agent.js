// agent.js — Gerador de dashboards de saúde de pipeline
// Fluxo: Supabase → HubSpot API → DeepSeek → Supabase

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey:  process.env.DEEPSEEK_API_KEY,
});

function decryptToken(encrypted) {
  const [ivB64, tagB64, dataB64] = encrypted.split(':');
  const key      = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv       = Buffer.from(ivB64,   'base64');
  const tag      = Buffer.from(tagB64,  'base64');
  const data     = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function fetchHubSpotData(token) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [pipelinesRes, dealsRes] = await Promise.all([
    fetch('https://api.hubapi.com/crm/v3/pipelines/deals', { headers }),
    fetch('https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate,pipeline,hs_deal_stage_probability,createdate', { headers }),
  ]);

  const [pipelinesData, dealsData] = await Promise.all([
    pipelinesRes.json(),
    dealsRes.json(),
  ]);

  return {
    pipelines: pipelinesData.results || [],
    deals:     dealsData.results     || [],
  };
}

function buildPrompt(company, data) {
  return `Você é um especialista em CRM e visualização de dados. Gere um dashboard HTML completo de saúde de pipeline de vendas para a empresa "${company}".

DADOS DO HUBSPOT:
${JSON.stringify(data, null, 2)}

REQUISITOS OBRIGATÓRIOS:
- HTML completo e autossuficiente em um único arquivo
- Chart.js via CDN (https://cdn.jsdelivr.net/npm/chart.js)
- Fonte Lexend via Google Fonts
- Identidade visual: fundo #F2F2EE, verde #0B2C24, lima #BEC61C, preto #0F0F0F, branco #EAEAEA
- Componentes: header com nome da empresa e data, 4 cards de resumo (total de deals, valor total em R$, ticket médio em R$, deals em atraso), gráfico de barras por estágio, gráfico de pizza por valor de pipeline, tabela top 10 deals, indicador de saúde geral
- Layout responsivo, textos em português brasileiro, valores em R$ X.XXX,XX
- Sem frameworks externos além de Chart.js e Google Fonts

Retorne APENAS o código HTML. Comece com <!DOCTYPE html> e não inclua nenhum texto fora do HTML.`;
}

export async function generateDashboard(slug) {
  // 1. Buscar cliente
  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !client) throw new Error(`Cliente não encontrado: ${slug}`);

  // 2. Descriptografar token
  const token = decryptToken(client.hubspot_token_enc);

  // 3. Buscar dados do HubSpot
  const hubspotData = await fetchHubSpotData(token);

  // 4. Gerar HTML com DeepSeek
  const completion = await deepseek.chat.completions.create({
    model:       'deepseek-chat',
    messages:    [{ role: 'user', content: buildPrompt(client.company, hubspotData) }],
    temperature: 0.3,
    max_tokens:  8000,
  });

  const dashboardHtml = completion.choices[0].message.content;

  // 5. Salvar no Supabase
  await supabase
    .from('clients')
    .update({
      dashboard_html:      dashboardHtml,
      dashboard_pushed_at: new Date().toISOString(),
      status:              'dashboard_ready',
    })
    .eq('slug', slug);

  return dashboardHtml;
}
