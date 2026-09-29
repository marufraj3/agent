export const openOrderStatuses = [
  'DRAFT',
  'AWAITING_INFORMATION',
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
] as const;

export type OrderStatusName =
  | 'DRAFT'
  | 'AWAITING_INFORMATION'
  | 'AWAITING_CONFIRMATION'
  | 'CONFIRMED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
export type ConfirmationStatusName = 'PENDING' | 'CONFIRMED' | 'REJECTED';
export type DeliveryLocationName = 'DHAKA' | 'OUTSIDE_DHAKA';
export type OrderSourceName = 'AI' | 'TEST' | 'MESSENGER' | 'WEB';
export type SubmissionResultName =
  | 'NOT_ATTEMPTED'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'KNOWN_FAILURE'
  | 'UNKNOWN';

export interface OrderCustomerSnapshot {
  name: string | null;
  phone: string | null;
  address: string | null;
}

export interface OrderDraftContext {
  productIds?: number[];
  size?: string | null;
  quantity?: number | null;
  requestedField?: 'product' | 'size' | 'quantity' | 'name' | 'phone' | 'address' | 'location';
}

export interface OrderValidationIssue {
  code: string;
  message: string;
  itemId?: string;
}

export class OrderEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'OrderEngineError';
  }
}
