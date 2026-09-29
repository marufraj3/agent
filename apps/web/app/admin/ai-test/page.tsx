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
  audioPreview?: string;
  recognition?: ImageRecognition;
  transcription?: Transcription;
  diagnostic?: { entities?: Record<string, unknown>; products?: Array<{ productName: string; productCode: string }>; debug?: { latencyMs: number; model: string | null; toolCalls: Array<{ tool: string; status: string; durationMs: number }> } };
};
type Transcription = {
  text: string;
  language: string;
  confidence: number;
  duration: number | null;
};
type ChatResult = {
  conversationId: string;
  reply: string;
  intent: string;
  confidence: number;
  requiresHuman: boolean;
  action: string | null;
  entities?: Record<string, unknown>;
  products?: Array<{ productName: string; productCode: string }>;
  debug?: { latencyMs: number; model: string | null; toolCalls: Array<{ tool: string; status: string; durationMs: number }> };
  imageRecognition?: ImageRecognition;
  transcription?: Transcription;
};
type Upload = { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; preview: string };
type AudioUpload = { data: string; mimeType: string; preview: string; duration?: number };

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
  const [audioUrl, setAudioUrl] = useState('');
  const [audioUpload, setAudioUpload] = useState<AudioUpload>();
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
      setAudioUrl('');
      setAudioUpload(undefined);
      setError('');
    };
    reader.readAsDataURL(file);
  }

  function chooseAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const mimeAliases: Record<string, string> = {
      'audio/x-wav': 'audio/wav',
      'audio/wave': 'audio/wav',
      'audio/x-m4a': 'audio/m4a',
    };
    const mimeType = mimeAliases[file.type] ?? file.type;
    const supported = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/m4a'];
    if (!supported.includes(mimeType)) {
      setError('Choose an OGG, Opus, MP3, WAV, WebM, MP4 or M4A audio file.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('Audio must be 15 MB or smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const preview = String(reader.result);
      setAudioUpload({ data: preview.slice(preview.indexOf(',') + 1), mimeType, preview });
      setAudioUrl('');
      setImageUrl('');
      setUpload(undefined);
      setError('');
    };
    reader.readAsDataURL(file);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    const url = imageUrl.trim();
    const voiceUrl = audioUrl.trim();
    if (!password || (!text && !upload && !url && !audioUpload && !voiceUrl) || !platformUserId.trim()) return;
    const preview = (upload?.preview ?? url) || undefined;
    const audioPreview = (audioUpload?.preview ?? voiceUrl) || undefined;
    setSending(true);
    setError('');
    setHistory((items) => [
      ...items,
      {
        role: 'user',
        content: text || (audioPreview ? 'Voice message' : 'Product image'),
        imagePreview: preview,
        audioPreview,
      },
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
      const audio = audioUpload
        ? {
            type: 'audio',
            data: audioUpload.data,
            mimeType: audioUpload.mimeType,
            ...(audioUpload.duration ? { duration: audioUpload.duration } : {}),
            source: 'admin_upload',
          }
        : voiceUrl
          ? { type: 'audio', url: voiceUrl, source: 'admin_url' }
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
            ...(audio ? { audio } : {}),
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
      setAudioUrl('');
      setAudioUpload(undefined);
      setHistory((items) => [
        ...items,
        {
          role: 'assistant',
          content: response.data.reply,
          detail: `${response.data.intent} · ${Math.round(response.data.confidence * 100)}% · ${response.data.requiresHuman ? 'handover required' : 'AI handling'}${response.data.action ? ` · ${response.data.action}` : ''}`,
          recognition: response.data.imageRecognition,
          transcription: response.data.transcription,
          diagnostic: { entities: response.data.entities, products: response.data.products, debug: response.data.debug },
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
  const voicePreview = audioUpload?.preview ?? audioUrl.trim();

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="mb-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">Persistent multimodal memory</p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-950">AI conversation test</h1>
        <p className="mt-4 text-stone-600">Send text, a product screenshot, or a voice message, then test product follow-up memory.</p>
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
              {item.audioPreview ? <audio controls src={item.audioPreview} className="mb-3 max-w-full" /> : null}
              <p className="whitespace-pre-wrap leading-6">{item.content}</p>
              {item.transcription ? <div className="mt-3 rounded-xl border border-amber-200 bg-white/80 p-3 text-xs text-stone-700"><p className="font-semibold">Transcription</p><p className="mt-1 text-sm">{item.transcription.text}</p><p className="mt-1">{item.transcription.language} · {Math.round(item.transcription.confidence * 100)}% confidence{item.transcription.duration !== null ? ` · ${item.transcription.duration}s` : ''}</p></div> : null}
              {item.detail ? <p className="mt-2 text-xs text-amber-800">{item.detail}</p> : null}
              {item.diagnostic ? <details className="mt-3 rounded-xl border border-amber-200 bg-white/80 p-3 text-xs text-stone-700"><summary className="cursor-pointer font-semibold">AI debug</summary><p className="mt-2">Entities: {JSON.stringify(item.diagnostic.entities ?? {})}</p><p className="mt-1">Products: {item.diagnostic.products?.map((product) => `${product.productName} (${product.productCode})`).join(', ') || 'none'}</p><p className="mt-1">Model: {item.diagnostic.debug?.model ?? 'local'} · {item.diagnostic.debug?.latencyMs ?? 0}ms</p><p className="mt-1">Tools: {item.diagnostic.debug?.toolCalls.map((tool) => `${tool.tool} ${tool.status} (${tool.durationMs}ms)`).join(' · ') || 'none'}</p></details> : null}
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
              <input type="url" value={imageUrl} onChange={(event) => { setImageUrl(event.target.value); if (event.target.value) { setUpload(undefined); setAudioUrl(''); setAudioUpload(undefined); } }} placeholder="https://…/product.webp" className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            </label>
            <label className="text-sm font-medium text-stone-700">Or upload an image
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} className="mt-2 block w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm" />
            </label>
          </div>
          {preview ? <div className="flex items-start gap-3 rounded-xl bg-stone-50 p-3"><img src={preview} alt="Selected product" className="h-24 w-24 rounded-lg object-contain" /><button type="button" onClick={() => { setUpload(undefined); setImageUrl(''); }} className="text-xs font-semibold text-red-700">Remove image</button></div> : null}
          <div className="grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">Audio URL
              <input type="url" value={audioUrl} onChange={(event) => { setAudioUrl(event.target.value); if (event.target.value) { setAudioUpload(undefined); setImageUrl(''); setUpload(undefined); } }} placeholder="https://…/voice.ogg" className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            </label>
            <label className="text-sm font-medium text-stone-700">Or upload audio
              <input type="file" accept="audio/ogg,audio/opus,audio/mpeg,audio/mp3,audio/wav,audio/webm,audio/mp4,audio/m4a" onChange={chooseAudio} className="mt-2 block w-full rounded-xl border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm" />
            </label>
          </div>
          {voicePreview ? <div className="flex items-center gap-3 rounded-xl bg-stone-50 p-3"><audio controls src={voicePreview} className="max-w-full flex-1" /><button type="button" onClick={() => { setAudioUpload(undefined); setAudioUrl(''); }} className="text-xs font-semibold text-red-700">Remove voice</button></div> : null}
          <div className="flex gap-3">
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Caption or message, e.g. এটার দাম কত?" maxLength={4000} className="min-w-0 flex-1 rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            <button disabled={sending || !password || (!message.trim() && !preview && !voicePreview)} className="rounded-xl bg-amber-800 px-6 py-3 font-semibold text-white disabled:opacity-50">{sending ? 'Processing…' : 'Send'}</button>
          </div>
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}
