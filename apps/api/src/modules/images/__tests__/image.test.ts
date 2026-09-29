import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../../ai/providers/ai-provider.js';
import type {
  CatalogSearchProduct,
  ProductCatalogService,
} from '../../products/product-catalog.service.js';
import {
  ImageAnalysisError,
  ImageAnalysisService,
  parseImageAnalysis,
} from '../image-analysis.service.js';
import { ImageProductService } from '../image-product.service.js';
import { ImageService } from '../image.service.js';
import type { ImageAnalysis, PreparedImage } from '../image.types.js';
import { ImageValidationError, ImageValidationService } from '../image-validation.service.js';
import { ProductMatchingService } from '../product-matching.service.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const webp = Buffer.from('RIFF1234WEBPdata', 'ascii');

const validation = new ImageValidationService(10);

test('validates JPEG, PNG and WebP image signatures', () => {
  assert.equal(validation.validateBuffer(jpeg, 'image/jpeg'), 'image/jpeg');
  assert.equal(validation.validateBuffer(png, 'image/png'), 'image/png');
  assert.equal(validation.validateBuffer(webp, 'image/webp'), 'image/webp');
});

test('rejects unsupported and mismatched image files', () => {
  assert.throws(
    () => validation.validateBuffer(Buffer.from('GIF89a'), 'image/gif'),
    (error: unknown) => error instanceof ImageValidationError && error.code === 'UNSUPPORTED_IMAGE_TYPE',
  );
  assert.throws(
    () => validation.validateBuffer(png, 'image/jpeg'),
    (error: unknown) => error instanceof ImageValidationError && error.code === 'INVALID_IMAGE',
  );
});

test('rejects oversized image data', () => {
  const smallLimit = new ImageValidationService(0.000003);
  assert.throws(
    () => smallLimit.validateBuffer(jpeg, 'image/jpeg'),
    (error: unknown) => error instanceof ImageValidationError && error.code === 'IMAGE_TOO_LARGE',
  );
});

