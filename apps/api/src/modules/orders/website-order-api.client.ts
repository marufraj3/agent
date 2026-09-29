import type { BusinessSettings } from '../admin/settings.service.js';

export interface WebsiteOrderPayloadItem {
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  websiteProductId: number;
  websiteVariationId: number;
  variationSize: string;
}

export interface WebsiteOrderSubmission {
  submissionReference: string;
  totalQuantity: number;
  subtotal: string;
  deliveryCharge: string;
  customer: { name: string; phone: string; address: string };
  items: WebsiteOrderPayloadItem[];
}

export interface WebsiteOrderResult {
  success: true;
  orderId: string;
  message: string;
  rawResponse: Record<string, unknown>;
}

export class WebsiteOrderApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcomeKnown: boolean,
    readonly safeDetails?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WebsiteOrderApiError';
  }
}

export class WebsiteOrderApiClient {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildPayload(order: WebsiteOrderSubmission, settings: BusinessSettings) {
    return {
      count: order.totalQuantity,
      subtotal: Number(order.subtotal),
      order_details: order.items.map((item) => ({
        qty: item.quantity,
        options: {
          sub_total: Number(item.unitPrice),
          product_id: item.websiteProductId,
          product_size: item.variationSize,
          product_size_id: item.websiteVariationId,
        },
        subtotal: Number(item.lineTotal),
      })),
      order_additional: {
        name: order.customer.name,
        phone: order.customer.phone,
        address: order.customer.address,
        page_id: Number(settings.pageId),
        password: order.customer.phone,
        utm_source: settings.utmSource,
        utm_campaign: settings.utmCampaign,
        delevary_company: Number(settings.deliveryCompanyId),
        delivery_charge_location: Number(order.deliveryCharge),
      },
    };
  }

  async submit(
    order: WebsiteOrderSubmission,
    settings: BusinessSettings,
  ): Promise<WebsiteOrderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const baseUrl = settings.websiteApiBaseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/page/order/request`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-submission-reference': order.submissionReference,
        },
        body: JSON.stringify(this.buildPayload(order, settings)),
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new WebsiteOrderApiError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Website order request timed out'
          : 'Website order request failed',
        error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        false,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new WebsiteOrderApiError(
          'Website order request timed out',
          'TIMEOUT',
          false,
          { httpStatus: response.status },
        );
      }
      if (!response.ok) {
        throw new WebsiteOrderApiError(
          'Website order API rejected the request',
          `HTTP_${response.status}`,
          response.status >= 400 && response.status < 500,
          { httpStatus: response.status },
        );
      }
      throw new WebsiteOrderApiError(
        'Website order API returned malformed JSON',
        'MALFORMED_RESPONSE',
        false,
        { httpStatus: response.status },
      );
    }
    clearTimeout(timeout);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new WebsiteOrderApiError(
        'Website order API returned a malformed response',
        'MALFORMED_RESPONSE',
        false,
        { httpStatus: response.status },
      );
    }
    const record = body as Record<string, unknown>;
    if (!response.ok) {
      throw new WebsiteOrderApiError(
        'Website order API rejected the request',
        `HTTP_${response.status}`,
        response.status >= 400 && response.status < 500,
        { httpStatus: response.status, message: typeof record.message === 'string' ? record.message : undefined },
      );
    }

    const successful = Number(record.status) === 200;
    if (!successful) {
      throw new WebsiteOrderApiError(
        'Website order API did not accept the order',
        'API_VALIDATION_ERROR',
        true,
        { httpStatus: response.status, message: typeof record.message === 'string' ? record.message : undefined },
      );
    }
    const code = Array.isArray(record.code) ? record.code[0] : record.code;
    if (typeof code !== 'string' && typeof code !== 'number') {
      throw new WebsiteOrderApiError(
        'Website order API success response omitted the external order ID',
        'MALFORMED_RESPONSE',
        false,
        { httpStatus: response.status },
      );
    }
    return {
      success: true,
      orderId: String(code),
      message: typeof record.message === 'string' ? record.message : 'Order created successfully',
      rawResponse: record,
    };
  }
}
