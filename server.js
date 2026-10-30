'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { QUESTOES: QUESTOES_ANTIGAS } = require('./questoes');
const { SIMULADOS, SIMULADO, POR_ID: POR_ID_NOVOS, TEMAS } = require('./simulados');

// ---------------- configuração ----------------
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// chave pública do app web do Firebase (projeto simulados-fauth); não é segredo
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDWw8seTZDF88YkdbRl_S5sIkqSk3Hwv60';
const SITE_URL = (process.env.SITE_URL || 'https://simulados.adrianefauth.com.br').replace(/\/$/, '');
if (SECRET.length < 32) {
  console.error('Defina a variável SESSION_SECRET com pelo menos 32 caracteres.');
  process.exit(1);
}

const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1 tentativa a cada 24h, por simulado
const MAX_SAIDAS = 3;                     // na 3ª saída da tela a prova é entregue
const IDS_ATUAIS = SIMULADOS.map(s => s.id);
// itens do simulado antigo (ids 1-80) continuam resolvíveis para corrigir provas antigas
const POR_ID = new Map([...QUESTOES_ANTIGAS.map(q => [q.id, q]), ...POR_ID_NOVOS]);

// Pitch de venda no fim do simulado (Black Fauth, foco INSS). Dados da página black.adrianefauth.com.br em 30/10/2026.
// Depois de `blackAte`, preços e menção à Black somem sozinhos (fica só o convite para o curso).
const OFERTA = {
  curso: 'Projeto 80 Pontos INSS',
  descricao: 'Direito Constitucional e Direito Previdenciário com a Prof.ª Adriane Fauth e a Prof.ª Lilian Novakoski.',
  url: 'https://black.adrianefauth.com.br/?utm_source=simulados&utm_medium=resultado&utm_campaign=black_inss#cursos',
  blackAte: '2026-10-31T23:59:59-03:00',
  de: 'R$ 659', cartao: 'R$ 329,50', parcelas: '12x de R$ 34,08', pix: 'R$ 263,60', desconto: '50% OFF + 20% OFF no Pix',
};
function oferta() {
  const black = Date.now() <= new Date(OFERTA.blackAte).getTime();
  const { curso, descricao, url } = OFERTA;
  return black ? { ...OFERTA, black: true } : { curso, descricao, url, black: false };
}

// retorno ao aluno por faixa de acertos (em % de itens certos)
function faixa(certos, total) {
  const p = total ? certos / total : 0;
  if (p >= 0.9) return { nivel: 'Avançado', texto: 'Nível avançado. Mantenha o ritmo: revise só os itens que errou e não arrisque no que não tem certeza.' };
  if (p >= 0.7) return { nivel: 'Intermediário', texto: 'Nível intermediário. Revise os temas em que errou: são eles que separam você do topo.' };
  if (p >= 0.5) return { nivel: 'Básico', texto: 'Nível básico. Reforce a leitura da letra seca da lei: art. 5º e art. 37 da CF e os arts. 194 a 204, além das Leis 8.212/91 e 8.213/91.' };
  return { nivel: 'Iniciante', texto: 'Comece pelo vocabulário e pela estrutura dos direitos fundamentais e da seguridade social antes da jurisprudência. O gabarito comentado é o seu melhor material agora.' };
}

// ---------------- utilitários ----------------
function cpfValido(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    if ((soma * 10) % 11 % 10 !== Number(cpf[n])) return false;
  }
  return true;
}
const mascararCPF = c => `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;
const mascararEmail = e => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}${'*'.repeat(Math.max(2, u.length - 2))}@${d}`; };
const nomeCurto = n => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };

