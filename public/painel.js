'use strict';
// Painel com foco nos dois simulados: cartões no topo e, abaixo, tudo filtrado pelo simulado escolhido.
let ME, HIST_TODOS = [], HIST = [], TEMAS = {}, SEL = 's1', escolhido = null, modoRank = 'primeira', cdTimers = [];

const simAtual = () => ME.simulados.find(s => s.id === SEL);

$('#sair').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', semRedirect: true }).catch(() => {});
  location.href = '/';
});
$$('[data-fechar]').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('on')));
$('#ck-regras').addEventListener('change', e => { $('#bt-comecar').disabled = !e.target.checked; });
$('#bt-comecar').addEventListener('click', async () => {
  const b = $('#bt-comecar');
  b.disabled = true;
  try {
    await api('/api/tentativas', { method: 'POST', body: { simulado: escolhido } });
    location.href = '/prova';
  } catch (e) {
    toast(e.message, 'erro');
    b.disabled = false;
  }
});
$$('.rank-tg button').forEach(b => b.addEventListener('click', () => {
  modoRank = b.dataset.modo;
  $$('.rank-tg button').forEach(x => x.classList.toggle('on', x === b));
  montarRanking();
}));

async function carregar() {
  [ME, HIST_TODOS, TEMAS] = await Promise.all([api('/api/me'), api('/api/tentativas'), api('/api/temas')]);
  $('#ola').innerHTML = `Olá, <b>${esc(ME.nome.split(' ')[0])}</b>`;
  const pedido = new URLSearchParams(location.search).get('s');
  if (ME.simulados.some(s => s.id === pedido)) SEL = pedido;
  else if (ME.aberta) SEL = ME.aberta.simulado;
  montarCartoes();
  montarSeletor();
  montarSecoes();
  revelar();
}

