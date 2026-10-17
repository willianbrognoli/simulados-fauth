// carregado no <head> (síncrono) para aplicar o tema antes de pintar a página; padrão: claro
try {
  if (localStorage.getItem('tema') === 'escuro') document.documentElement.dataset.tema = 'escuro';
} catch (e) {}
