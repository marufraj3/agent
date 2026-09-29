export const handoverReasons = [
  'customer_requested_human', 'ai_uncertain', 'repeated_failure', 'complaint',
  'refund_request', 'exchange_request', 'order_problem', 'payment_problem',
  'unavailable_product', 'complex_question', 'abusive_customer', 'other',
] as const;
export type HandoverReasonName = (typeof handoverReasons)[number];
export const handoverStatuses = ['pending', 'assigned', 'resolved', 'cancelled'] as const;
export type HandoverStatusName = (typeof handoverStatuses)[number];

export const reasonToPrisma = Object.fromEntries(
  handoverReasons.map((reason) => [reason, reason.toUpperCase()]),
) as Record<HandoverReasonName, string>;

export class HandoverError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) {
    super(message);
    this.name = 'HandoverError';
  }
}
