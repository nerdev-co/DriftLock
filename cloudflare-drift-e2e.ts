export function createTestCharge(input: { payment_method: string }) {
    return {
        amount: 2000,
        currency: "usd",
        payment_method: input.payment_method,
        status: "pending",
    };
}