test('downloads a public image once, validates it and reuses the URL cache', async () => {
  let fetches = 0;
  const service = new ImageService(
    validation,
    1_000,
    (async () => {
      fetches += 1;
      return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch,
    async () => ['93.184.216.34'],
  );
  const input = {
    type: 'image' as const,
    url: 'https://example.com/product.jpg',
    mimeType: 'image/jpeg' as const,
    source: 'test',
  };
  const first = await service.prepare(input);
  const second = await service.prepare(input);
  assert.equal(first.mimeType, 'image/jpeg');
  assert.equal(first.sha256, second.sha256);
  assert.equal(fetches, 1);
});

test('blocks private image URLs before fetching', async () => {
  const service = new ImageService(validation, 1_000, fetch, async () => ['127.0.0.1']);
  await assert.rejects(
    service.prepare({ type: 'image', url: 'http://example.com/image.jpg', source: 'test' }),
    (error: unknown) => error instanceof ImageValidationError && error.code === 'INVALID_IMAGE_URL',
  );
});

const validAnalysis: ImageAnalysis = {
  productName: 'TX170 Messi Fan Edition Polo',
  productCode: 'TX170',
  brand: 'Adidas',
  category: 'Mens Fashion',
  subCategory: 'Polo',
  color: 'Blue',
  visibleText: ['TX170', 'Messi'],
  designKeywords: ['Argentina', 'Messi'],
  sizeVisible: 'M',
  priceVisible: '৳1250',
  confidence: 0.95,
};
const prepared: PreparedImage = {
  data: jpeg,
  base64: jpeg.toString('base64'),
  mimeType: 'image/jpeg',
  sizeBytes: jpeg.length,
  sha256: 'image-hash',
  source: 'test',
  temporary: true,
};

test('parses a structured Gemini image analysis response', async () => {
  const provider = {
    name: 'gemini',
    model: 'test',
    generateStructured: async () => ({ text: '{}', model: 'test' }),
    analyzeImage: async () => ({ text: JSON.stringify(validAnalysis), model: 'test' }),
  } satisfies AIProvider;
  const result = await new ImageAnalysisService(provider).analyze(prepared, 'এটার দাম কত?');
  assert.equal(result.productCode, 'TX170');
  assert.equal(result.priceVisible, '৳1250');
  assert.deepEqual(parseImageAnalysis(`\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``), validAnalysis);
});

test('rejects invalid Gemini image JSON instead of guessing', async () => {
  const provider = {
    name: 'gemini',
    model: 'test',
    generateStructured: async () => ({ text: '{}', model: 'test' }),
    analyzeImage: async () => ({ text: '{"productCode":"TX170"}', model: 'test' }),
  } satisfies AIProvider;
  await assert.rejects(
    new ImageAnalysisService(provider).analyze(prepared),
    (error: unknown) => error instanceof ImageAnalysisError,
  );
});

function product(id: number, name: string, code: string): CatalogSearchProduct {
  return {
    id,
    internalId: `internal-${id}`,
    productName: name,
    productCode: code,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    productDetails: 'Adidas Argentina Messi design',
    productStatus: '1',
    active: true,
    sellPrice: id === 6238 ? '1250.00' : '900.00',
    discountPrice: id === 6238 ? '990.00' : null,
    flashSellPrice: null,
    isPreOrder: id === 6238,
    image: null,
    color: 'Blue',
    category: 'Mens Fashion',
    subCategory: 'Polo',
    variations: [],
  };
}

function catalogFor(products: CatalogSearchProduct[]) {
  return {
    searchProducts: async (query: string) => {
      const normalized = query.toLowerCase();
      return products.filter((item) =>
        `${item.productName} ${item.productCode} ${item.color} ${item.category} ${item.subCategory}`
          .toLowerCase()
          .includes(normalized),
      );
    },
    getProductsWithAvailability: async (ids: number[]) =>
      ids.flatMap((id) => {
        const item = products.find((candidate) => candidate.id === id);
        return item
          ? [
              {
                product: item,
                availability: {
                  id,
                  productName: item.productName,
                  productCode: item.productCode,
                  productStatus: item.productStatus,
                  active: true,
                  presentInFeed: true,
                  isPreOrder: item.isPreOrder,
                  sizes: [
                    {
                      websiteVariationId: 1,
                      websiteSizeId: 2,
                      sizeName: 'M',
                      stock: item.id === 6238 ? 24 : 0,
                      active: true,
                      orderable: item.isPreOrder || item.id === 6238,
                      availabilityType: item.isPreOrder ? ('in_stock' as const) : ('unavailable' as const),
                    },
                  ],
                },
              },
            ]
          : [];
      }),
  } as unknown as ProductCatalogService;
}

test('selects an exact product code and returns current DB price, stock and pre-order facts', async () => {
  const matching = new ProductMatchingService(
    catalogFor([product(6238, 'TX170 Messi Fan Edition Polo', 'TX170 Argentina')]),
    0.85,
    0.65,
  );
  const result = await matching.match({ productCode: 'TX170' });
  assert.equal(result.selectedProduct?.productId, 6238);
  assert.ok(result.selectedProduct?.reasons.includes('product_code_exact'));
  assert.equal(result.selectedProduct?.product.discountPrice, '990.00');
  assert.equal(result.selectedProduct?.availability.sizes[0]?.stock, 24);
  assert.equal(result.selectedProduct?.availability.isPreOrder, true);
});

test('matches an exact product name', async () => {
  const matching = new ProductMatchingService(
    catalogFor([product(6238, 'TX170 Messi Fan Edition Polo', 'TX170 Argentina')]),
    0.85,
    0.65,
  );
  const result = await matching.match({ productName: 'TX170 Messi Fan Edition Polo' });
  assert.equal(result.selectedProduct?.productId, 6238);
  assert.ok(result.selectedProduct?.reasons.includes('product_name_exact'));
});

test('returns multiple medium-confidence candidates without blindly selecting one', async () => {
  const products = [
    product(6201, 'Messi Fan Polo Edition', 'AA100 Blue'),
    product(6202, 'Messi Fan Polo Classic', 'AA101 Blue'),
  ];
  const matching = new ProductMatchingService(catalogFor(products), 0.9, 0.65);
  const result = await matching.match({ productName: 'Messi Fan Polo' });
  assert.equal(result.confidenceLevel, 'medium');
  assert.equal(result.selectedProduct, null);
  assert.equal(result.matches.length, 2);
});

test('returns low confidence and no product when clues do not support a match', async () => {
  const matching = new ProductMatchingService(
    catalogFor([product(6238, 'TX170 Messi Fan Edition Polo', 'TX170 Argentina')]),
    0.85,
    0.65,
  );
  const result = await matching.match({ color: 'Blue' }, 0.3);
  assert.equal(result.confidenceLevel, 'low');
  assert.equal(result.selectedProduct, null);
  assert.deepEqual(result.matches, []);
});

test('Gemini failure falls back to caption matching without crashing', async () => {
  const imageService = { prepare: async () => prepared } as unknown as ImageService;
  const analysis = {
    analyze: async () => {
      throw new ImageAnalysisError('provider unavailable');
    },
  } as unknown as ImageAnalysisService;
  const matching = new ProductMatchingService(
    catalogFor([product(6238, 'TX170 Messi Fan Edition Polo', 'TX170 Argentina')]),
    0.85,
    0.65,
  );
  const result = await new ImageProductService(imageService, analysis, matching).identify(
    { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg', source: 'test' },
    'এটার দাম কত?',
  );
  assert.equal(result.analysisStatus, 'unavailable');
  assert.equal(result.confidenceLevel, 'low');
  assert.equal(result.selectedProduct, null);
});
