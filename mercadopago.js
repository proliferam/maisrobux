import { MercadoPagoConfig, Payment, Preference } from "mercadopago";

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const payment = new Payment(client);
const preference = new Preference(client);

// ================================================================
// 💳 CRIAR PAGAMENTO PIX
// ================================================================
export async function criarPagamentoPix(dados) {
  try {
    const response = await payment.create({
      body: {
        transaction_amount: dados.valor,
        description: dados.descricao,
        payment_method_id: "pix",
        payer: {
          email: dados.email || "cliente@discord.com",
          first_name: dados.nome || "Cliente",
          identification: {
            type: "CPF",
            number: "12345678909" // CPF genérico, pode ajustar conforme necessidade
          }
        },
        external_reference: dados.externalReference,
        notification_url: `${process.env.WEBHOOK_URL}/mercadopago-webhook`,
        statement_descriptor: "ROBUXSTORE",
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutos
      }
    });

    return {
      id: response.id,
      status: response.status,
      qrCode: response.point_of_interaction?.transaction_data?.qr_code,
      qrCodeBase64: response.point_of_interaction?.transaction_data?.qr_code_base64,
      ticketUrl: response.point_of_interaction?.transaction_data?.ticket_url,
      pixCopiaCola: response.point_of_interaction?.transaction_data?.qr_code,
      dataExpiracao: response.date_of_expiration
    };
  } catch (error) {
    console.error("Erro ao criar pagamento PIX:", error);
    throw error;
  }
}

// ================================================================
// 🔄 CRIAR PREFERÊNCIA (PARA LINK DE PAGAMENTO)
// ================================================================
export async function criarPreferenciaPix(dados) {
  try {
    const response = await preference.create({
      body: {
        items: [
          {
            title: dados.titulo,
            quantity: 1,
            currency_id: "BRL",
            unit_price: dados.valor
          }
        ],
        payer: {
          email: dados.email,
          first_name: dados.nome
        },
        payment_methods: {
          excluded_payment_types: [
            { id: "credit_card" },
            { id: "debit_card" },
            { id: "atm" },
            { id: "ticket" },
            { id: "bank_transfer" }
          ],
          default_payment_method_id: "pix",
          installments: 1
        },
        external_reference: dados.externalReference,
        notification_url: `${process.env.WEBHOOK_URL}/mercadopago-webhook`,
        statement_descriptor: "ROBUX STORE",
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      }
    });

    return {
      id: response.id,
      init_point: response.init_point,
      sandbox_init_point: response.sandbox_init_point,
      preferenceId: response.id
    };
  } catch (error) {
    console.error("Erro ao criar preferência:", error);
    throw error;
  }
}

// ================================================================
// 🔍 BUSCAR PAGAMENTO
// ================================================================
export async function buscarPagamento(id) {
  try {
    const paymentData = await payment.get({ id });
    
    return {
      id: paymentData.id,
      status: paymentData.status,
      status_detail: paymentData.status_detail,
      transaction_amount: paymentData.transaction_amount,
      external_reference: paymentData.external_reference,
      date_created: paymentData.date_created,
      date_approved: paymentData.date_approved,
      date_last_updated: paymentData.date_last_updated,
      payment_method_id: paymentData.payment_method_id,
      payment_type_id: paymentData.payment_type_id,
      currency_id: paymentData.currency_id,
      description: paymentData.description,
      payer: paymentData.payer
    };
  } catch (error) {
    console.error("Erro ao buscar pagamento:", error);
    return null;
  }
}

// ================================================================
// 📋 VERIFICAR PAGAMENTOS PENDENTES
// ================================================================
export async function verificarPagamentosPendentes() {
  try {
    // Buscar pagamentos criados nas últimas 2 horas
    const duasHorasAtras = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    const filters = {
      range: "date_created",
      begin_date: duasHorasAtras.toISOString(),
      end_date: new Date().toISOString(),
      status: "pending"
    };

    // Nota: A API do Mercado Pago pode ter limitações
    // Em produção, você deve manter um registro local dos pagamentos
    const payments = await payment.search({
      options: {
        filters: filters,
        limit: 50
      }
    });

    return payments.results || [];
  } catch (error) {
    console.error("Erro ao verificar pagamentos pendentes:", error);
    return [];
  }
}

// ================================================================
// ❌ CANCELAR PAGAMENTO
// ================================================================
export async function cancelarPagamento(id) {
  try {
    const response = await payment.cancel({ id });
    return {
      success: true,
      status: response.status,
      message: "Pagamento cancelado com sucesso"
    };
  } catch (error) {
    console.error("Erro ao cancelar pagamento:", error);
    return {
      success: false,
      message: error.message
    };
  }
}
