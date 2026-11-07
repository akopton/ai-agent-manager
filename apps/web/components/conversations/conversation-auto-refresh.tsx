'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const refreshIntervalMs = 1_500;

/**
 * While a reply is pending or being generated, re-renders the page from the server every 1.5 s.
 * The HTTP request that sent the message has already returned; the worker owns the turn.
 */
export const ConversationAutoRefresh = ({ active }: { active: boolean }) => {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => router.refresh(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
};