// ---------- cartões dos dois simulados ----------
function abrirRegras(s) {
  escolhido = s.id;
  $('#rg-nome').textContent = s.nome;
  $('#rg-tempo').innerHTML = `Você terá <b>${fmtMin(s.duracaoMin)}</b> para ${s.total} itens. O cronômetro corre mesmo se fechar a página, e ao zerar a prova é entregue sozinha.`;
  $('#ck-regras').checked = false;
  $('#bt-comecar').disabled = true;
  $('#m-regras').classList.add('on');
}
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${m} min`;

function montarCartoes() {
  cdTimers.forEach(clearInterval);
  cdTimers = [];
  const desvio = Date.now() - new Date(ME.agora).getTime();
  $('#sims').innerHTML = ME.simulados.map(s => {
    let acao;
    if (s.emAndamento) acao = `<a class="btn btn-ouro" href="/prova">${ESTRELA} Continuar a prova</a><small>O cronômetro continua correndo.</small>`;
    else if (ME.aberta) acao = `<button class="btn btn-claro" disabled>Aguarde</button><small>Termine primeiro o ${esc(ME.aberta.nome)}.</small>`;
    else if (s.podeIniciar) acao = `<button class="btn btn-ouro" data-ini="${s.id}">${ESTRELA} ${s.feitas ? 'Fazer de novo' : 'Começar'}</button><small>${s.feitas ? 'Nova tentativa liberada.' : 'Você ainda não fez este simulado.'}</small>`;
    else acao = `<div class="contador mini" data-alvo="${s.proximaEm}"><div><b>00</b><span>H</span></div><div><b>00</b><span>MIN</span></div><div><b>00</b><span>SEG</span></div></div><small>para liberar a próxima tentativa</small>`;
    return `<article class="sim ${s.id === SEL ? 'sel' : ''}" data-sim="${s.id}">
      <header><span class="sim-n">${esc(s.nome)}</span>${s.emAndamento ? '<span class="tag ouro">em andamento</span>' : ''}</header>
      <ul class="sim-info"><li><b>${s.cf}</b> Constitucional</li><li><b>${s.pv}</b> Previdenciário</li><li><b>${fmtMin(s.duracaoMin)}</b> de prova</li></ul>
      <p class="sim-nota">${s.melhor === null ? 'Sem nota ainda' : `Melhor nota: <b>${s.melhor}</b> de ${s.total}`}${s.feitas ? ` · ${s.feitas} ${s.feitas === 1 ? 'tentativa' : 'tentativas'}` : ''}</p>
      <div class="sim-acao">${acao}</div>
    </article>`;
  }).join('');
  $$('[data-ini]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    abrirRegras(ME.simulados.find(s => s.id === b.dataset.ini));
  }));
  $$('.sim').forEach(c => c.addEventListener('click', e => {
    if (e.target.closest('a,button')) return;
    selecionar(c.dataset.sim);
  }));
  $$('.contador[data-alvo]').forEach(el => {
    const alvo = new Date(el.dataset.alvo).getTime(), b = $$('b', el);
    const tick = () => {
      const r = alvo - (Date.now() - desvio);
      if (r <= 0) { location.reload(); return; }
      b[0].textContent = pad(Math.floor(r / 36e5));
      b[1].textContent = pad(Math.floor(r % 36e5 / 6e4));
      b[2].textContent = pad(Math.floor(r % 6e4 / 1e3));
    };
    tick();
    cdTimers.push(setInterval(tick, 1000));
  });
}

// ---------- seletor: tudo abaixo é do simulado escolhido ----------
function montarSeletor() {
  $('#sim-tg').innerHTML = ME.simulados.map(s => `<button role="tab" data-s="${s.id}" class="${s.id === SEL ? 'on' : ''}">${esc(s.nome)}</button>`).join('');
  $$('#sim-tg button').forEach(b => b.addEventListener('click', () => selecionar(b.dataset.s)));
}
function selecionar(id) {
  if (id === SEL) return;
  SEL = id;
  $$('#sim-tg button').forEach(b => b.classList.toggle('on', b.dataset.s === id));
  $$('.sim').forEach(c => c.classList.toggle('sel', c.dataset.sim === id));
  history.replaceState(null, '', '?s=' + id);
  montarSecoes();
}

function montarSecoes() {
  HIST = HIST_TODOS.filter(t => t.simulado === SEL);
  montarKPIs();
  montarTemas();
  montarEvolucao();
  montarBadges();
  montarHistorico();
  montarRanking();
}

function montarKPIs() {
  const s = simAtual(), ult = HIST[HIST.length - 1];
  $('#k-qtd').textContent = HIST.length;
  $('#k-qtd').nextElementSibling.textContent = HIST.length === 1 ? 'Tentativa feita' : 'Tentativas feitas';
  $('#k-ult').textContent = '—';
  $('#k-mel').textContent = '—';
  if (!ult) return;
  if (ult.nota < 0) $('#k-ult').textContent = ult.nota; else contar($('#k-ult'), ult.nota);
  const mel = Math.max(...HIST.map(t => t.nota));
  if (mel < 0) $('#k-mel').textContent = mel; else contar($('#k-mel'), mel);
  $('#k-ult').nextElementSibling.textContent = `Última nota (máx. ${s.total})`;
}

function montarTemas() {
  const ult = HIST[HIST.length - 1];
  const vazioT = '<p class="vazio">Faça este simulado para ver seu mapa de desempenho.</p>';
  if (!ult || !ult.por_tema) {
    $('#temas').innerHTML = vazioT;
    $('#bem').innerHTML = '<li><div><b>Sem dados ainda</b><span>Seus pontos fortes aparecem aqui depois do simulado.</span></div></li>';
    $('#mal').innerHTML = '<li><div><b>Sem dados ainda</b><span>Os temas que mais precisam de atenção aparecem aqui.</span></div></li>';
    return;
  }
  const ant = HIST.length > 1 ? HIST[HIST.length - 2].por_tema : null;
  renderTemas($('#temas'), ult.por_tema, TEMAS, ant);
  renderFoco($('#bem'), $('#mal'), ult.por_tema, TEMAS);
}

// ---------- gráfico de evolução ----------
function montarEvolucao() {
  if (!HIST.length) { $('#chart').innerHTML = '<p class="vazio">Seu gráfico de evolução aparece a partir da 1ª tentativa.</p>'; return; }
  const total = simAtual().total;
  const W = 600, H = 200, padX = 34, padY = 22;
  const notas = HIST.map(t => t.nota);
  const min = Math.min(0, ...notas), max = total;
  const x = i => HIST.length === 1 ? W / 2 : padX + i * (W - padX * 2) / (HIST.length - 1);
  const y = v => H - padY - (v - min) / (max - min) * (H - padY * 2);
  const pts = notas.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const passos = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(total * f));
  const grades = passos.map(v => `<line class="grade-l" x1="${padX}" x2="${W - padX}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v) + 4}">${v}</text>`).join('');
  const area = HIST.length > 1 ? `<polygon class="area" points="${x(0)},${y(min)} ${pts} ${x(HIST.length - 1)},${y(min)}"/>` : '';
  const pontos = notas.map((v, i) => `<circle class="pt" cx="${x(i)}" cy="${y(v)}" r="6"/><text x="${x(i)}" y="${y(v) - 12}" text-anchor="middle">${v}</text>`).join('');
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b78ff" stop-opacity=".28"/><stop offset="1" stop-color="#3b78ff" stop-opacity="0"/></linearGradient></defs>${grades}${area}${HIST.length > 1 ? `<polyline class="linha" points="${pts}"/>` : ''}${pontos}</svg>`;
}