const hmac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function assinar(dados) {
  const p = Buffer.from(JSON.stringify(dados)).toString('base64url');
  return `${p}.${hmac(p)}`;
}
function verificar(tok) {
  if (!tok) return null;
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(hmac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${nome}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setSessao(res, alunoId) {
  const dias = 7;
  const tok = assinar({ id: alunoId, exp: Date.now() + dias * 864e5 });
  res.setHeader('Set-Cookie', `sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${dias * 86400}${PROD ? '; Secure' : ''}`);
}

function embaralhar(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Constitucional primeiro (como na prova real), Previdenciário depois; ordem sorteada dentro de cada bloco
function novaOrdem(sim) {
  const cf = sim.itens.filter(q => q.materia === 'Direito Constitucional').map(q => q.id);
  const pv = sim.itens.filter(q => q.materia !== 'Direito Constitucional').map(q => q.id);
  return [...embaralhar(cf), ...embaralhar(pv)];
}

// ---------------- Firebase Authentication (API REST do Identity Toolkit) ----------------
// A senha do aluno fica no Firebase. O servidor só fala com o Firebase; o navegador não carrega SDK externo.
class ErroFirebase extends Error { constructor(codigo) { super(codigo); this.codigo = codigo; } }
async function firebase(metodo, corpo) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${metodo}?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroFirebase(String((j.error && j.error.message) || `HTTP_${r.status}`).split(' ')[0].split(':')[0]);
  return j;
}
const MSG_FIREBASE = {
  EMAIL_EXISTS: 'Este e-mail já tem cadastro. Use a aba Entrar (com o CPF) ou outro e-mail.',
  INVALID_EMAIL: 'E-mail inválido.',
  WEAK_PASSWORD: 'A senha precisa ter pelo menos 6 caracteres.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  USER_DISABLED: 'Esta conta foi desativada. Fale com a equipe.',
};
const SENHA_ERRADA = ['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND'];
// Conta antiga (antes do Firebase): cria a conta no Firebase com senha aleatória e liga ao aluno.
// Se o e-mail já existir no Firebase, não dá para saber o uid sem a senha: o vínculo acontece no próximo login.
async function garantirFirebase(aluno) {
  if (aluno.firebase_uid) return aluno.firebase_uid;
  try {
    const fb = await firebase('signUp', { email: aluno.email, password: crypto.randomBytes(24).toString('base64url'), returnSecureToken: true });
    await pool.query('UPDATE alunos SET firebase_uid = $2 WHERE id = $1 AND firebase_uid IS NULL', [aluno.id, fb.localId]);
    return fb.localId;
  } catch (e) {
    if (e.codigo !== 'EMAIL_EXISTS') console.log('criar conta no Firebase:', e.codigo || e.message);
    return null;
  }
}
const enviarVerificacao = idToken =>
  firebase('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken, continueUrl: SITE_URL }).catch(e => console.log('verificação de e-mail:', e.codigo));

// limitador simples para login/cadastro
const limites = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of limites) if (v.reset < t) limites.delete(k); }, 10 * 60e3).unref();
const limitar = (max, janelaMs) => (req, res, next) => {
  const k = req.ip + req.path, agora = Date.now(), r = limites.get(k);
  if (!r || r.reset < agora) { limites.set(k, { n: 1, reset: agora + janelaMs }); return next(); }
  if (++r.n > max) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  next();
};

const h = fn => (req, res, next) => fn(req, res).catch(next);
const erro = (res, msg, st = 400) => res.status(st).json({ erro: msg });

function auth(req, res, next) {
  const s = verificar(lerCookie(req, 'sid'));
  if (!s) return erro(res, 'Sessão expirada. Entre novamente.', 401);
  req.alunoId = s.id;
  next();
}

// ---------------- regras da prova ----------------
async function finalizar(db, t, motivo) {
  const resp = t.respostas || {};
  let certos = 0, errados = 0, brancos = 0;
  const porTema = {};
  for (const id of t.ordem) {
    const q = POR_ID.get(id);
    if (!q) continue;
    const pt = porTema[q.tema] || (porTema[q.tema] = { materia: q.materia, total: 0, certos: 0, errados: 0, brancos: 0 });
    pt.total++;
    const r = resp[id];
    if (r !== 'C' && r !== 'E') { brancos++; pt.brancos++; }
    else if (r === q.gabarito) { certos++; pt.certos++; }
    else { errados++; pt.errados++; }
  }
  const fim = Math.min(Date.now(), new Date(t.expira_em).getTime());
  const dur = Math.max(0, Math.round((fim - new Date(t.iniciada_em).getTime()) / 1000));
  const { rows } = await db.query(
    `UPDATE tentativas SET finalizada_em = to_timestamp($2::double precision / 1000), motivo_fim = $3,
       certos = $4, errados = $5, brancos = $6, nota = $7, duracao_seg = $8, por_tema = $9
     WHERE id = $1 AND finalizada_em IS NULL RETURNING *`,
    [t.id, fim, motivo, certos, errados, brancos, certos - errados, dur, porTema]);
  return rows[0] || null;
}

