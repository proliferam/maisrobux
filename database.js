import Airtable from "airtable";

const base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY
}).base(process.env.AIRTABLE_BASE);

// ================================================================
// 📦 PAGAMENTOS
// ================================================================
export async function criarPedido(dados) {
  return await base("Pagamentos").create({
    PagamentoId: dados.pagamentoId,
    DiscordId: dados.discordId,
    DiscordTag: dados.discordTag,
    RobloxUser: dados.robloxUser,
    RobloxId: dados.robloxId,
    Valor: dados.valor,
    Robux: dados.robux,
    Status: dados.status,
    Cupom: dados.cupom || null,
    Afiliado: dados.afiliado || null,
    AfiliadoId: dados.afiliadoId || null,
    ComissaoAfiliado: dados.comissaoAfiliado || 0,
    Data: new Date().toISOString(),
    Metodo: dados.metodo || "PIX",
    GamepassId: dados.gamepassId || null,
    GamepassValor: dados.gamepassValor || null
  });
}

export async function atualizarStatus(pagamentoId, status) {
  const registros = await base("Pagamentos").select({
    filterByFormula: `{PagamentoId}='${pagamentoId}'`
  }).firstPage();

  if (registros.length > 0) {
    return await base("Pagamentos").update(registros[0].id, {
      Status: status,
      DataAtualizacao: new Date().toISOString()
    });
  }
  return null;
}

export async function buscarPedidoPorPagamentoId(pagamentoId) {
  const registros = await base("Pagamentos").select({
    filterByFormula: `{PagamentoId}='${pagamentoId}'`
  }).firstPage();

  return registros.length > 0 ? registros[0] : null;
}

export async function buscarPedidosPorDiscordId(discordId) {
  const registros = await base("Pagamentos").select({
    filterByFormula: `{DiscordId}='${discordId}'`,
    sort: [{ field: "Data", direction: "desc" }]
  }).firstPage();

  return registros.map(r => ({ id: r.id, ...r.fields }));
}

// ================================================================
// 👥 AFILIADOS
// ================================================================
export async function criarAfiliado(dados) {
  return await base("Afiliados").create({
    DiscordId: dados.discordId,
    DiscordTag: dados.discordTag,
    Cargo: dados.cargo || "Afiliado",
    Cupom: dados.cupom,
    Comissao: dados.comissao || 15,
    VendasTotais: 0,
    ValorTotal: 0,
    ComissaoTotal: 0,
    ComissaoPaga: 0,
    ComissaoPendente: 0,
    DataCadastro: new Date().toISOString(),
    Ativo: true
  });
}

export async function buscarAfiliadoPorCupom(cupom) {
  const registros = await base("Afiliados").select({
    filterByFormula: `AND({Cupom}='${cupom}', {Ativo}=TRUE())`
  }).firstPage();

  return registros.length > 0 ? registros[0] : null;
}

export async function buscarAfiliadoPorId(discordId) {
  const registros = await base("Afiliados").select({
    filterByFormula: `{DiscordId}='${discordId}'`
  }).firstPage();

  return registros.length > 0 ? registros[0] : null;
}

export async function atualizarEstatisticasAfiliado(discordId, valorVenda) {
  const afiliado = await buscarAfiliadoPorId(discordId);
  if (!afiliado) return null;

  const comissao = afiliado.fields.Comissao || 15;
  const comissaoValor = (valorVenda * comissao) / 100;

  return await base("Afiliados").update(afiliado.id, {
    VendasTotais: (afiliado.fields.VendasTotais || 0) + 1,
    ValorTotal: (afiliado.fields.ValorTotal || 0) + valorVenda,
    ComissaoTotal: (afiliado.fields.ComissaoTotal || 0) + comissaoValor,
    ComissaoPendente: (afiliado.fields.ComissaoPendente || 0) + comissaoValor,
    UltimaVenda: new Date().toISOString()
  });
}

export async function listarAfiliados() {
  const registros = await base("Afiliados").select({
    sort: [{ field: "ValorTotal", direction: "desc" }]
  }).firstPage();

  return registros.map(r => ({ id: r.id, ...r.fields }));
}

