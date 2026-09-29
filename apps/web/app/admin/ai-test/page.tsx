'use client';

import { ChangeEvent, FormEvent, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type Match = {
  productId: number;
  score: number;
  reasons: string[];
  product: {
    productName: string;
    productCode: string;
    sellPrice: string;
    discountPrice: string | null;
    flashSellPrice: string | null;
    isPreOrder: boolean;
  };
  availability: {
    sizes: Array<{ sizeName: string; stock: number; availabilityType: string }>;
  };
};
type ImageRecognition = {
  analysisStatus: string;
  confidenceLevel: string;
  matches: Match[];
  selectedProduct: Match | null;
};
type ChatItem = {
  role: 'user' | 'assistant';
  content: string;
  detail?: string;
  imagePreview?: string;
  recognition?: ImageRecognition;
};
type ChatResult = {
  conversationId: string;
  reply: string;
  intent: string;
  confidence: number;
  requiresHuman: boolean;
  action: string | null;
  imageRecognition?: ImageRecognition;
};
type Upload = { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; preview: string };

function activePrice(match: Match): string {
  return match.product.flashSellPrice && Number(match.product.flashSellPrice) > 0
    ? match.product.flashSellPrice
    : match.product.discountPrice && Number(match.product.discountPrice) > 0
      ? match.product.discountPrice
      : match.product.sellPrice;
}

export default function AiTestPage() {
  const { password, setPassword } = useAdminPassword();
  const [platformUserId, setPlatformUserId] = useState('admin-test-user');
  const [conversationId, setConversationId] = useState<string>();
  const [message, setMessage] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [upload, setUpload] = useState<Upload>();
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [startNew, setStartNew] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Image must be 10 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const preview = String(reader.result);
      setUpload({
        data: preview.slice(preview.indexOf(',') + 1),
        mimeType: file.type as Upload['mimeType'],
        preview,
      });
      setImageUrl('');
      setError('');
    };
    reader.readAsDataURL(file);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    const url = imageUrl.trim();
    if (!password || (!text && !upload && !url) || !platformUserId.trim()) return;
    const preview = (upload?.preview ?? url) || undefined;
    setSending(true);
    setError('');
    setHistory((items) => [
      ...items,
      { role: 'user', content: text || 'Product image', imagePreview: preview },
    ]);
    try {
      const image = upload
        ? {
            type: 'image',
            data: upload.data,
            mimeType: upload.mimeType,
            source: 'admin_upload',
          }
        : url
          ? { type: 'image', url, source: 'admin_url' }
          : undefined;
      const response = await adminRequest<{ success: true; data: ChatResult }>(
        '/ai/chat',
        password,
        {
          method: 'POST',
          body: JSON.stringify({
            customer: { platform: 'test', platformUserId: platformUserId.trim() },
            channel: 'test',
            ...(text ? { message: text } : {}),
            ...(image ? { image } : {}),
            ...(conversationId && !startNew ? { conversationId } : {}),
            newConversation: startNew,
          }),
        },
      );
      setConversationId(response.data.conversationId);
      setStartNew(false);
      setMessage('');
      setImageUrl('');
      setUpload(undefined);
      setHistory((items) => [
        ...items,
        {
          role: 'assistant',
          content: response.data.reply,
          detail: `${response.data.intent} · ${Math.round(response.data.confidence * 100)}% · ${response.data.requiresHuman ? 'handover required' : 'AI handling'}${response.data.action ? ` · ${response.data.action}` : ''}`,
          recognition: response.data.imageRecognition,
        },
      ]);
    } catch (caught) {
      setHistory((items) => items.slice(0, -1));
      setError(caught instanceof Error ? caught.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    setConversationId(undefined);
    setHistory([]);
    setStartNew(true);
    setError('');
  }

  const preview = upload?.preview ?? imageUrl.trim();

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="mb-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">Persistent multimodal memory</p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-950">AI conversation test</h1>
        <p className="mt-4 text-stone-600">Send text, a product screenshot, or both, then test product follow-up memory.</p>
      </div>
      <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => undefined} loading={false} />

      <section className="mt-6 overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-stone-200 p-5 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm font-medium text-stone-700">Platform user ID
            <input value={platformUserId} onChange={(event) => setPlatformUserId(event.target.value)} className="mt-2 w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 outline-none focus:border-amber-700" />
          </label>
          <button type="button" onClick={newConversation} className="rounded-xl border border-stone-300 px-5 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50">New conversation</button>
        </div>
        <div className="border-b border-stone-100 bg-stone-50 px-5 py-3 text-xs text-stone-500">Conversation: <span className="font-mono text-stone-700">{conversationId ?? (startNew ? 'new conversation queued' : 'automatic active conversation')}</span></div>
        <div className="min-h-96 space-y-4 p-5 sm:p-8">
          {history.length === 0 ? <p className="pt-28 text-center text-sm text-stone-400">Upload TX170, ask “এটার দাম কত?”, then follow with “M size আছে?”.</p> : null}
          {history.map((item, index) => {
            const match = item.recognition?.selectedProduct ?? item.recognition?.matches[0];
            return <div key={index} className={`max-w-[88%] rounded-2xl px-4 py-3 ${item.role === 'user' ? 'ml-auto bg-stone-900 text-white' : 'bg-amber-50 text-stone-900'}`}>
              {item.imagePreview ? <img src={item.imagePreview} alt="Customer product preview" className="mb-3 max-h-56 rounded-xl object-contain" /> : null}
              <p className="whitespace-pre-wrap leading-6">{item.content}</p>
              {item.detail ? <p className="mt-2 text-xs text-amber-800">{item.detail}</p> : null}
              {match ? <div className="mt-3 rounded-xl border border-amber-200 bg-white/80 p-3 text-xs text-stone-700">
                <p className="font-semibold">{match.product.productName} · {match.product.productCode}</p>
                <p className="mt-1">Match {Math.round(match.score * 100)}% · {match.reasons.join(', ')}</p>
                <p className="mt-1">Current price ৳{activePrice(match)} · {match.product.isPreOrder ? 'pre-order enabled' : 'regular stock'}</p>
                <p className="mt-1">Sizes: {match.availability.sizes.map((size) => `${size.sizeName} (${size.stock}, ${size.availabilityType})`).join(' · ') || 'none'}</p>
              </div> : null}
            </div>;
          })}
        </div>
        <form onSubmit={(event) => void send(event)} className="space-y-4 border-t border-stone-200 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">Image URL
              <input type="url" value={imageUrl} onChange={(event) => { setImageUrl(event.target.value); if (event.target.value) setUpload(undefined); }} placeholder="https://…/product.webp" className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            </label>
            <label className="text-sm font-medium text-stone-700">Or upload an image
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} className="mt-2 block w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm" />
            </label>
          </div>
          {preview ? <div className="flex items-start gap-3 rounded-xl bg-stone-50 p-3"><img src={preview} alt="Selected product" className="h-24 w-24 rounded-lg object-contain" /><button type="button" onClick={() => { setUpload(undefined); setImageUrl(''); }} className="text-xs font-semibold text-red-700">Remove image</button></div> : null}
          <div className="flex gap-3">
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Caption or message, e.g. এটার দাম কত?" maxLength={4000} className="min-w-0 flex-1 rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            <button disabled={sending || !password || (!message.trim() && !preview)} className="rounded-xl bg-amber-800 px-6 py-3 font-semibold text-white disabled:opacity-50">{sending ? 'Analyzing…' : 'Send'}</button>
          </div>
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}
