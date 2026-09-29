/** Produces text only from already-calculated database metrics; it never asks a model to invent statistics. */
export class SalesInsightService {
  summarize(overview: any, trends: any): string[] {
    const insights: string[] = [];
    const searched = trends.topSearchedProducts[0];
    if (searched && searched.searched > 0) insights.push(`${searched.productCode} was searched ${searched.searched} times in the selected period.`);
    const size = trends.commonRequestedSizes[0];
    if (size) insights.push(`${size.size} was the most frequently requested size (${size.count} checks).`);
    const category = trends.popularCategories[0];
    if (category) insights.push(`${category.category} had the most recorded product interest (${category.count} events).`);
    if (overview.recommendationUsage > 0) insights.push(`${overview.recommendationToOrder} of ${overview.recommendationUsage} conversations with recommendations reached a submitted or completed order.`);
    if (overview.abandonedOrders > 0) insights.push(`${overview.abandonedOrders} orders were recorded as abandoned in the selected period.`);
    return insights;
  }
}
