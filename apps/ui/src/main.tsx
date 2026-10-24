import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';
import { purgeLegacyAuthStorage } from '@/lib/purge-legacy-auth-storage';
import { sweepLegacyMatchScoreCache } from '@/utils/match-score-cache';
import { App } from './app';
import '@/components/wallet/providers';
import './i18n';
import './index.css';

// One-time cleanup of pre-v2 (0-10 scale) cached match scores. localStorage
// has no expiry and nothing reads a v1 key, so they would otherwise stay forever.
sweepLegacyMatchScoreCache();

// Clear access/refresh tokens an older build left in browser storage. Nothing
// reads them, and they would otherwise sit readable by any script on the origin.
purgeLegacyAuthStorage();

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
