'use strict';
const qs = new URLSearchParams(location.search);
let R, filtro = 'todos';

['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && ['c', 'p', 's', 'u'].includes(k)) { e.preventDefault(); toast('Ação bloqueada.', 'erro'); }
});

function mensagem(nota, total) {
  const n = nota * 80 / (total || 80); // mesma régua de antes, proporcional ao tamanho do simulado
  if (n >= 60) return ['Desempenho de <em>aprovação!</em>', 'Nota de quem disputa as primeiras posições. Agora é manter o ritmo e não errar o que você já sabe.'];
  if (n >= 40) return ['Muito bem, você está <em>no caminho!</em>', 'Você já tem base. Os temas em vermelho abaixo são o atalho para subir a nota.'];
  if (n >= 20) return ['Bom começo, agora é <em>lapidar.</em>', 'Revise o gabarito comentado e foque nos temas prioritários do seu plano de estudo.'];
  return ['Todo aprovado <em>começou daqui.</em>', 'Lembre: no Cebraspe, errar desconta. Estude os temas prioritários e, na dúvida, deixe em branco.'];
}

async function carregar() {
  try {
    R = await api('/api/tentativas/' + encodeURIComponent(qs.get('id') || ''));
  } catch (e) {
    toast(e.message, 'erro');
    setTimeout(() => location.replace('/painel'), 1500);
    return;
  }
  const [tit, sub] = mensagem(R.nota, R.total);
  $('#r-tit').innerHTML = tit;
  $('#r-sub').textContent = sub;
  $('#r-data').textContent = `${R.simuladoNome} · ${fmtData(R.iniciada_em)}${R.primeira ? ' · tentativa oficial do ranking' : ''}`;
  document.title = `Resultado · ${R.simuladoNome}`;
  $('#r-max').textContent = R.total;
  $('#r-voltar').href = `/painel?s=${encodeURIComponent(R.simulado)}`;
  if (R.faixa) {
    $('#r-faixa').innerHTML = `<div><b>Seu nível: ${esc(R.faixa.nivel)} · ${R.certos} de ${R.total} certos</b><p>${esc(R.faixa.texto)}</p></div>`;
    $('#r-faixa').classList.remove('oculto');
  }
  $('#r-stats').innerHTML = `
    <div class="v"><b>${R.certos}</b><span>Certos</span></div>
    <div class="r"><b>${R.errados}</b><span>Errados</span></div>
    <div><b>${R.brancos}</b><span>Em branco</span></div>
    <div><b>${fmtDur(R.duracao_seg)}</b><span>Tempo</span></div>
    <div><b>${R.violacoes}/3</b><span>Saídas</span></div>`;
  const avisos = {
    saidas: 'Esta prova foi entregue automaticamente porque você saiu da tela 3 vezes.',
    tempo: `O tempo de prova${R.duracaoMin ? ` (${R.duracaoMin} minutos)` : ''} acabou e a prova foi entregue automaticamente.`,
  };
  if (avisos[R.motivo_fim]) { $('#r-aviso').textContent = avisos[R.motivo_fim]; $('#r-aviso').classList.remove('oculto'); }
  anel($('#ring'), R.nota, R.total);
  renderTemas($('#temas'), R.por_tema, R.temas, R.por_tema_anterior);
  renderFoco($('#bem'), $('#mal'), R.por_tema, R.temas);
  revisao();
  revelar();
  if (qs.get('novo') === '1') {
    history.replaceState(null, '', `/resultado?id=${R.id}`);
    if (R.nota >= R.total / 2) setTimeout(confete, 900);
  }
}

function situacao(q) {
  if (!q.resposta) return 'branco';
  return q.resposta === q.gabarito ? 'acerto' : 'erro';
}

function revisao() {
  const txt = { C: 'Certo', E: 'Errado' };
  const lista = R.revisao.filter(q => filtro === 'todos' || situacao(q) === filtro);
  $('#revisao').innerHTML = lista.length ? lista.map(q => {
    const s = situacao(q);
    const selo = s === 'acerto' ? '<span class="pill ok">✓ Você acertou</span>' : s === 'erro' ? '<span class="pill no">✗ Você errou (−1)</span>' : '<span class="pill">Em branco</span>';
    return `<article class="rev ${s}">
      <div class="gb"><b>Item ${q.n}</b><span class="tag azul">${esc(q.tema)}</span>${q.nivel ? `<span class="nivel-it">${esc(q.nivel)}</span>` : ''}${selo}</div>
      <p class="qtxt">${fmt(q.texto)}</p>
      <div class="gb"><span class="pill">Sua resposta: ${q.resposta ? txt[q.resposta] : '—'}</span><span class="pill ok">Gabarito: ${txt[q.gabarito]}</span></div>
      <div class="coment"><b>Comentário:</b> ${fmt(q.comentario)}</div>
    </article>`;
  }).join('') : '<p class="vazio">Nenhum item nesta categoria. 👏</p>';
}

$('#filtros').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  filtro = b.dataset.f;
  $$('#filtros button').forEach(x => x.classList.toggle('on', x === b));
  revisao();
});

carregar();
