// agent.js — Gerador de dashboards de saúde de pipeline
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const deepseek  = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });

// ─── Descriptografia ──────────────────────────────────────────────────────────
function decryptToken(encrypted) {
  const [ivB64, tagB64, dataB64] = encrypted.split(':');
  const key      = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Paginação HubSpot ────────────────────────────────────────────────────────
async function fetchAllPages(baseUrl, headers) {
  const results = [];
  let after = null;
  do {
    const url = after ? `${baseUrl}&after=${after}` : baseUrl;
    const res  = await fetch(url, { headers });
    const data = await res.json();
    results.push(...(data.results || []));
    after = data.paging?.next?.after ?? null;
  } while (after);
  return results;
}

// ─── Busca HubSpot ────────────────────────────────────────────────────────────
async function fetchHubSpotData(token) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [pData, deals, owners] = await Promise.all([
    fetch('https://api.hubapi.com/crm/v3/pipelines/deals', { headers: h }).then(r => r.json()),
    fetchAllPages('https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate,pipeline,hubspot_owner_id,hs_deal_stage_probability,createdate,hs_lastmodifieddate', h),
    fetchAllPages('https://api.hubapi.com/crm/v3/owners?limit=100', h),
  ]);

  const ownerMap = {};
  for (const o of owners) {
    ownerMap[o.id] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || `Owner ${o.id}`;
  }

  const pipelines = (pData.results || []).map(p => ({
    id:      p.id,
    nome:    p.label,
    estagios: (p.stages || []).map((s, idx) => ({
      id:           s.id,
      nome:         s.label,
      probabilidade: Number(s.metadata?.probability ?? 0),
      fechado:      String(s.metadata?.isClosed) === 'true',
      ordem:        idx,
    })),
  }));

  const dealsMapped = deals.map(d => ({
    id:                 d.id,
    nome:               d.properties.dealname            || 'Sem nome',
    valor:              Number(d.properties.amount)      || 0,
    estagio:            d.properties.dealstage           || '',
    pipeline:           d.properties.pipeline            || '',
    data_fechamento:    d.properties.closedate           || null,
    data_criacao:       d.properties.createdate          || null,
    ultima_modificacao: d.properties.hs_lastmodifieddate || null,
    responsavel:        ownerMap[d.properties.hubspot_owner_id] || 'Sem responsável',
  }));

  console.log(`HubSpot: ${pipelines.length} pipelines, ${dealsMapped.length} deals, ${Object.keys(ownerMap).length} responsáveis`);
  return { pipelines, deals: dealsMapped };
}

