// What the account page shows. An account is past due when a renewal charge
// failed, for example because the card on file expired.
export function accountSummary(account) {
  return {
    plan: account.plan,
    standing: account.balance_due > 0 ? "past_due" : "good",
    balance_due: account.balance_due,
    card_on_file: account.card_on_file ?? "valid",
  };
}
