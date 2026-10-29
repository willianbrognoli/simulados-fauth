'use strict';
// já logado? vai direto para o painel
api('/api/me', { semRedirect: true }).then(() => location.replace('/painel')).catch(() => {});

estrelas($('.stars'), 26);

// abas Entrar / Criar conta
const tabs = $('.tabs');
$$('.tab').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tab;
  tabs.classList.toggle('criar', t === 'criar');
  $$('.tab').forEach(x => x.classList.toggle('on', x === b));
  $$('.form').forEach(f => f.classList.toggle('on', f.id === 'f-' + t));
}));

// máscara + validação do CPF em tempo real
$$('input[name=cpf]').forEach(inp => {
  const lb = inp.closest('label'), dica = $('.dica-campo', lb);
  inp.addEventListener('input', () => {
    inp.value = mascaraCPF(inp.value);
    const d = inp.value.replace(/\D/g, '');
    lb.classList.remove('valido', 'invalido');
    dica.textContent = '';
    if (d.length === 11) {
      const ok = cpfValido(d);
      lb.classList.add(ok ? 'valido' : 'invalido');
      dica.textContent = ok ? '✓ CPF válido' : 'CPF inválido, confira os números';
    }
  });
});
$('input[name=whatsapp]').addEventListener('input', e => { e.target.value = mascaraTel(e.target.value); });

function enviar(form, url, validar) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const dados = Object.fromEntries(new FormData(form));
    const msg = validar(dados);
    if (msg) return toast(msg, 'erro');
    btn.disabled = true;
    try {
      await api(url, { method: 'POST', body: dados, semRedirect: true });
      toast('Tudo certo! Entrando…', 'ok');
      setTimeout(() => location.href = '/painel', 450);
    } catch (er) {
      toast(er.message, 'erro');
      btn.disabled = false;
    }
  });
}

enviar($('#f-entrar'), '/api/login', d => {
  if (!cpfValido(d.cpf)) return 'Digite um CPF válido.';
  if (!d.senha) return 'Digite sua senha.';
  return null;
});

// esqueci minha senha: o Firebase manda o link para o e-mail do cadastro
const mostrarForm = id => $$('.form').forEach(f => f.classList.toggle('on', f.id === id));
$('#bt-esqueci').addEventListener('click', () => {
  const cpf = $('#f-entrar input[name=cpf]').value;
  if (cpf) { const i = $('#f-esqueci input[name=cpf]'); i.value = cpf; i.dispatchEvent(new Event('input')); }
  mostrarForm('f-esqueci');
});
$('#bt-voltar').addEventListener('click', () => mostrarForm('f-entrar'));
$('#f-esqueci').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target, btn = $('button[type=submit]', form);
  const cpf = $('input[name=cpf]', form).value;
  if (!cpfValido(cpf)) return toast('Digite um CPF válido.', 'erro');
  btn.disabled = true;
  try {
    const r = await api('/api/senha/esqueci', { method: 'POST', body: { cpf }, semRedirect: true });
    toast(r.msg, 'ok');
    setTimeout(() => mostrarForm('f-entrar'), 2500);
  } catch (er) {
    toast(er.message, 'erro');
  }
  btn.disabled = false;
});

enviar($('#f-criar'), '/api/cadastro', d => {
  if ((d.nome || '').trim().split(/\s+/).length < 2) return 'Informe nome e sobrenome.';
  if (!cpfValido(d.cpf)) return 'CPF inválido. Confira os números.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email || '')) return 'E-mail inválido.';
  if ((d.whatsapp || '').replace(/\D/g, '').length < 10) return 'Informe o WhatsApp com DDD.';
  if ((d.senha || '').length < 6) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (!d.lgpd) return 'Marque a concordância com o uso dos dados.';
  delete d.lgpd;
  return null;
});
