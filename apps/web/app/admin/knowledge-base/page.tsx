'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminAccess } from '../_components/admin-access';
import { adminRequest, useAdminPassword } from '../_lib/admin-client';

const MAX_CONTENT_LENGTH = 100_000;

type Notice = { type: 'success' | 'error'; text: string } | null;
interface KnowledgeBaseData {
  content: string;
  version: number;
  updatedAt: string;
}

export default function KnowledgeBasePage() {
  const { password, setPassword, hydrated } = useAdminPassword();
  const [content, setContent] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const autoLoadAttempted = useRef(false);

  const loadKnowledgeBase = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setNotice(null);
    try {
      const response = await adminRequest<{ success: true; data: KnowledgeBaseData | null }>(
        '/admin/knowledge-base',
        password,
      );
      setContent(response.data?.content ?? '');
      setVersion(response.data?.version ?? null);
      setUpdatedAt(response.data?.updatedAt ?? null);
      if (!response.data) setNotice({ type: 'error', text: 'No active Knowledge Base exists yet.' });
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not load the Knowledge Base.',
      });
    } finally {
      setLoading(false);
    }
  }, [password]);

  useEffect(() => {
    if (!hydrated || autoLoadAttempted.current) return;
    autoLoadAttempted.current = true;
    if (password) void loadKnowledgeBase();
  }, [hydrated, password, loadKnowledgeBase]);

  async function saveKnowledgeBase() {
    if (!content.trim()) {
      setNotice({ type: 'error', text: 'Knowledge Base content cannot be empty.' });
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const response = await adminRequest<{
        success: true;
        message: string;
        data: KnowledgeBaseData;
      }>('/admin/knowledge-base', password, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      setContent(response.data.content);
      setVersion(response.data.version);
      setUpdatedAt(response.data.updatedAt);
      setNotice({ type: 'success', text: response.message });
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not save the Knowledge Base.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="mb-8 max-w-3xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-800">
          AI instructions
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-950">Knowledge Base</h1>
        <p className="mt-4 text-base leading-7 text-stone-600">
          Write persona, language, sales, delivery, return, FAQ and escalation instructions here.
          Live product names, prices, sizes and stock always come from the product database—not this text.
        </p>
      </div>

      <AdminAccess
        password={password}
        onPasswordChange={setPassword}
        onLoad={() => void loadKnowledgeBase()}
        loading={loading}
      />

      <section className="mt-6 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-8">
        <div className="mb-4 flex flex-col gap-2 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>Version: {version ?? '—'}</span>
            <span>
              Last updated:{' '}
              {updatedAt ? new Date(updatedAt).toLocaleString() : '—'}
            </span>
          </div>
          <span>{content.length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()} characters</span>
        </div>

        <label htmlFor="knowledge-content" className="sr-only">
          Knowledge Base content
        </label>
        <textarea
          id="knowledge-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={MAX_CONTENT_LENGTH}
          spellCheck
          placeholder="Enter Alzeena Fashion's AI persona, business rules, FAQ and policies…"
          className="min-h-[34rem] w-full resize-y rounded-2xl border border-stone-300 bg-stone-50 p-5 font-mono text-[15px] leading-7 text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-amber-700 focus:bg-white focus:ring-4 focus:ring-amber-700/10"
        />

        <div className="mt-5 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite">
            {notice ? (
              <p
                className={`text-sm font-medium ${notice.type === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
              >
                {notice.text}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void saveKnowledgeBase()}
            disabled={saving || loading || !password || !content.trim()}
            className="rounded-xl bg-amber-800 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Knowledge Base'}
          </button>
        </div>
      </section>
    </main>
  );
}