export async function atualizarComissaoPaga(discordId, valor) {
  const afiliado = await buscarAfiliadoPorId(discordId);
  if (!afiliado) return null;

  return await base("Afiliados").update(afiliado.id, {
    ComissaoPaga: (afiliado.fields.ComissaoPaga || 0) + valor,
    ComissaoPendente: (afiliado.fields.ComissaoPendente || 0) - valor
  });
}

// ================================================================
// 🎫 CUPONS
// ================================================================
export async function criarCupom(dados) {
  return await base("Cupons").create({
    Codigo: dados.codigo,
    Tipo: dados.tipo || "Percentual",
    Valor: dados.valor,
    UsosMaximos: dados.usosMaximos || 100,
    UsosAtuais: 0,
    Validade: dados.validade,
    Ativo: true,
    CriadoPor: dados.criadoPor,
    DataCriacao: new Date().toISOString()
  });
}

export async function buscarCupom(codigo) {
  const registros = await base("Cupons").select({
    filterByFormula: `AND({Codigo}='${codigo}', {Ativo}=TRUE())`
  }).firstPage();

  return registros.length > 0 ? registros[0] : null;
}

export async function registrarUsoCupom(codigo) {
  const cupom = await buscarCupom(codigo);
  if (!cupom) return null;

  const usosAtuais = (cupom.fields.UsosAtuais || 0) + 1;
  
  return await base("Cupons").update(cupom.id, {
    UsosAtuais: usosAtuais,
    Ativo: usosAtuais < (cupom.fields.UsosMaximos || 100)
  });
}

// ================================================================
// 📊 ESTATÍSTICAS
// ================================================================
export async function obterEstatisticas() {
  const hoje = new Date();
  const mesAtual = hoje.getMonth() + 1;
  const anoAtual = hoje.getFullYear();

  // Total de vendas
  const vendas = await base("Pagamentos").select({
    filterByFormula: "OR({Status}='Pago', {Status}='Entregue')"
  }).all();

  const totalVendas = vendas.length;
  const valorTotal = vendas.reduce((sum, v) => sum + (v.fields.Valor || 0), 0);

  // Vendas deste mês
  const vendasMes = vendas.filter(v => {
    const data = new Date(v.fields.Data);
    return data.getMonth() + 1 === mesAtual && data.getFullYear() === anoAtual;
  });

  const totalVendasMes = vendasMes.length;
  const valorTotalMes = vendasMes.reduce((sum, v) => sum + (v.fields.Valor || 0), 0);

  // Afiliados ativos
  const afiliados = await base("Afiliados").select({
    filterByFormula: "{Ativo}=TRUE()"
  }).all();

  return {
    totalVendas,
    valorTotal: parseFloat(valorTotal.toFixed(2)),
    totalVendasMes,
    valorTotalMes: parseFloat(valorTotalMes.toFixed(2)),
    ticketMedio: totalVendas > 0 ? parseFloat((valorTotal / totalVendas).toFixed(2)) : 0,
    afiliadosAtivos: afiliados.length
  };
}

export async function obterEstatisticasPorCargo() {
  const afiliados = await listarAfiliados();
  const porCargo = {};

  afiliados.forEach(af => {
    const cargo = af.Cargo || "Afiliado";
    if (!porCargo[cargo]) {
      porCargo[cargo] = {
        quantidade: 0,
        vendas: 0,
        valor: 0,
        comissao: 0
      };
    }

    porCargo[cargo].quantidade++;
    porCargo[cargo].vendas += af.VendasTotais || 0;
    porCargo[cargo].valor += af.ValorTotal || 0;
    porCargo[cargo].comissao += af.ComissaoTotal || 0;
  });

  return porCargo;
}

export async function obterComissoesMensais(mes, ano) {
  const afiliados = await listarAfiliados();
  const comissoes = [];

  for (const af of afiliados) {
    if (af.ComissaoPendente > 0) {
      comissoes.push({
        discordId: af.DiscordId,
        discordTag: af.DiscordTag,
        cargo: af.Cargo,
        comissaoPendente: af.ComissaoPendente || 0,
        vendasTotais: af.VendasTotais || 0,
        valorTotal: af.ValorTotal || 0
      });
    }
  }

  return comissoes;
}
