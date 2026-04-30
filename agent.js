// agent.js — Gerador de dashboards de saúde de pipeline
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import crypto from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY });

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

// ─── Prompt para DeepSeek (só gera o visual) ─────────────────────────────────
function buildPrompt(company, dados) {
  return `Você é um desenvolvedor front-end especialista em dashboards de CRM. Sua tarefa é gerar um dashboard HTML completo e profissional.

IMPORTANTE: Os dados já foram calculados e estão no objeto DADOS abaixo. Você NÃO deve calcular nada — apenas renderizá-los visualmente com Chart.js e tabelas HTML.

EMPRESA: ${company}
DADOS PRÉ-CALCULADOS:
${JSON.stringify(dados, null, 2)}

SEÇÕES OBRIGATÓRIAS (todas com dados reais do objeto DADOS):

1. HEADER
   - Logo "S" quadrado amarelo lima sobre fundo verde escuro
   - Nome "${company}" e data "${dados.geradoEm}"
   - Seletor de pipeline (filtra seções 3 e 5 por pipelineId)

2. KPI CARDS (linha de 5 cards)
   - Total de deals ativos: dados.kpis.totalAtivos
   - Valor do pipeline: dados.kpis.valorTotal
   - Forecast ponderado: dados.kpis.forecastPonderado
   - Ticket médio: dados.kpis.ticketMedio
   - Deals atrasados: dados.kpis.dealsAtrasados (fundo vermelho suave se > 0)

3. TAXA DE FECHAMENTO POR PIPELINE (tabela)
   - Fonte: dados.porPipeline
   - Colunas: Pipeline | Deals Ativos | Valor | Forecast | Ganhos | Perdidos | Taxa de Fechamento
   - Taxa em badge colorido: verde ≥60%, amarelo 30-59%, vermelho <30%, cinza sem dados

4. FUNIL POR PIPELINE
   - Fonte: dados.porEstagio (filtrado pelo pipeline selecionado no header)
   - Gráfico de barras horizontais: eixo Y = estágio, eixo X = quantidade de deals
   - Tooltip com valor e forecast de cada estágio

5. FORECAST POR MÊS
   - Fonte: dados.forecastPorMes
   - Gráfico de barras agrupadas: valor total (verde claro) e forecast ponderado (verde escuro)
   - Labels no eixo X com dados.forecastPorMes[i].label

6. DEALS POR RESPONSÁVEL (tabela)
   - Fonte: dados.porResponsavel
   - Colunas: Responsável | Deals | Valor Total | Forecast | Ticket Médio
   - Ordenado por valor (maior primeiro)
   - Linha de TOTAL no rodapé

7. DEALS PARADOS (tabela)
   - Fonte: dados.dealsParados
   - Colunas: Deal | Responsável | Valor | Estágio | Pipeline | Dias Parado
   - Linha com critico=true em fundo vermelho suave (#FEE2E2)
   - Mensagem "Nenhum deal parado" se array vazio

8. TODOS OS DEALS ATIVOS (tabela paginada)
   - Fonte: dados.listaDeals
   - Colunas: Deal | Responsável | Valor | Estágio | Prob.% | Forecast | Fecha em
   - Linha com atrasado=true em texto laranja
   - Paginação JS (10 por página)
   - Campo de busca por nome do deal ou responsável

IDENTIDADE VISUAL:
- Fundo: #F2F2EE | Verde escuro: #0B2C24 | Lima: #BEC61C | Preto: #0F0F0F | Branco: #EAEAEA
- Cards: fundo branco, border-radius 8px, sombra suave
- Tabelas: header verde escuro com texto branco, linhas alternadas
- Fonte: Lexend (Google Fonts)
- Chart.js via https://cdn.jsdelivr.net/npm/chart.js
- Meta noindex nofollow

REGRAS TÉCNICAS:
- HTML único e autossuficiente
- Inicialize os gráficos em DOMContentLoaded
- O seletor de pipeline deve filtrar dados.porEstagio por pipelineId e recriar o gráfico
- Todos os valores monetários já estão formatados nos campos *Fmt (ex: valorFmt)
- NÃO recalcule nada — use diretamente os valores do objeto DADOS
- Trate arrays vazios com mensagem amigável

Retorne APENAS o código HTML começando com <!DOCTYPE html>.`;
}

// ─── Exportação principal ─────────────────────────────────────────────────────
export async function generateDashboard(slug) {
  const { data: client, error } = await supabase.from('clients').select('*').eq('slug', slug).single();
  if (error || !client) throw new Error(`Cliente não encontrado: ${slug}`);

  const token       = decryptToken(client.hubspot_token_enc);
  const rawData     = await fetchHubSpotData(token);
  const dados       = processData(rawData);

  console.log(`Métricas: ${dados.kpis.totalAtivos} deals ativos, forecast ${dados.kpis.forecastPonderado}, ${dados.dealsParados.length} parados`);

  const completion = await deepseek.chat.completions.create({
    model:       'deepseek-chat',
    messages:    [{ role: 'user', content: buildPrompt(client.company, dados) }],
    temperature: 0.1,
    max_tokens:  8000,
  });

  const dashboardHtml = completion.choices[0].message.content
    .replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();

  await supabase.from('clients').update({
    dashboard_html:      dashboardHtml,
    dashboard_pushed_at: new Date().toISOString(),
    status:              'dashboard_ready',
  }).eq('slug', slug);

  return dashboardHtml;
}