// ---------- conquistas (nos dois simulados; notas proporcionais a 40 itens) ----------
function montarBadges() {
  const h = HIST_TODOS, melhor = h.length ? Math.max(...h.map(t => t.nota)) : -999;
  const fez = id => h.some(t => t.simulado === id);
  const gabaritouTema = h.some(t => Object.values(t.por_tema || {}).some(x => x.total >= 3 && x.certos === x.total));
  const evoluiu = ['s1', 's2'].some(id => { const n = h.filter(t => t.simulado === id).map(t => t.nota); return n.length >= 2 && n[n.length - 1] > n[0]; });
  const lista = [
    { i: '🎯', n: 'Primeira prova', d: 'Concluiu o 1º simulado', on: h.length >= 1 },
    { i: '🧩', n: 'Dupla completa', d: 'Fez os dois simulados', on: fez('s1') && fez('s2') },
    { i: '🥉', n: 'Bronze', d: 'Nota líquida 10+', on: melhor >= 10 },
    { i: '🥈', n: 'Prata', d: 'Nota líquida 20+', on: melhor >= 20 },
    { i: '🥇', n: 'Ouro', d: 'Nota líquida 30+', on: melhor >= 30 },
    { i: '💎', n: 'Diamante', d: 'Nota líquida 35+', on: melhor >= 35 },
    { i: '🛡️', n: 'Prova limpa', d: 'Sem sair da tela', on: h.some(t => t.violacoes === 0) },
    { i: '📈', n: 'Em evolução', d: 'Superou a 1ª nota', on: evoluiu },
    { i: '⭐', n: 'Gabaritou tema', d: '100% em um tema', on: gabaritouTema },
    { i: '⚡', n: 'Cirúrgico', d: '30+ certos e até 3 erros', on: h.some(t => t.certos >= 30 && t.errados <= 3) },
  ];
  $('#badges').innerHTML = lista.map((b, k) => `<div class="bdg ${b.on ? 'on' : ''}" title="${esc(b.d)}"><div class="md" style="animation-delay:${k * 0.07}s">${b.i}</div><b>${esc(b.n)}</b><span>${esc(b.d)}</span></div>`).join('');
  $('#bdg-sub').textContent = `${lista.filter(b => b.on).length} de ${lista.length} medalhas desbloqueadas (nos dois simulados).`;
}

function montarHistorico() {
  if (!HIST.length) { $('#hist').innerHTML = '<p class="vazio">Nenhuma tentativa concluída neste simulado.</p>'; return; }
  const motivo = { entregue: 'Entregue', tempo: 'Tempo esgotado', saidas: 'Encerrada por saídas' };
  $('#hist').innerHTML = HIST.slice().reverse().map((t, i) => `<a href="/resultado?id=${t.id}">
    <span class="nt">${t.nota}</span>
    <span class="mt"><b>${i === 0 ? 'Última tentativa' : `Tentativa ${HIST.length - i}`}${t.primeira ? ' <span class="tag azul">oficial</span>' : ''}</b>
    <span>${fmtData(t.iniciada_em)} · ${t.certos} certos, ${t.errados} errados · ${fmtDur(t.duracao_seg)} · ${motivo[t.motivo_fim] || ''}</span></span>
    <span class="seta">›</span></a>`).join('');
}

async function montarRanking() {
  const tb = $('#rank tbody'), pedido = SEL;
  try {
    const r = await api(`/api/ranking?simulado=${SEL}&modo=${modoRank}`);
    if (pedido !== SEL) return; // trocou de simulado no meio
    const linha = (l, extra = '') => `<tr class="${l.eu ? 'eu' : ''} ${extra}"><td><span class="pos ${l.pos <= 3 ? 'p' + l.pos : ''}">${l.pos}</span></td><td>${esc(l.nome)}${l.eu ? ' <span class="tag azul">você</span>' : ''}</td><td><b>${l.nota}</b></td><td>${l.certos}/${r.totalItens}</td><td>${fmtDur(l.duracao_seg)}</td></tr>`;
    tb.innerHTML = r.lista.length ? r.lista.map(l => linha(l)).join('') : '<tr><td colspan="5" class="vazio">Ninguém concluiu este simulado ainda. Seja o primeiro do ranking!</td></tr>';
    if (r.eu && !r.lista.some(l => l.eu)) tb.innerHTML += linha(r.eu, 'sep');
    $$('tr', tb).forEach((tr, i) => { tr.style.animationDelay = Math.min(i, 15) * 0.04 + 's'; });
    $('#k-pos').textContent = r.eu ? r.eu.pos + 'º' : '—';
    $('#k-pos-sub').textContent = r.eu ? `de ${r.total} no ranking` : 'no ranking';
    $('#rank-tit').textContent = `Ranking do ${simAtual().nome}`;
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="5" class="vazio">${esc(e.message)}</td></tr>`;
  }
}

carregar().catch(e => toast(e.message, 'erro'));