// ─── Pré-processamento (Node.js calcula tudo) ─────────────────────────────────
function processData({ pipelines, deals }) {
  const hoje = new Date();

  // Mapas de estágios
  const stageMap = {};
  for (const p of pipelines) {
    for (const s of p.estagios) {
      stageMap[s.id] = { ...s, pipelineId: p.id, pipelineNome: p.nome };
    }
  }

  const fmt = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const diffDias = dt => dt ? Math.floor((hoje - new Date(dt)) / 86400000) : null;

  // Separar ativos, ganhos, perdidos
  const ativos  = deals.filter(d => { const s = stageMap[d.estagio]; return s && !s.fechado; });
  const ganhos  = deals.filter(d => { const s = stageMap[d.estagio]; return s?.fechado && s.probabilidade === 1; });
  const perdidos = deals.filter(d => { const s = stageMap[d.estagio]; return s?.fechado && s.probabilidade === 0; });

  // KPIs globais
  const valorTotal        = ativos.reduce((s, d) => s + d.valor, 0);
  const forecastPonderado = ativos.reduce((s, d) => s + d.valor * (stageMap[d.estagio]?.probabilidade ?? 0), 0);
  const ticketMedio       = ativos.length ? valorTotal / ativos.length : 0;
  const totalFechados     = ganhos.length + perdidos.length;
  const taxaGlobal        = totalFechados ? Math.round((ganhos.length / totalFechados) * 100) : null;

  // Deals atrasados (closedate no passado, ainda ativos)
  const dealsAtrasados = ativos.filter(d => d.data_fechamento && new Date(d.data_fechamento) < hoje);

  // Por pipeline
  const porPipeline = pipelines.map(p => {
    const pAtivos   = ativos.filter(d => d.pipeline === p.id);
    const pGanhos   = ganhos.filter(d => d.pipeline === p.id);
    const pPerdidos = perdidos.filter(d => d.pipeline === p.id);
    const pTotal    = pAtivos.reduce((s, d) => s + d.valor, 0);
    const pForecast = pAtivos.reduce((s, d) => s + d.valor * (stageMap[d.estagio]?.probabilidade ?? 0), 0);
    const fechados  = pGanhos.length + pPerdidos.length;
    return {
      id:           p.id,
      nome:         p.nome,
      deals:        pAtivos.length,
      valor:        pTotal,
      valorFmt:     fmt(pTotal),
      forecast:     pForecast,
      forecastFmt:  fmt(pForecast),
      ganhos:       pGanhos.length,
      perdidos:     pPerdidos.length,
      taxaFechamento: fechados ? Math.round((pGanhos.length / fechados) * 100) : null,
    };
  }).filter(p => p.deals > 0 || p.ganhos > 0 || p.perdidos > 0);

  // Por estágio
  const porEstagio = [];
  for (const p of pipelines) {
    for (const s of p.estagios) {
      if (s.fechado) continue;
      const eDeals = ativos.filter(d => d.estagio === s.id);
      if (!eDeals.length) continue;
      const valor    = eDeals.reduce((sum, d) => sum + d.valor, 0);
      const forecast = eDeals.reduce((sum, d) => sum + d.valor * s.probabilidade, 0);
      porEstagio.push({
        nome:         s.nome,
        pipelineId:   p.id,
        pipelineNome: p.nome,
        ordem:        s.ordem,
        probabilidade: Math.round(s.probabilidade * 100),
        deals:        eDeals.length,
        valor,        valorFmt: fmt(valor),
        forecast,     forecastFmt: fmt(forecast),
      });
    }
  }
  porEstagio.sort((a, b) => a.pipelineId.localeCompare(b.pipelineId) || a.ordem - b.ordem);

  // Por responsável
  const respMap = {};
  for (const d of ativos) {
    if (!respMap[d.responsavel]) {
      respMap[d.responsavel] = { nome: d.responsavel, deals: 0, valor: 0, forecast: 0 };
    }
    respMap[d.responsavel].deals++;
    respMap[d.responsavel].valor    += d.valor;
    respMap[d.responsavel].forecast += d.valor * (stageMap[d.estagio]?.probabilidade ?? 0);
  }
  const porResponsavel = Object.values(respMap)
    .map(r => ({ ...r, valorFmt: fmt(r.valor), forecastFmt: fmt(r.forecast), ticketMedio: fmt(r.deals ? r.valor / r.deals : 0) }))
    .sort((a, b) => b.valor - a.valor);

  // Forecast por mês
  const mesMap = {};
  for (const d of ativos) {
    if (!d.data_fechamento) continue;
    const dt  = new Date(d.data_fechamento);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const lbl = dt.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
    if (!mesMap[key]) mesMap[key] = { key, label: lbl, valor: 0, forecast: 0, deals: 0 };
    mesMap[key].valor    += d.valor;
    mesMap[key].forecast += d.valor * (stageMap[d.estagio]?.probabilidade ?? 0);
    mesMap[key].deals++;
  }
  const forecastPorMes = Object.values(mesMap)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(m => ({ ...m, valorFmt: fmt(m.valor), forecastFmt: fmt(m.forecast) }));

  // Deals parados
  const dealsParados = ativos
    .filter(d => d.ultima_modificacao && diffDias(d.ultima_modificacao) > 30)
    .map(d => ({
      nome:         d.nome,
      responsavel:  d.responsavel,
      valor:        d.valor,
      valorFmt:     fmt(d.valor),
      estagio:      stageMap[d.estagio]?.nome || d.estagio,
      pipeline:     stageMap[d.estagio]?.pipelineNome || '',
      diasParado:   diffDias(d.ultima_modificacao),
      critico:      diffDias(d.ultima_modificacao) > 60,
    }))
    .sort((a, b) => b.diasParado - a.diasParado);

  // Lista completa de deals ativos
  const listaDeals = ativos.map(d => {
    const s = stageMap[d.estagio];
    const prob = s?.probabilidade ?? 0;
    const forecast = d.valor * prob;
    const diasAberto = diffDias(d.data_criacao);
    const diasFechamento = d.data_fechamento ? Math.floor((new Date(d.data_fechamento) - hoje) / 86400000) : null;
    return {
      nome:           d.nome,
      responsavel:    d.responsavel,
      valor:          d.valor,
      valorFmt:       fmt(d.valor),
      estagio:        s?.nome || d.estagio,
      pipeline:       s?.pipelineNome || '',
      probabilidade:  Math.round(prob * 100),
      forecast,
      forecastFmt:    fmt(forecast),
      fechaEm:        d.data_fechamento ? new Date(d.data_fechamento).toLocaleDateString('pt-BR') : '—',
      diasFechamento,
      atrasado:       diasFechamento !== null && diasFechamento < 0,
      diasAberto,
    };
  }).sort((a, b) => b.valor - a.valor);

  return {
    geradoEm:   hoje.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }),
    kpis: {
      totalAtivos:        ativos.length,
      valorTotal:         fmt(valorTotal),
      forecastPonderado:  fmt(forecastPonderado),
      ticketMedio:        fmt(ticketMedio),
      ganhos:             ganhos.length,
      perdidos:           perdidos.length,
      taxaFechamentoGlobal: taxaGlobal,
      dealsAtrasados:     dealsAtrasados.length,
    },
    porPipeline,
    porEstagio,
    porResponsavel,
    forecastPorMes,
    dealsParados:  dealsParados.slice(0, 30),
    listaDeals:    listaDeals.slice(0, 50),
  };
}

