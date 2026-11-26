const CARRIER_TRACKING_URL = "https://carrier.example.com/track";

// The tracking link in the "your order has shipped" email.
export function trackingUrl(order) {
  return `${CARRIER_TRACKING_URL}/${order.id}`;
}
