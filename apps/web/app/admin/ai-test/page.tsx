'use client';

import { FormEvent, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

type ChatItem = { role: 'user' | 'assistant'; content: string; detail?: string };
type ChatResult = {
  conversationId: string;
  reply: string;
  intent: string;
  confidence: number;
  requiresHuman: boolean;
  action: string | null;
};

export default function AiTestPage() {
  const { password, setPassword } = useAdminPassword();
  const [platformUserId, setPlatformUserId] = useState('admin-test-user');
  const [conversationId, setConversationId] = useState<string>();
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [startNew, setStartNew] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!password || !message.trim() || !platformUserId.trim()) return;
    const text = message.trim();
    setMessage('');
    setSending(true);
    setError('');
    setHistory((items) => [...items, { role: 'user', content: text }]);
    try {
      const response = await adminRequest<{ success: true; data: ChatResult }>(
        '/ai/chat',
        password,
        {
          method: 'POST',
          body: JSON.stringify({
            customer: { platform: 'test', platformUserId: platformUserId.trim() },
            channel: 'test',
            message: text,
            ...(conversationId && !startNew ? { conversationId } : {}),
            newConversation: startNew,
          }),
        },
      );
      setConversationId(response.data.conversationId);
      setStartNew(false);
      setHistory((items) => [
        ...items,
        {
          role: 'assistant',
          content: response.data.reply,
          detail: `${response.data.intent} · ${Math.round(response.data.confidence * 100)}% · ${response.data.requiresHuman ? 'handover required' : 'AI handling'}${response.data.action ? ` · ${response.data.action}` : ''}`,
        },
      ]);
    } catch (caught) {
      setHistory((items) => items.slice(0, -1));
      setMessage(text);
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

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="mb-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">Persistent memory</p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-950">AI conversation test</h1>
        <p className="mt-4 text-stone-600">Test follow-up questions against persisted customer, conversation and product context.</p>
      </div>
      <AdminAccess password={password} onPasswordChange={setPassword} onLoad={() => undefined} loading={false} />

      <section className="mt-6 overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-stone-200 p-5 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm font-medium text-stone-700">
            Platform user ID
            <input value={platformUserId} onChange={(event) => setPlatformUserId(event.target.value)} className="mt-2 w-full rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 outline-none focus:border-amber-700" />
          </label>
          <button type="button" onClick={newConversation} className="rounded-xl border border-stone-300 px-5 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50">New conversation</button>
        </div>
        <div className="border-b border-stone-100 bg-stone-50 px-5 py-3 text-xs text-stone-500">
          Conversation: <span className="font-mono text-stone-700">{conversationId ?? (startNew ? 'new conversation queued' : 'automatic active conversation')}</span>
        </div>
        <div className="min-h-96 space-y-4 p-5 sm:p-8">
          {history.length === 0 ? <p className="pt-28 text-center text-sm text-stone-400">Start with a product question, then ask “M size আছে?” or “একটা দেন”.</p> : null}
          {history.map((item, index) => (
            <div key={index} className={`max-w-[85%] rounded-2xl px-4 py-3 ${item.role === 'user' ? 'ml-auto bg-stone-900 text-white' : 'bg-amber-50 text-stone-900'}`}>
              <p className="whitespace-pre-wrap leading-6">{item.content}</p>
              {item.detail ? <p className="mt-2 text-xs text-amber-800">{item.detail}</p> : null}
            </div>
          ))}
        </div>
        <form onSubmit={(event) => void send(event)} className="border-t border-stone-200 p-5">
          <div className="flex gap-3">
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Type a message…" maxLength={4000} className="min-w-0 flex-1 rounded-xl border border-stone-300 px-4 py-3 outline-none focus:border-amber-700" />
            <button disabled={sending || !password || !message.trim()} className="rounded-xl bg-amber-800 px-6 py-3 font-semibold text-white disabled:opacity-50">{sending ? 'Sending…' : 'Send'}</button>
          </div>
          {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}
