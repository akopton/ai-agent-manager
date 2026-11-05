import { NextResponse, type NextProxy } from 'next/server';
import { isLoopbackHost } from '@/lib/server/request-guard';

/**
 * Pages show local repository paths, so every request must be addressed to a loopback host. This
 * blocks DNS-rebinding pages from reading the app. API routes repeat the check for mutations.
 */
export const proxy: NextProxy = (request) =>
  isLoopbackHost(request.headers.get('host'))
    ? NextResponse.next()
    : new NextResponse('Requests must be addressed to the local application.', { status: 403 });
