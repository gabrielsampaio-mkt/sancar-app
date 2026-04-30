// agent.js — Gerador de dashboards de saúde de pipeline
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

  const [pipelinesRes, dealsRes, ownersRes] = await Promise.all([
    fetch('https://api.hubapi.com/crm/v3/pipelines/deals', { headers }),
    fetch('https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate,pipeline,hubspot_owner_id,hs_deal_stage_probability,createdate,hs_lastmodifieddate', { headers }),
    fetch('https://api.hubapi.com/crm/v3/owners?limit=100', { headers }),
  ]);

  const [pipelinesData, dealsData, ownersData] = await Promise.all([
    pipelinesRes.json(),
    dealsRes.json(),
    ownersRes.json(),
  ]);

  // Mapear IDs de owners para nomes legíveis
  const ownerMap = {};
  for (const o of (ownersData.results || [])) {
    ownerMap[o.id] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || `Owner ${o.id}`;
  }

  // Enriquecer deals com nome do responsável
  const deals = (dealsData.results || []).map(d => ({
    id:                  d.id,
    nome:                d.properties.dealname        || 'Sem nome',
    valor:               Number(d.properties.amount)  || 0,
    estagio:             d.properties.dealstage       || '',
    pipeline:            d.properties.pipeline        || '',
    probabilidade:       Number(d.properties.hs_deal_stage_probability) || 0,
    data_fechamento:     d.properties.closedate       || null,
    data_criacao:        d.properties.createdate      || null,
    ultima_modificacao:  d.properties.hs_lastmodifieddate || null,
    responsavel:         ownerMap[d.properties.hubspot_owner_id] || 'Sem responsável',
  }));

  const pipelines = (pipelinesData.results || []).map(p => ({
    id:      p.id,
    nome:    p.label,
    estagios: (p.stages || []).map(s => ({
      id:           s.id,
      nome:         s.label,
      probabilidade: Number(s.metadata?.probability) || 0,
    })),
  }));

  console.log(`HubSpot: ${pipelines.length} pipelines, ${deals.length} deals, ${Object.keys(ownerMap).length} responsáveis`);

  return { pipelines, deals };
}

function buildPrompt(company, data) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const temDados = data.deals.length > 0;

  return `Você é um especialista em CRM e business intelligence. Gere um dashboard HTML completo de auditoria de saúde de pipeline de vendas para a empresa "${company}".

DATA DE GERAÇÃO: ${hoje}

DADOS DO HUBSPOT (JSON):
${JSON.stringify(data, null, 2)}

${!temDados ? '⚠️ ATENÇÃO: A conta HubSpot não possui deals cadastrados. Gere o dashboard com estrutura completa mas indicando "Sem dados disponíveis" em cada seção.' : ''}

SEÇÕES OBRIGATÓRIAS DO DASHBOARD (nesta ordem):

1. HEADER
   - Logo "S" em amarelo lima com fundo verde escuro
   - Nome da empresa "${company}" em destaque
   - Data de geração: ${hoje}
   - Seletor de pipeline (dropdown JavaScript para filtrar todas as seções)

2. CARDS DE KPI (4 cards em linha)
   - Total de Deals Ativos (excluir fechados/perdidos)
   - Valor Total do Pipeline (soma dos valores ativos)
   - Forecast Ponderado: Σ(valor × probabilidade/100) — mostra receita esperada real
   - Ticket Médio (valor total ÷ total de deals)

3. FUNIL DE PIPELINE
   - Gráfico de barras HORIZONTAL mostrando quantidade de deals e valor por estágio
   - Ordenado pela sequência real do pipeline
   - Taxa de conversão entre estágios: (deals no estágio N+1 ÷ deals no estágio N) × 100%

4. FORECAST POR MÊS
   - Gráfico de barras agrupado por mês de data_fechamento
   - Barras: valor total e forecast ponderado lado a lado
   - Apenas deals com data_fechamento preenchida

5. DEALS POR RESPONSÁVEL
   - Tabela com colunas: Responsável | Nº Deals | Valor Total | Forecast Ponderado | Ticket Médio
   - Ordenada por valor total (maior primeiro)
   - Linha de total no rodapé

6. DEALS PARADOS (sem atualização há mais de 30 dias)
   - Calcule: dias_parado = diferença entre hoje (${hoje}) e ultima_modificacao
   - Incluir apenas deals com dias_parado > 30 e não-fechados
   - Colunas: Deal | Responsável | Valor | Estágio | Dias parado
   - Ordenada por dias_parado (maior primeiro)
   - Destacar em vermelho deals parados há mais de 60 dias

7. TABELA DE TODOS OS DEALS ATIVOS
   - Colunas: Deal | Responsável | Valor | Estágio | Probabilidade | Forecast | Fecha em
   - Ordenada por valor (maior primeiro)
   - Paginação JavaScript (10 por página)

REQUISITOS TÉCNICOS:
- HTML completo e autossuficiente (arquivo único)
- Chart.js via CDN: https://cdn.jsdelivr.net/npm/chart.js
- Fonte Lexend via Google Fonts
- SEM outros frameworks externos
- Meta noindex nofollow no head

IDENTIDADE VISUAL SANCAR:
- Fundo da página: #F2F2EE
- Verde escuro (headers, textos): #0B2C24
- Amarelo lima (destaques, CTAs): #BEC61C
- Preto: #0F0F0F
- Branco: #EAEAEA
- Cards com fundo branco, sombra suave, border-radius 6px

FORMATAÇÃO:
- Valores monetários: R$ X.XXX,XX (formato brasileiro)
- Percentuais: XX,X%
- Datas: DD/MM/AAAA
- Números grandes: usar separador de milhar (ponto)

Retorne APENAS o código HTML. Comece com <!DOCTYPE html> sem nenhum texto antes ou depois.`;
}

export async function generateDashboard(slug) {
  // 1. Buscar cliente no Supabase
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

  // 4. Gerar HTML com DeepSeek V3
  const completion = await deepseek.chat.completions.create({
    model:       'deepseek-chat',
    messages:    [{ role: 'user', content: buildPrompt(client.company, hubspotData) }],
    temperature: 0.2,
    max_tokens:  8000,
  });

  const dashboardHtml = completion.choices[0].message.content
    .replace(/^```html\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

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