// ─── Prompt de insights (Claude analisa, não gera HTML) ───────────────────────
function buildInsightsPrompt(company, dados) {
  const resumo = {
    empresa:          company,
    dealsAtivos:      dados.kpis.totalAtivos,
    valorPipeline:    dados.kpis.valorTotal,
    forecast:         dados.kpis.forecastPonderado,
    taxaFechamento:   dados.kpis.taxaFechamentoGlobal,
    dealsAtrasados:   dados.kpis.dealsAtrasados,
    dealsParados:     dados.dealsParados.length,
    pipelines:        dados.porPipeline.map(p => ({ nome: p.nome, deals: p.deals, taxa: p.taxaFechamento })),
    top5Responsaveis: dados.porResponsavel.slice(0, 5).map(r => ({ nome: r.nome, deals: r.deals, valor: r.valorFmt })),
    forecastMeses:    dados.forecastPorMes.slice(0, 3).map(m => ({ mes: m.label, forecast: m.forecastFmt })),
  };
  return `Você é um consultor de CRM especialista. Com base nos dados abaixo do pipeline de vendas da empresa "${company}", escreva uma análise em português de 2 a 3 parágrafos curtos com insights práticos e acionáveis.

Foque em: pontos de atenção, oportunidades de melhoria e padrões relevantes. Seja direto e específico com os números.

Dados:
${JSON.stringify(resumo, null, 2)}

Responda APENAS com o texto da análise, sem títulos, sem markdown, sem listas.`;
}

// ─── Injeção de dados no template HTML ───────────────────────────────────────
function generateHtmlFromTemplate(dados) {
  const template = readFileSync(join(__dirname, 'public', 'dashboard-template.html'), 'utf8');
  const json = JSON.stringify(dados).replace(/<\/script>/gi, '<\\/script>');
  return template.replace('__DADOS__', json);
}

// ─── Exportação principal ─────────────────────────────────────────────────────
export async function generateDashboard(slug) {
  console.log(`[DASHBOARD] Iniciando geração para: ${slug}`);
  const { data: client, error } = await supabase.from('clients').select('*').eq('slug', slug).single();
  if (error || !client) throw new Error(`Cliente não encontrado: ${slug}`);

  const token   = decryptToken(client.hubspot_token_enc);
  const rawData = await fetchHubSpotData(token);
  const dados   = processData(rawData);
  dados.empresa = client.company;

  console.log(`Métricas: ${dados.kpis.totalAtivos} deals ativos, forecast ${dados.kpis.forecastPonderado}, ${dados.dealsParados.length} parados`);

  // DeepSeek gera apenas o texto de análise — não gera HTML
  const insightsResp = await deepseek.chat.completions.create({
    model:      'deepseek-chat',
    max_tokens: 600,
    messages:   [{ role: 'user', content: buildInsightsPrompt(client.company, dados) }],
  });
  dados.insights = insightsResp.choices[0].message.content.trim();

  const dashboardHtml = generateHtmlFromTemplate(dados);

  await supabase.from('clients').update({
    dashboard_html:      dashboardHtml,
    dashboard_pushed_at: new Date().toISOString(),
    status:              'dashboard_ready',
  }).eq('slug', slug);

  return dashboardHtml;
}