// devolve a prova aberta (de qualquer simulado); se o tempo acabou, entrega automaticamente
async function provaAberta(alunoId) {
  const { rows } = await pool.query('SELECT * FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NULL', [alunoId]);
  const t = rows[0];
  if (!t) return null;
  if (new Date(t.expira_em).getTime() <= Date.now()) { await finalizar(pool, t, 'tempo'); return null; }
  return t;
}
async function ultimaFinalizada(alunoId) {
  const { rows } = await pool.query('SELECT id FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NOT NULL ORDER BY finalizada_em DESC LIMIT 1', [alunoId]);
  return rows[0] ? rows[0].id : null;
}
const nomeSimulado = id => (SIMULADO.get(id) || { nome: 'Simulado INSS (80 itens)' }).nome;
const totalSimulado = (id, t) => (SIMULADO.get(id) || { total: t.ordem.length }).total;

// ---------------- app ----------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://adrianefauth.com.br; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// text/plain para aceitar o navigator.sendBeacon
app.use(express.json({ limit: '20kb', type: ['application/json', 'text/plain'] }));

app.get('/health', h(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

// ----- conta (Firebase) -----
app.post('/api/cadastro', limitar(10, 15 * 60e3), h(async (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
  const cpf = String(b.cpf || '').replace(/\D/g, '');
  const email = String(b.email || '').trim().toLowerCase();
  const whatsapp = String(b.whatsapp || '').replace(/\D/g, '');
  const senha = String(b.senha || '');
  if (nome.length < 5 || nome.length > 120 || !nome.includes(' ')) return erro(res, 'Informe seu nome completo.');
  if (!cpfValido(cpf)) return erro(res, 'CPF inválido. Confira os números digitados.');
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return erro(res, 'E-mail inválido.');
  if (whatsapp.length < 10 || whatsapp.length > 11) return erro(res, 'WhatsApp inválido. Informe DDD + número.');
  if (senha.length < 6 || senha.length > 72) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  const ja = await pool.query('SELECT 1 FROM alunos WHERE cpf = $1', [cpf]);
  if (ja.rows[0]) return erro(res, 'Este CPF já tem cadastro. Use a aba Entrar.', 409);

  let fb;
  try {
    fb = await firebase('signUp', { email, password: senha, returnSecureToken: true });
  } catch (e) {
    if (e instanceof ErroFirebase) return erro(res, MSG_FIREBASE[e.codigo] || 'Não foi possível criar a conta. Tente novamente.', 409);
    throw e;
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO alunos (nome, cpf, email, whatsapp, firebase_uid) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [nome, cpf, email, whatsapp, fb.localId]);
    await firebase('update', { idToken: fb.idToken, displayName: nome, returnSecureToken: false }).catch(() => {});
    enviarVerificacao(fb.idToken);
    setSessao(res, rows[0].id);
    res.json({ ok: true });
  } catch (e) {
    // não deixa conta órfã no Firebase se o banco recusar (ex.: CPF cadastrado no mesmo instante)
    await firebase('delete', { idToken: fb.idToken }).catch(() => {});
    if (e.code === '23505') return erro(res, 'Este CPF ou e-mail já tem cadastro. Use a aba Entrar.', 409);
    throw e;
  }
}));

app.post('/api/login', limitar(10, 15 * 60e3), h(async (req, res) => {
  const cpf = String((req.body || {}).cpf || '').replace(/\D/g, '');
  const senha = String((req.body || {}).senha || '');
  const { rows } = await pool.query('SELECT id, email, firebase_uid, senha_hash FROM alunos WHERE cpf = $1', [cpf]);
  const a = rows[0];
  if (!a || !senha) return erro(res, 'CPF ou senha incorretos.', 401);

  if (!a.firebase_uid) {
    // conta antiga (antes do Firebase). 1º: o e-mail já tem conta no Firebase (ex.: senha redefinida pelo link)?
    try {
      const fb = await firebase('signInWithPassword', { email: a.email, password: senha, returnSecureToken: true });
      await pool.query('UPDATE alunos SET firebase_uid = $2, senha_hash = NULL WHERE id = $1', [a.id, fb.localId]);
      setSessao(res, a.id);
      return res.json({ ok: true });
    } catch (e) {
      if (!(e instanceof ErroFirebase)) throw e;
    }
    // 2º: confere a senha antiga e migra para o Firebase na hora
    if (!a.senha_hash || !(await bcrypt.compare(senha, a.senha_hash))) return erro(res, 'CPF ou senha incorretos.', 401);
    try {
      const fb = await firebase('signUp', { email: a.email, password: senha, returnSecureToken: true });
      await pool.query('UPDATE alunos SET firebase_uid = $2, senha_hash = NULL WHERE id = $1', [a.id, fb.localId]);
    } catch (e) {
      console.log('migração para o Firebase:', e.codigo || e.message); // segue com o login mesmo assim
    }
    setSessao(res, a.id);
    return res.json({ ok: true });
  }

  try {
    const fb = await firebase('signInWithPassword', { email: a.email, password: senha, returnSecureToken: true });
    if (fb.localId !== a.firebase_uid) return erro(res, 'CPF ou senha incorretos.', 401);
  } catch (e) {
    if (e instanceof ErroFirebase) {
      if (SENHA_ERRADA.includes(e.codigo)) return erro(res, 'CPF ou senha incorretos.', 401);
      return erro(res, MSG_FIREBASE[e.codigo] || 'Não foi possível entrar agora. Tente novamente.', 401);
    }
    throw e;
  }
  setSessao(res, a.id);
  res.json({ ok: true });
}));

// recuperação de senha: o Firebase envia o e-mail com o link para criar uma senha nova
app.post('/api/senha/esqueci', limitar(5, 15 * 60e3), h(async (req, res) => {
  const cpf = String((req.body || {}).cpf || '').replace(/\D/g, '');
  if (!cpfValido(cpf)) return erro(res, 'Digite um CPF válido.');
  const { rows } = await pool.query('SELECT id, email, firebase_uid FROM alunos WHERE cpf = $1', [cpf]);
  const generica = { ok: true, msg: 'Se o CPF estiver cadastrado, você vai receber um e-mail com o link para criar uma nova senha.' };
  if (!rows[0]) return res.json(generica);
  await garantirFirebase(rows[0]); // conta antiga: cria no Firebase antes de mandar o link
  try {
    await firebase('sendOobCode', { requestType: 'PASSWORD_RESET', email: rows[0].email, continueUrl: SITE_URL });
  } catch (e) {
    console.log('recuperação de senha:', e.codigo || e.message);
    if (e.codigo === 'TOO_MANY_ATTEMPTS_TRY_LATER') return erro(res, MSG_FIREBASE[e.codigo], 429);
  }
  res.json({ ok: true, msg: `Enviamos o link para ${mascararEmail(rows[0].email)}. Confira também a caixa de spam.` });
}));

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT nome, cpf FROM alunos WHERE id = $1', [req.alunoId]);
  if (!rows[0]) return erro(res, 'Sessão inválida.', 401);
  const aberta = await provaAberta(req.alunoId);
  const st = await pool.query(
    `SELECT simulado, max(iniciada_em) AS ultima_inicio,
            count(*) FILTER (WHERE finalizada_em IS NOT NULL)::int AS feitas,
            max(nota) FILTER (WHERE finalizada_em IS NOT NULL) AS melhor
     FROM tentativas WHERE aluno_id = $1 AND simulado = ANY($2) GROUP BY simulado`, [req.alunoId, IDS_ATUAIS]);
  const porSim = new Map(st.rows.map(r => [r.simulado, r]));
  const agora = Date.now();
  res.json({
    nome: rows[0].nome,
    cpf: mascararCPF(rows[0].cpf),
    agora: new Date().toISOString(),
    aberta: aberta ? { simulado: aberta.simulado, nome: nomeSimulado(aberta.simulado) } : null,
    maxSaidas: MAX_SAIDAS,
    simulados: SIMULADOS.map(s => {
      const r = porSim.get(s.id);
      const proxima = r ? new Date(r.ultima_inicio).getTime() + INTERVALO_MS : 0;
      const emAndamento = !!aberta && aberta.simulado === s.id;
      return {
        id: s.id, nome: s.nome, subtitulo: s.subtitulo, total: s.total, duracaoMin: s.duracaoSeg / 60,
        cf: s.itens.filter(q => q.materia === 'Direito Constitucional').length,
        pv: s.itens.filter(q => q.materia !== 'Direito Constitucional').length,
        feitas: r ? r.feitas : 0, melhor: r && r.melhor !== null ? r.melhor : null,
        emAndamento,
        podeIniciar: !aberta && proxima <= agora,
        proximaEm: !emAndamento && proxima > agora ? new Date(proxima).toISOString() : null,
      };
    }),
  });
}));

