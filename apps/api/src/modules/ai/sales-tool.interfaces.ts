import type { ActiveKnowledgeBase } from '../admin/knowledge-base.service.js';
import type { BusinessSettings } from '../admin/settings.service.js';
import type { HumanHandoverService } from '../handovers/human-handover.service.js';
import type { OrderService } from '../orders/order.service.js';
import type { ProductCatalogService } from '../products/product-catalog.service.js';
import type { ConversationMemoryContext } from '../conversations/conversation-context.service.js';

/** Permission-bounded interfaces are the only business capabilities exposed to orchestration. */
export interface KnowledgeTool { getActiveKnowledgeBase(): Promise<ActiveKnowledgeBase | null>; }
export interface SettingsTool { getBusinessSettings(): Promise<BusinessSettings>; }
export type ProductReadTool = Pick<ProductCatalogService, 'searchProducts' | 'recommendProducts' | 'getProductByWebsiteId' | 'getProductsWithAvailability' | 'getProductAvailability'>;
export interface ConversationContextTool { buildContext(conversationId: string, options?: { excludeMessageId?: string; maxProductIds?: number }): Promise<ConversationMemoryContext | null>; }
export type DraftOrderTool = Pick<OrderService, 'getActiveOrderForConversation' | 'getOrder' | 'getRecentOrdersForCustomer' | 'resumeAbandonedOrder' | 'createDraftOrder' | 'addOrderItem' | 'updateOrderItem' | 'removeOrderItem' | 'updateCustomerInformation' | 'setDeliveryLocation' | 'updateDraftContext' | 'validateOrder' | 'calculateOrder' | 'requestConfirmation' | 'reopenForCorrection' | 'confirmOrder' | 'cancelOrder' | 'submitOrder'>;
export type HandoverTool = Pick<HumanHandoverService, 'requestHandover'>;
