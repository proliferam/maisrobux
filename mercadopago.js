import { MercadoPagoConfig, Payment } from "mercadopago";

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const payment = new Payment(client);

export async function criarPagamento(valor, descricao) {
  const res = await payment.create({
    body: {
      transaction_amount: valor,
      description: descricao,
      payment_method_id: "pix",
      payer: {
        email: "cliente@discord.com"
      }
    }
  });

  return {
    id: res.id,
    qrCode: res.point_of_interaction.transaction_data.qr_code,
    qrCodeBase64:
      res.point_of_interaction.transaction_data.qr_code_base64
  };
}

export async function buscarPagamento(id) {
  return await payment.get({ id });
}
