import Airtable from "airtable";

const base = new Airtable({
  apiKey: process.env.AIRTABLE_KEY
}).base(process.env.AIRTABLE_BASE);

export async function criarPedido(dados) {
  await base("Pagamentos").create({
    PagamentoId: dados.pagamentoId,
    Valor: dados.valor,
    Status: dados.status
  });
}

export async function atualizarStatus(pagamentoId, status) {
  const registros = await base("Pagamentos").select({
    filterByFormula: `{PagamentoId}='${pagamentoId}'`
  }).firstPage();

  if (registros.length > 0) {
    await base("Pagamentos").update(registros[0].id, {
      Status: status
    });
  }
}
