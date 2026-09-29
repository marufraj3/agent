import { Prisma, type PrismaClient } from '@alzeena/database';
import { SettingsService, type BusinessSettings } from '../admin/settings.service.js';
import { isKnownActiveProductStatus, isVariationOrderable } from '../products/product-catalog.service.js';
import {
  openOrderStatuses,
  OrderEngineError,
  type DeliveryLocationName,
  type OrderCustomerSnapshot,
  type OrderDraftContext,
  type OrderSourceName,
  type OrderStatusName,
  type OrderValidationIssue,
} from './order.types.js';
import { getEffectiveProductPrice, money, normalizeBangladeshPhone } from './order-utils.js';
import {
  WebsiteOrderApiClient,
  WebsiteOrderApiError,
  type WebsiteOrderSubmission,
} from './website-order-api.client.js';

const transitions: Record<OrderStatusName, OrderStatusName[]> = {
  DRAFT: ['AWAITING_INFORMATION', 'AWAITING_CONFIRMATION', 'ABANDONED', 'CANCELLED'],
  AWAITING_INFORMATION: ['DRAFT', 'AWAITING_CONFIRMATION', 'ABANDONED', 'CANCELLED'],
  AWAITING_CONFIRMATION: ['AWAITING_INFORMATION', 'CONFIRMED', 'ABANDONED', 'CANCELLED'],
  CONFIRMED: ['AWAITING_CONFIRMATION', 'SUBMITTED', 'FAILED'],
  SUBMITTED: ['COMPLETED'],
  COMPLETED: [],
  FAILED: ['CONFIRMED', 'CANCELLED'],
  ABANDONED: ['AWAITING_INFORMATION', 'EXPIRED', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: [],
  RETURNED: [],
};

interface CreateDraftOrderInput {
  customerId: string;
  conversationId: string;
  source?: OrderSourceName;
  customer?: Partial<OrderCustomerSnapshot>;
  draftContext?: OrderDraftContext;
}

interface AddOrderItemInput {
  websiteProductId: number;
  size?: string;
  websiteVariationId?: number;
  quantity: number;
}

interface OrderLogger {
  warn?(bindings: object, message?: string): void;
}

export class OrderService {
  private readonly db: any;
  private readonly settings: SettingsService;

  constructor(
    prisma: PrismaClient,
    private readonly website: WebsiteOrderApiClient,
    private readonly logger: OrderLogger = {},
  ) {
    this.db = prisma as any;
    this.settings = new SettingsService(prisma);
  }

  async createDraftOrder(input: CreateDraftOrderInput) {
    const existing = await this.getActiveOrderForConversation(input.conversationId);
    if (existing) return existing;
    const customer = await this.db.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new OrderEngineError('Customer not found', 'CUSTOMER_NOT_FOUND', 404);
    const snapshot: OrderCustomerSnapshot = {
      name: input.customer?.name?.trim() || customer.name || null,
      phone: input.customer?.phone ? normalizeBangladeshPhone(input.customer.phone) : customer.phone || null,
      address: input.customer?.address?.trim() || customer.address || null,
    };
    try {
      return await this.db.$transaction(async (tx: any) => {
        const order = await tx.order.create({
          data: {
            customerId: input.customerId,
            conversationId: input.conversationId,
            source: input.source ?? 'AI',
            customerSnapshot: snapshot,
            draftContext: input.draftContext ?? {},
          },
          include: { items: true },
        });
        await this.log(tx, 'ORDER_DRAFT_CREATED', order.id, { source: order.source });
        return order;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const concurrent = await this.getActiveOrderForConversation(input.conversationId);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  getOrder(id: string) {
    return this.db.order.findUnique({
      where: { id },
      include: { items: true, customer: true, conversation: true },
    });
  }

  getOrderById(id: string) {
    return this.getOrder(id);
  }

  getOrderByExternalId(externalOrderId: string) {
    return this.db.order.findUnique({
      where: { externalOrderId },
      include: { items: true, customer: true, conversation: true },
    });
  }

  getRecentOrdersForCustomer(customerId: string, limit = 10) {
    return this.db.order.findMany({ where: { customerId }, include: { items: true }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 20) });
  }

  getActiveOrderForConversation(conversationId: string) {
    return this.db.order.findFirst({
      where: { conversationId, status: { in: [...openOrderStatuses] } },
      include: { items: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async markOrderAbandoned(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order || !['DRAFT','AWAITING_INFORMATION','AWAITING_CONFIRMATION'].includes(order.status)) return order;
    await this.transitionOrder(orderId, 'ABANDONED');
    return this.getOrder(orderId);
  }

  async resumeAbandonedOrder(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order || order.status !== 'ABANDONED') return order;
    await this.transitionOrder(orderId, 'AWAITING_INFORMATION');
    return this.getOrder(orderId);
  }

  async addOrderItem(orderId: string, input: AddOrderItemInput) {
    this.assertQuantity(input.quantity);
    const order = await this.requireMutableOrder(orderId);
    const resolved = await this.resolveCurrentItem(input);
    const existing = order.items.find((item: any) => item.variationId === resolved.variation.id);
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    this.assertStock(resolved.product, resolved.variation, quantity);
    const unitPrice = getEffectiveProductPrice(resolved.product);
    const businessSettings = await this.settings.getBusinessSettings();

    await this.db.$transaction(async (tx: any) => {
      if (existing) {
        await tx.orderItem.update({
          where: { id: existing.id },
          data: { quantity, unitPrice, lineTotal: unitPrice.mul(quantity) },
        });
      } else {
        await tx.orderItem.create({
          data: {
            orderId,
            productId: resolved.product.id,
            variationId: resolved.variation.id,
            websiteProductId: resolved.product.websiteProductId,
            websiteVariationId: resolved.variation.websiteVariationId,
            productName: resolved.product.productName,
            productCode: resolved.product.productCode,
            variationSize: resolved.variation.sizeName,
            quantity,
            unitPrice,
            lineTotal: unitPrice.mul(quantity),
          },
        });
      }
      await this.calculateOrderInTransaction(tx, orderId, businessSettings);
      await this.log(tx, 'ORDER_ITEM_ADDED', orderId, {
        websiteProductId: resolved.product.websiteProductId,
        websiteVariationId: resolved.variation.websiteVariationId,
        quantity,
      });
    });
    return this.getOrder(orderId);
  }

  async reopenForCorrection(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order || order.status !== 'AWAITING_CONFIRMATION') {
      throw new OrderEngineError('Order is not awaiting correction', 'ORDER_NOT_EDITABLE', 409);
    }
    await this.db.$transaction(async (tx: any) => {
      await tx.order.update({ where: { id: orderId }, data: { status: 'AWAITING_INFORMATION', confirmationStatus: 'NOT_REQUESTED', confirmationText: null, confirmedAt: null } });
      await this.log(tx, 'ORDER_REOPENED_FOR_CORRECTION', orderId, {});
    });
    return this.getOrder(orderId);
  }

  async updateOrderItem(orderId: string, itemId: string, quantity: number) {
    this.assertQuantity(quantity);
    await this.requireMutableOrder(orderId);
    const item = await this.db.orderItem.findFirst({ where: { id: itemId, orderId } });
    if (!item) throw new OrderEngineError('Order item not found', 'ORDER_ITEM_NOT_FOUND', 404);
    const resolved = await this.resolveCurrentItem({
      websiteProductId: item.websiteProductId,
      websiteVariationId: item.websiteVariationId,
      quantity,
    });
    this.assertStock(resolved.product, resolved.variation, quantity);
    const unitPrice = getEffectiveProductPrice(resolved.product);
    const businessSettings = await this.settings.getBusinessSettings();
    await this.db.$transaction(async (tx: any) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { quantity, unitPrice, lineTotal: unitPrice.mul(quantity) },
      });
      await this.calculateOrderInTransaction(tx, orderId, businessSettings);
      await this.log(tx, 'ORDER_ITEM_UPDATED', orderId, { itemId, quantity });
    });
    return this.getOrder(orderId);
  }

  async removeOrderItem(orderId: string, itemId: string) {
    await this.requireMutableOrder(orderId);
    const businessSettings = await this.settings.getBusinessSettings();
    await this.db.$transaction(async (tx: any) => {
      const deleted = await tx.orderItem.deleteMany({ where: { id: itemId, orderId } });
      if (deleted.count === 0) throw new OrderEngineError('Order item not found', 'ORDER_ITEM_NOT_FOUND', 404);
      await this.calculateOrderInTransaction(tx, orderId, businessSettings);
      await this.log(tx, 'ORDER_ITEM_REMOVED', orderId, { itemId });
    });
    return this.getOrder(orderId);
  }

  async updateCustomerInformation(
    orderId: string,
    input: Partial<OrderCustomerSnapshot>,
    updateCustomer = true,
  ) {
    const order = await this.requireMutableOrder(orderId);
    const previous = this.snapshot(order.customerSnapshot);
    const snapshot: OrderCustomerSnapshot = {
      name: input.name !== undefined ? input.name?.trim() || null : previous.name,
      phone:
        input.phone !== undefined
          ? input.phone
            ? normalizeBangladeshPhone(input.phone)
            : null
          : previous.phone,
      address: input.address !== undefined ? input.address?.trim() || null : previous.address,
    };
    await this.db.$transaction(async (tx: any) => {
      await tx.order.update({ where: { id: orderId }, data: { customerSnapshot: snapshot } });
      if (updateCustomer) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            ...(snapshot.name ? { name: snapshot.name } : {}),
            ...(snapshot.phone ? { phone: snapshot.phone } : {}),
            ...(snapshot.address ? { address: snapshot.address } : {}),
          },
        });
      }
      await this.log(tx, 'ORDER_CUSTOMER_INFORMATION_UPDATED', orderId, {
        fields: Object.keys(input),
      });
    });
    return this.getOrder(orderId);
  }

  async setDeliveryLocation(orderId: string, location: DeliveryLocationName) {
    await this.requireMutableOrder(orderId);
    await this.db.order.update({ where: { id: orderId }, data: { deliveryLocation: location } });
    return this.calculateOrder(orderId);
  }

  async updateDraftContext(orderId: string, context: OrderDraftContext) {
    await this.requireMutableOrder(orderId);
    return this.db.order.update({ where: { id: orderId }, data: { draftContext: context } });
  }

  async calculateOrder(orderId: string) {
    const businessSettings = await this.settings.getBusinessSettings();
    await this.db.$transaction((tx: any) => this.calculateOrderInTransaction(tx, orderId, businessSettings));
    return this.getOrder(orderId);
  }

  async validateOrder(orderId: string): Promise<OrderValidationIssue[]> {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    const issues: OrderValidationIssue[] = [];
    const customer = this.snapshot(order.customerSnapshot);
    if (!customer.name) issues.push({ code: 'MISSING_NAME', message: 'Customer name is required' });
    if (!customer.phone) issues.push({ code: 'MISSING_PHONE', message: 'Customer phone is required' });
    else {
      try { normalizeBangladeshPhone(customer.phone); } catch { issues.push({ code: 'INVALID_PHONE', message: 'Customer phone is invalid' }); }
    }
    if (!customer.address) issues.push({ code: 'MISSING_ADDRESS', message: 'Customer address is required' });
    if (!order.deliveryLocation) issues.push({ code: 'MISSING_DELIVERY_LOCATION', message: 'Delivery location is required' });
    if (order.items.length === 0) issues.push({ code: 'MISSING_ITEMS', message: 'At least one order item is required' });

    for (const item of order.items) {
      const product = await this.db.product.findUnique({
        where: { id: item.productId },
        include: { variations: { where: { id: item.variationId } } },
      });
      const variation = product?.variations[0];
      if (!product || !variation || !product.presentInFeed || !isKnownActiveProductStatus(product.productStatus) || !variation.active) {
        issues.push({ code: 'PRODUCT_UNAVAILABLE', message: `${item.productName} is unavailable`, itemId: item.id });
        continue;
      }
      if (!product.isPreOrder && variation.stockQuantity < item.quantity) {
        issues.push({ code: 'INSUFFICIENT_STOCK', message: `${item.productName} does not have enough stock`, itemId: item.id });
      }
      const currentPrice = getEffectiveProductPrice(product);
      if (!currentPrice.equals(item.unitPrice)) {
        issues.push({ code: 'PRICE_CHANGED', message: `${item.productName} price changed`, itemId: item.id });
      }
    }
    return issues;
  }

  async requestConfirmation(orderId: string) {
    const order = await this.requireMutableOrder(orderId);
    if (!['DRAFT', 'AWAITING_INFORMATION'].includes(order.status)) {
      throw new OrderEngineError('Order cannot request confirmation in its current state', 'INVALID_ORDER_TRANSITION');
    }
    await this.refreshItemPrices(orderId);
    await this.calculateOrder(orderId);
    const issues = await this.validateOrder(orderId);
    if (issues.length > 0) {
      await this.db.order.update({ where: { id: orderId }, data: { status: 'AWAITING_INFORMATION' } });
      await this.safeLog('ORDER_VALIDATION_FAILED', orderId, { issueCodes: issues.map((issue) => issue.code) });
      throw new OrderEngineError(issues[0]!.message, issues[0]!.code);
    }
    await this.db.$transaction(async (tx: any) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'AWAITING_CONFIRMATION',
          confirmationStatus: 'PENDING',
          confirmationText: null,
          confirmedAt: null,
        },
      });
      await this.log(tx, 'ORDER_CONFIRMATION_REQUESTED', orderId);
    });
    return this.getOrder(orderId);
  }

  async confirmOrder(orderId: string, confirmationText?: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (order.status !== 'AWAITING_CONFIRMATION' || order.confirmationStatus !== 'PENDING') {
      throw new OrderEngineError('Order is not awaiting confirmation', 'ORDER_NOT_AWAITING_CONFIRMATION');
    }
    const issues = await this.validateOrder(orderId);
    if (issues.length > 0) throw new OrderEngineError(issues[0]!.message, issues[0]!.code);
    await this.db.$transaction(async (tx: any) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'CONFIRMED',
          confirmationStatus: 'CONFIRMED',
          confirmationText: confirmationText?.trim().slice(0, 100) || null,
          confirmedAt: new Date(),
        },
      });
      await this.log(tx, 'ORDER_CONFIRMATION_RECEIVED', orderId);
    });
    return this.getOrder(orderId);
  }

  async cancelOrder(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (!['DRAFT', 'AWAITING_INFORMATION', 'AWAITING_CONFIRMATION', 'ABANDONED', 'FAILED'].includes(order.status)) {
      throw new OrderEngineError('Order cannot be cancelled in its current state', 'INVALID_ORDER_TRANSITION');
    }
    return this.db.$transaction(async (tx: any) => {
      const cancelled = await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED', confirmationStatus: 'REJECTED' },
      });
      await this.log(tx, 'ORDER_CANCELLED', orderId, { previousStatus: order.status });
      return cancelled;
    });
  }

  async transitionOrder(orderId: string, nextStatus: OrderStatusName) {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (!transitions[order.status as OrderStatusName]?.includes(nextStatus)) {
      throw new OrderEngineError(`Cannot transition ${order.status} to ${nextStatus}`, 'INVALID_ORDER_TRANSITION');
    }
    return this.db.order.update({ where: { id: orderId }, data: { status: nextStatus } });
  }

  submitOrder(orderId: string) {
    return this.submitClaimedOrder(orderId, false);
  }

  retryOrderSubmission(orderId: string) {
    return this.submitClaimedOrder(orderId, true);
  }

  private async submitClaimedOrder(orderId: string, isAdminRetry: boolean) {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (isAdminRetry) {
      if (order.status !== 'FAILED' || order.submissionResult !== 'KNOWN_FAILURE') {
        throw new OrderEngineError('Only safely failed orders can be retried', 'ORDER_RETRY_NOT_SAFE', 409);
      }
      const issues = await this.validateOrder(orderId);
      if (issues.length > 0) throw new OrderEngineError(issues[0]!.message, issues[0]!.code);
    } else {
      if (order.status !== 'CONFIRMED' || order.confirmationStatus !== 'CONFIRMED') {
        throw new OrderEngineError('Order must be explicitly confirmed before submission', 'ORDER_NOT_CONFIRMED');
      }
      const issues = await this.validateOrder(orderId);
      if (issues.length > 0) {
        if (issues.some((issue) => issue.code === 'PRICE_CHANGED')) {
          await this.db.order.update({
            where: { id: orderId },
            data: {
              status: 'AWAITING_CONFIRMATION',
              confirmationStatus: 'PENDING',
              confirmationText: null,
              confirmedAt: null,
            },
          });
        }
        throw new OrderEngineError(issues[0]!.message, issues[0]!.code);
      }
    }

    const expectedResult = isAdminRetry ? 'KNOWN_FAILURE' : 'NOT_ATTEMPTED';
    const claimed = await this.db.order.updateMany({
      where: {
        id: orderId,
        status: isAdminRetry ? 'FAILED' : 'CONFIRMED',
        submissionResult: expectedResult,
      },
      data: {
        status: 'CONFIRMED',
        submissionResult: 'IN_PROGRESS',
        submissionAttemptedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });
    if (claimed.count !== 1) {
      throw new OrderEngineError('Order submission is already in progress or completed', 'DUPLICATE_SUBMISSION', 409);
    }
    await this.safeLog('ORDER_API_SUBMISSION_STARTED', orderId, { isAdminRetry });

    const claimedOrder = await this.getOrder(orderId);
    const settings = await this.settings.getBusinessSettings();
    try {
      const result = await this.website.submit(this.toSubmission(claimedOrder), settings);
      await this.db.$transaction(async (tx: any) => {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'SUBMITTED',
            submissionResult: 'SUCCEEDED',
            externalOrderId: result.orderId,
            externalResponse: result.rawResponse,
            failureCode: null,
            failureMessage: null,
          },
        });
        await this.log(tx, 'ORDER_API_SUBMISSION_SUCCEEDED', orderId, {
          externalOrderId: result.orderId,
        });
      });
      return this.getOrder(orderId);
    } catch (error) {
      const apiError = error instanceof WebsiteOrderApiError
        ? error
        : new WebsiteOrderApiError('Order result could not be persisted safely', 'LOCAL_PERSISTENCE_ERROR', false);
      try {
        await this.db.$transaction(async (tx: any) => {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: 'FAILED',
              submissionResult: apiError.outcomeKnown ? 'KNOWN_FAILURE' : 'UNKNOWN',
              failureCode: apiError.code,
              failureMessage: apiError.message.slice(0, 500),
              externalResponse: apiError.safeDetails ?? undefined,
            },
          });
          await this.log(tx, 'ORDER_API_SUBMISSION_FAILED', orderId, {
            code: apiError.code,
            outcomeKnown: apiError.outcomeKnown,
          });
        });
      } catch (persistenceError) {
        this.logger.warn?.(
          { orderId, errorType: persistenceError instanceof Error ? persistenceError.name : 'UnknownError' },
          'Could not persist order submission failure state',
        );
      }
      throw new OrderEngineError(
        apiError.outcomeKnown
          ? 'Order submission failed safely and may be retried by an administrator'
          : 'Order submission outcome is unknown and must not be retried automatically',
        apiError.outcomeKnown ? 'ORDER_SUBMISSION_FAILED' : 'ORDER_SUBMISSION_UNKNOWN',
        502,
      );
    }
  }

  private async requireMutableOrder(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    if (!['DRAFT', 'AWAITING_INFORMATION'].includes(order.status)) {
      throw new OrderEngineError('Order can no longer be edited', 'ORDER_NOT_EDITABLE', 409);
    }
    return order;
  }

  private async resolveCurrentItem(input: AddOrderItemInput) {
    const product = await this.db.product.findUnique({
      where: { websiteProductId: input.websiteProductId },
      include: { variations: true },
    });
    if (!product || !product.presentInFeed || !isKnownActiveProductStatus(product.productStatus)) {
      throw new OrderEngineError('Product is unavailable', 'PRODUCT_UNAVAILABLE');
    }
    const variation = input.websiteVariationId
      ? product.variations.find((item: any) => item.websiteVariationId === input.websiteVariationId)
      : product.variations.find(
          (item: any) => item.sizeName.toLowerCase() === input.size?.trim().toLowerCase(),
        );
    if (!variation || !variation.active) {
      throw new OrderEngineError('A valid available size is required', 'MISSING_OR_INVALID_SIZE');
    }
    return { product, variation };
  }

  private assertStock(product: any, variation: any, quantity: number) {
    const orderable = isVariationOrderable({
      stockQuantity: variation.stockQuantity,
      variationActive: variation.active,
      productActive: product.presentInFeed && isKnownActiveProductStatus(product.productStatus),
      isPreOrder: product.isPreOrder,
    });
    if (!orderable) throw new OrderEngineError('Selected variation is unavailable', 'PRODUCT_UNAVAILABLE');
    if (!product.isPreOrder && quantity > variation.stockQuantity) {
      throw new OrderEngineError('Requested quantity exceeds current stock', 'INSUFFICIENT_STOCK');
    }
  }

  private assertQuantity(quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new OrderEngineError('Quantity must be between 1 and 100', 'INVALID_QUANTITY');
    }
  }

  private async refreshItemPrices(orderId: string) {
    const order = await this.getOrder(orderId);
    for (const item of order.items) {
      const product = await this.db.product.findUnique({ where: { id: item.productId } });
      if (!product) continue;
      const unitPrice = getEffectiveProductPrice(product);
      await this.db.orderItem.update({
        where: { id: item.id },
        data: { unitPrice, lineTotal: unitPrice.mul(item.quantity) },
      });
    }
  }

  private async calculateOrderInTransaction(
    tx: any,
    orderId: string,
    settings: BusinessSettings,
  ) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new OrderEngineError('Order not found', 'ORDER_NOT_FOUND', 404);
    const subtotal = order.items.reduce(
      (sum: Prisma.Decimal, item: any) => sum.add(item.lineTotal),
      money(0),
    );
    const totalQuantity = order.items.reduce((sum: number, item: any) => sum + item.quantity, 0);
    const deliveryCharge = order.deliveryLocation === 'DHAKA'
      ? money(settings.deliveryChargeDhaka)
      : order.deliveryLocation === 'OUTSIDE_DHAKA'
        ? money(settings.deliveryChargeOutsideDhaka)
        : money(0);
    return tx.order.update({
      where: { id: orderId },
      data: {
        subtotal,
        deliveryCharge,
        totalAmount: subtotal.add(deliveryCharge),
        totalQuantity,
      },
    });
  }

  private snapshot(value: unknown): OrderCustomerSnapshot {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    return {
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null,
      phone: typeof record.phone === 'string' && record.phone.trim() ? record.phone.trim() : null,
      address: typeof record.address === 'string' && record.address.trim() ? record.address.trim() : null,
    };
  }

  private toSubmission(order: any): WebsiteOrderSubmission {
    const customer = this.snapshot(order.customerSnapshot);
    if (!customer.name || !customer.phone || !customer.address) {
      throw new OrderEngineError('Order customer information is incomplete', 'MISSING_CUSTOMER_INFORMATION');
    }
    return {
      submissionReference: order.submissionReference,
      totalQuantity: order.totalQuantity,
      subtotal: order.subtotal.toFixed(2),
      deliveryCharge: order.deliveryCharge.toFixed(2),
      customer: { name: customer.name, phone: customer.phone, address: customer.address },
      items: order.items.map((item: any) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
        websiteProductId: item.websiteProductId,
        websiteVariationId: item.websiteVariationId,
        variationSize: item.variationSize,
      })),
    };
  }

  private log(tx: any, type: string, orderId: string, metadata: Record<string, unknown> = {}) {
    return tx.systemLog.create({
      data: {
        level: 'INFO',
        type,
        event: type,
        module: 'orders',
        message: type.replaceAll('_', ' ').toLowerCase(),
        metadata: { orderId, ...metadata },
      },
    });
  }

  private async safeLog(type: string, orderId: string, metadata: Record<string, unknown> = {}) {
    try {
      await this.log(this.db, type, orderId, metadata);
    } catch (error) {
      this.logger.warn?.(
        { orderId, errorType: error instanceof Error ? error.name : 'UnknownError' },
        'Could not persist order event log',
      );
    }
  }
}
