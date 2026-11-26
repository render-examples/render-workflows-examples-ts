// Charges an order through the payment provider.
//
// `charges` is the list of charges already made, and `provider` sends a new
// charge. The checkout page calls chargeOrder again if the customer's browser
// retries the request.
export async function chargeOrder(order, charges, provider) {
  const charge = await provider.charge({
    orderId: order.id,
    amount: order.amount,
    idempotencyKey: `order-${order.id}`,
  });
  charges.push(charge);
  return charge;
}
