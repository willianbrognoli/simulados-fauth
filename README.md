# Simulado INSS · Prof.ª Adriane Fauth

Sistema fechado de simulado (padrão Cebraspe, certo/errado) com login por CPF, 1 tentativa a cada 24 h,
prova de 3 h, anti-cola, gamificação (nível/XP, medalhas, plano de estudo por tema) e ranking geral.

Stack: Node 20 + Express + PostgreSQL. Sem build de front-end: as telas ficam em `public/`.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `server.js` | API, sessão (cookie HttpOnly assinado), regras da prova, ranking, exportação CSV |
| `db.js` | Conexão e criação automática das tabelas `alunos` e `tentativas` |
| `questoes.js` | Os 80 itens (10 CF + 70 Previdenciário), gabarito, comentário e dicas por tema |
| `public/index.html` | Login / cadastro (validação de CPF pelos dígitos verificadores) |
| `public/painel.html` | Painel do aluno: iniciar prova, contagem para a próxima, desempenho, medalhas, ranking, histórico |
| `public/prova.html` | Prova em tela cheia com cronômetro, mapa de itens e vigilância anti-cola |
| `public/resultado.html` | Nota, desempenho por tema, plano de estudo e gabarito comentado |

## Deploy no Easypanel

1. **GitHub**: crie um repositório **privado** (ex.: `simulado-inss-fauth`) e suba esta pasta.
2. **Postgres**: no projeto do Easypanel, `+ Service` → **Postgres** (ex.: `postgres-simulado`).
   Anote a *Internal Connection URL* (algo como `postgres://postgres:SENHA@PROJETO_postgres-simulado:5432/PROJETO`).
3. **App**: `+ Service` → **App** (ex.: `simulado-inss`).
   - Source: GitHub → o repositório criado, branch `main`.
   - Build: **Dockerfile**.
   - Environment:
     ```
     DATABASE_URL=postgres://postgres:SENHA@PROJETO_postgres-simulado:5432/PROJETO
     SESSION_SECRET=<cole aqui 64 caracteres aleatórios>
     ADMIN_TOKEN=<outro texto aleatório longo, para baixar a lista de alunos>
     NODE_ENV=production
     PORT=3000
     ```
   - Deploy. As tabelas são criadas sozinhas na primeira subida.
4. **Domínio**: em *Domains* do App, adicione o subdomínio (ex.: `simulado.adrianefauth.com.br`) apontando para a porta `3000`.
   No DNS do domínio, crie um registro **A** do subdomínio para o IP da VPS. O HTTPS sai automático.
5. Teste: `https://SEU-SUBDOMINIO/health` deve responder `{"ok":true}`.

Para gerar o `SESSION_SECRET` no PowerShell:
```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | % {[char]$_})
```

## Lista de alunos (leads)

`https://SEU-SUBDOMINIO/api/admin/alunos.csv?token=SEU_ADMIN_TOKEN` baixa um CSV com nome, CPF, e-mail,
WhatsApp, data de cadastro, provas feitas e melhor nota (abre direto no Excel).

## Regras implementadas

- **CPF**: validado pelos dígitos verificadores (no navegador e no servidor), sem custo e sem consulta à Receita. Um CPF = uma conta.
- **1 tentativa a cada 24 h**, contadas a partir do início da última. Controlado no servidor.
- **3 horas**: o prazo é gravado no banco ao iniciar; se o aluno fechar a página, o tempo continua e a prova é entregue sozinha.
- **Respostas salvas a cada clique**: se a internet cair ou o aluno recarregar, ele retoma de onde parou.
- **Gabarito nunca vai para o navegador durante a prova**: só aparece no resultado.
- **Anti-cola**: tela cheia obrigatória; bloqueio de copiar, colar, selecionar, botão direito, imprimir e atalhos de inspeção;
  marca d'água com nome e CPF; tela borrada ao sair; troca de aba, minimizar, sair da tela cheia, fechar ou recarregar contam como saída;
  **na 3ª saída a prova é entregue**. Todas as saídas ficam registradas com data e tipo (coluna `eventos`).
- **Correção Cebraspe**: nota líquida = certos − errados; em branco não conta.
- **Ranking**: oficial pela 1ª tentativa de cada aluno (desempate pelo menor tempo); há também a visão "melhor nota".
  No ranking aparece só o primeiro nome e a inicial do sobrenome.

## Limites honestos

Nenhum sistema web impede o aluno de consultar um **segundo aparelho** (celular ao lado). O que o sistema faz é detectar e punir
saídas da tela e dificultar cópia e prints. Como os itens são inéditos, eles não aparecem prontos em buscadores.
No iPhone o navegador não permite tela cheia em páginas; nele a vigilância continua por troca de aba e saída do app.

## Como trocar ou ampliar as questões

Edite `questoes.js`. Cada item tem `id` único, `tema` (precisa existir em `TEMAS`), `gabarito` (`'C'` ou `'E'`),
`texto` e `comentario`. Itens de Direito Constitucional aparecem primeiro na prova, depois os de Previdenciário,
com ordem sorteada dentro de cada bloco a cada tentativa. Depois de editar, faça commit e o Easypanel publica de novo.


## Atualização de 29/10/2026: Simulados 1 e 2 + login pelo Firebase

- **Dois simulados** (`simulados.js`), cada um com 40 itens: metade do arquivo de Constitucional
  (bloco 1, sempre primeiro) e metade do Previdenciário (bloco 2). Simulado 1 = CF 1-5 + PREV 1-35;
  Simulado 2 = CF 6-10 + PREV 36-70. Os 80 itens dos arquivos da professora estão em uso.
  Duração 1h30 cada (2:15 por item). Correções de 29/10 com base na legislação: PREV 8, 23, 31, 32,
  49, 63, 64, 70. PREV 63 marcado para revisão da professora (`revisar: true`).
- **Regras por simulado:** 1 tentativa a cada 24 h por simulado (o aluno pode fazer os dois no mesmo
  dia), uma prova aberta por vez, ranking e histórico separados. O simulado antigo de 80 itens
  (`questoes.js`, tentativas com `simulado = 'inss80'`) saiu da tela e ficou guardado no banco.
- **Retorno por faixa de acertos** no resultado (avançado ≥ 90%, intermediário ≥ 70%, básico ≥ 50%,
  iniciante abaixo).
- **Login pelo Firebase Authentication** (projeto `simulados-fauth`, provedor E-mail/senha), chamado
  pelo servidor pela API REST (o navegador não carrega SDK externo). O aluno entra com **CPF + senha**:
  o servidor acha o e-mail do CPF e o Firebase confere a senha. O cadastro cria a conta no Firebase e
  envia e-mail de confirmação; "Esqueci minha senha" envia o link de redefinição.
  Contas antigas (senha no nosso banco) migram sozinhas para o Firebase no primeiro login.
- **Env novas (opcionais):** `FIREBASE_API_KEY` (padrão: chave pública do app `simulados-web`) e
  `SITE_URL` (padrão `https://simulados.adrianefauth.com.br`, usado nos links dos e-mails).
- Banco: colunas novas `alunos.firebase_uid` e `tentativas.simulado` (criadas sozinhas ao subir).
