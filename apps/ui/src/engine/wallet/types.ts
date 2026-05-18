import type React from 'react';

export interface WalletImportContextUser {
  email: string | null;
  phoneNumber: string | null;
  name: string;
}

export interface WalletImportContext {
  user: WalletImportContextUser;
  networkId: string | null;
  domainId: string | null;
  schema: Record<string, unknown> | null;
  formData: Record<string, unknown> | null;
}

export interface WalletImportResult {
  data: Record<string, unknown>;
  candidates?: Record<string, unknown>;
  rawPayload?: unknown;
  metadata?: Record<string, unknown>;
  providerName: string;
  providerLabel: string;
  summary?: string;
}

export interface WalletImportProviderProps {
  context: WalletImportContext;
  onSuccess: (result: WalletImportResult) => void;
  onCancel: () => void;
}

export interface WalletProvider {
  name: string;
  label: string;
  description: string;
  component: React.ComponentType<WalletImportProviderProps>;
  isConfigured: () => boolean;
  getConfigurationHint?: () => string;
}