app.get('/api/temas', auth, (req, res) => res.json(TEMAS));

// ----- prova -----
app.post('/api/tentativas', auth, h(async (req, res) => {
  const sim = SIMULADO.get(String((req.body || {}).simulado || ''));
  if (!sim) return erro(res, 'Escolha o simulado.');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM alunos WHERE id = $1 FOR UPDATE', [req.alunoId]); // trava contra cliques duplos
    const ab = await c.query('SELECT * FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NULL', [req.alunoId]);
    if (ab.rows[0]) {
      if (new Date(ab.rows[0].expira_em).getTime() > Date.now()) {
        await c.query('COMMIT');
        if (ab.rows[0].simulado === sim.id) return res.json({ ok: true, retomada: true });
        return erro(res, `Termine primeiro o ${nomeSimulado(ab.rows[0].simulado)}, que está em andamento.`, 409);
      }
      await finalizar(c, ab.rows[0], 'tempo');
    }
    const ult = await c.query('SELECT iniciada_em FROM tentativas WHERE aluno_id = $1 AND simulado = $2 ORDER BY iniciada_em DESC LIMIT 1', [req.alunoId, sim.id]);
    if (ult.rows[0]) {
      const proxima = new Date(ult.rows[0].iniciada_em).getTime() + INTERVALO_MS;
      if (proxima > Date.now()) {
        await c.query('ROLLBACK');
        return res.status(429).json({ erro: `Você já fez o ${sim.nome} nas últimas 24 horas.`, proximaEm: new Date(proxima).toISOString() });
      }
    }
    await c.query(
      `INSERT INTO tentativas (aluno_id, simulado, expira_em, ordem, primeira)
       VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
      [req.alunoId, sim.id, sim.duracaoSeg, novaOrdem(sim), !ult.rows[0]]);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}));

app.get('/api/tentativas/atual', auth, h(async (req, res) => {
  const t = await provaAberta(req.alunoId);
  if (!t) return res.status(404).json({ erro: 'Nenhuma prova em andamento.', ultimaId: await ultimaFinalizada(req.alunoId) });
  const { rows } = await pool.query('SELECT nome, cpf FROM alunos WHERE id = $1', [req.alunoId]);
  const sim = SIMULADO.get(t.simulado);
  res.json({
    id: t.id,
    simulado: t.simulado,
    simuladoNome: nomeSimulado(t.simulado),
    expiraEm: t.expira_em,
    duracaoSeg: sim ? sim.duracaoSeg : Math.round((new Date(t.expira_em) - new Date(t.iniciada_em)) / 1000),
    agora: new Date().toISOString(),
    saidas: t.violacoes,
    maxSaidas: MAX_SAIDAS,
    respostas: t.respostas,
    marca: `${rows[0].nome} · ${mascararCPF(rows[0].cpf)}`,
    questoes: t.ordem.map((id, i) => { const q = POR_ID.get(id); return { id, n: i + 1, materia: q.materia, texto: q.texto }; }),
  });
}));

app.put('/api/tentativas/atual/resposta', auth, h(async (req, res) => {
  const qid = Number((req.body || {}).qid);
  const resp = (req.body || {}).resp ?? null;
  if (![null, 'C', 'E'].includes(resp)) return erro(res, 'Resposta inválida.');
  const t = await provaAberta(req.alunoId);
  if (!t) return res.status(409).json({ erro: 'A prova já foi encerrada.', encerrada: true, id: await ultimaFinalizada(req.alunoId) });
  if (!t.ordem.includes(qid)) return erro(res, 'Item inválido.');
  if (resp) {
    await pool.query(`UPDATE tentativas SET respostas = jsonb_set(respostas, ARRAY[$2::text], to_jsonb($3::text)) WHERE id = $1 AND finalizada_em IS NULL`, [t.id, String(qid), resp]);
  } else {
    await pool.query(`UPDATE tentativas SET respostas = respostas - $2::text WHERE id = $1 AND finalizada_em IS NULL`, [t.id, String(qid)]);
  }
  res.json({ ok: true });
}));

app.post('/api/tentativas/atual/violacao', auth, h(async (req, res) => {
  const tipo = String((req.body || {}).tipo || 'saida').slice(0, 40);
  const t = await provaAberta(req.alunoId);
  if (!t) return res.json({ encerrada: true, id: await ultimaFinalizada(req.alunoId) });
  // conta no máximo 1 saída a cada 3 s (uma troca de aba dispara vários eventos)
  const { rows } = await pool.query(
    `UPDATE tentativas SET violacoes = violacoes + 1, ultima_violacao = now(),
       eventos = eventos || jsonb_build_array(jsonb_build_object('tipo', $2::text, 'em', now()))
     WHERE id = $1 AND finalizada_em IS NULL AND (ultima_violacao IS NULL OR ultima_violacao < now() - interval '3 seconds')
     RETURNING *`, [t.id, tipo]);
  const atual = rows[0] || t;
  if (atual.violacoes >= MAX_SAIDAS) {
    await finalizar(pool, atual, 'saidas');
    return res.json({ encerrada: true, id: atual.id, saidas: atual.violacoes });
  }
  res.json({ saidas: atual.violacoes, max: MAX_SAIDAS, contou: !!rows[0] });
}));

app.post('/api/tentativas/atual/finalizar', auth, h(async (req, res) => {
  const t = await provaAberta(req.alunoId);
  if (!t) return res.json({ id: await ultimaFinalizada(req.alunoId) });
  const f = await finalizar(pool, t, 'entregue');
  res.json({ id: f ? f.id : t.id });
}));

// histórico (só dos simulados atuais; ?simulado=s1 filtra um)
app.get('/api/tentativas', auth, h(async (req, res) => {
  const filtro = SIMULADO.has(String(req.query.simulado)) ? [String(req.query.simulado)] : IDS_ATUAIS;
  const { rows } = await pool.query(
    `SELECT id, simulado, iniciada_em, finalizada_em, motivo_fim, certos, errados, brancos, nota, duracao_seg, por_tema, violacoes, primeira
     FROM tentativas WHERE aluno_id = $1 AND simulado = ANY($2) AND finalizada_em IS NOT NULL ORDER BY iniciada_em`, [req.alunoId, filtro]);
  res.json(rows.map(t => ({ ...t, total: totalSimulado(t.simulado, { ordem: [] }) })));
}));

app.get('/api/tentativas/:id', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tentativas WHERE id = $1 AND aluno_id = $2 AND finalizada_em IS NOT NULL', [Number(req.params.id) || 0, req.alunoId]);
  const t = rows[0];
  if (!t) return erro(res, 'Resultado não encontrado.', 404);
  const anterior = await pool.query(
    'SELECT por_tema FROM tentativas WHERE aluno_id = $1 AND simulado = $2 AND finalizada_em IS NOT NULL AND iniciada_em < $3 ORDER BY iniciada_em DESC LIMIT 1',
    [req.alunoId, t.simulado, t.iniciada_em]);
  const total = totalSimulado(t.simulado, t);
  const sim = SIMULADO.get(t.simulado);
  res.json({
    id: t.id, simulado: t.simulado, simuladoNome: nomeSimulado(t.simulado),
    duracaoMin: sim ? sim.duracaoSeg / 60 : null,
    iniciada_em: t.iniciada_em, motivo_fim: t.motivo_fim, certos: t.certos, errados: t.errados, brancos: t.brancos,
    nota: t.nota, duracao_seg: t.duracao_seg, violacoes: t.violacoes, primeira: t.primeira, por_tema: t.por_tema,
    por_tema_anterior: anterior.rows[0] ? anterior.rows[0].por_tema : null,
    total,
    faixa: faixa(t.certos, total),
    oferta: oferta(),
    temas: TEMAS,
    revisao: t.ordem.map((id, i) => {
      const q = POR_ID.get(id);
      return { n: i + 1, materia: q.materia, tema: q.tema, nivel: q.nivel || null, texto: q.texto, resposta: t.respostas[id] || null, gabarito: q.gabarito, comentario: q.comentario };
    }),
  });
}));

// ----- ranking (por simulado) -----
// modo=primeira: ranking oficial, só a 1ª tentativa de cada aluno (justo: ninguém decorou o gabarito)
// modo=melhor: melhor nota de cada aluno
app.get('/api/ranking', auth, h(async (req, res) => {
  const sim = SIMULADO.get(String(req.query.simulado || '')) || SIMULADOS[0];
  const melhor = req.query.modo === 'melhor';
  const base = melhor
    ? `SELECT DISTINCT ON (t.aluno_id) t.aluno_id, t.nota, t.certos, t.duracao_seg, t.finalizada_em
       FROM tentativas t WHERE t.simulado = $1 AND t.finalizada_em IS NOT NULL ORDER BY t.aluno_id, t.nota DESC, t.duracao_seg ASC`
    : `SELECT t.aluno_id, t.nota, t.certos, t.duracao_seg, t.finalizada_em
       FROM tentativas t WHERE t.simulado = $1 AND t.primeira AND t.finalizada_em IS NOT NULL`;
  const sql = `WITH b AS (${base}),
    r AS (SELECT b.*, a.nome, RANK() OVER (ORDER BY b.nota DESC, b.duracao_seg ASC) AS pos FROM b JOIN alunos a ON a.id = b.aluno_id)`;
  const [lista, eu, total] = await Promise.all([
    pool.query(`${sql} SELECT * FROM r ORDER BY pos, finalizada_em LIMIT 50`, [sim.id]),
    pool.query(`${sql} SELECT * FROM r WHERE aluno_id = $2`, [sim.id, req.alunoId]),
    pool.query(`${sql} SELECT count(*)::int AS n FROM r`, [sim.id]),
  ]);
  const fmt = l => ({ pos: Number(l.pos), nome: nomeCurto(l.nome), nota: l.nota, certos: l.certos, duracao_seg: l.duracao_seg, eu: l.aluno_id === req.alunoId });
  res.json({ simulado: sim.id, totalItens: sim.total, lista: lista.rows.map(fmt), eu: eu.rows[0] ? fmt(eu.rows[0]) : null, total: total.rows[0].n });
}));

// ----- exportação de alunos (leads) para a equipe -----
app.get('/api/admin/alunos.csv', h(async (req, res) => {
  const tok = String(req.query.token || '');
  if (!ADMIN_TOKEN || tok.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) return erro(res, 'Não autorizado.', 401);
  const { rows } = await pool.query(
    `SELECT a.nome, a.cpf, a.email, a.whatsapp, a.criado_em,
            count(t.id) FILTER (WHERE t.finalizada_em IS NOT NULL AND t.simulado = 's1') AS provas_s1,
            max(t.nota) FILTER (WHERE t.simulado = 's1') AS melhor_s1,
            count(t.id) FILTER (WHERE t.finalizada_em IS NOT NULL AND t.simulado = 's2') AS provas_s2,
            max(t.nota) FILTER (WHERE t.simulado = 's2') AS melhor_s2
     FROM alunos a LEFT JOIN tentativas t ON t.aluno_id = a.id GROUP BY a.id ORDER BY a.criado_em`);
  const cel = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['nome;cpf;email;whatsapp;cadastro;provas_simulado1;melhor_nota_simulado1;provas_simulado2;melhor_nota_simulado2',
    ...rows.map(r => [r.nome, r.cpf, r.email, r.whatsapp, new Date(r.criado_em).toISOString(), r.provas_s1, r.melhor_s1, r.provas_s2, r.melhor_s2].map(cel).join(';'))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="alunos-simulados-inss.csv"');
  res.send('﻿' + csv);
}));

// ----- equipe: redefinir o login de todos (envia o link de nova senha para cada aluno) -----
// POST /api/admin/redefinir-senhas?token=ADMIN_TOKEN   (opcional: &cpf=... para uma pessoa só)
app.post('/api/admin/redefinir-senhas', h(async (req, res) => {
  const tok = String(req.query.token || '');
  if (!ADMIN_TOKEN || tok.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) return erro(res, 'Não autorizado.', 401);
  const cpf = String(req.query.cpf || '').replace(/\D/g, '');
  const { rows } = cpf
    ? await pool.query('SELECT id, nome, email, firebase_uid FROM alunos WHERE cpf = $1', [cpf])
    : await pool.query('SELECT id, nome, email, firebase_uid FROM alunos ORDER BY id');
  const resultado = [];
  for (const a of rows) {
    await garantirFirebase(a);
    try {
      await firebase('sendOobCode', { requestType: 'PASSWORD_RESET', email: a.email, continueUrl: SITE_URL });
      resultado.push({ nome: nomeCurto(a.nome), email: mascararEmail(a.email), enviado: true });
    } catch (e) {
      resultado.push({ nome: nomeCurto(a.nome), email: mascararEmail(a.email), enviado: false, erro: e.codigo || e.message });
    }
  }
  res.json({ total: rows.length, resultado });
}));

// ----- equipe: apagar tentativas (ex.: testes antes de abrir para os alunos) -----
// POST /api/admin/limpar-tentativas?token=ADMIN_TOKEN&confirmar=APAGAR   (opcional: &cpf=... só de uma pessoa)
app.post('/api/admin/limpar-tentativas', h(async (req, res) => {
  const tok = String(req.query.token || '');
  if (!ADMIN_TOKEN || tok.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) return erro(res, 'Não autorizado.', 401);
  if (req.query.confirmar !== 'APAGAR') return erro(res, 'Confirme com &confirmar=APAGAR.');
  const cpf = String(req.query.cpf || '').replace(/\D/g, '');
  const { rows } = cpf
    ? await pool.query('DELETE FROM tentativas t USING alunos a WHERE t.aluno_id = a.id AND a.cpf = $1 RETURNING t.simulado', [cpf])
    : await pool.query('DELETE FROM tentativas RETURNING simulado');
  const porSim = rows.reduce((m, r) => ({ ...m, [r.simulado]: (m[r.simulado] || 0) + 1 }), {});
  res.json({ apagadas: rows.length, porSimulado: porSim });
}));

// ----- páginas -----
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, p) => res.setHeader('Cache-Control', p.endsWith('.html') ? 'no-store' : 'public, max-age=3600'),
}));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return erro(res, 'Requisição inválida.');
  console.error(err);
  erro(res, 'Erro interno. Tente novamente.', 500);
});

init().then(() => app.listen(PORT, () => console.log(`Simulados rodando na porta ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
