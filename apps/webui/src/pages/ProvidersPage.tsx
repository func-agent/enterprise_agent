import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, listModelConfigs, listProviderCredentials } from '../api';
import type { Identity, ProviderCredential, ProviderOption } from '../types';
import { ProviderManager } from '../components/ProviderManager';
import { canViewAdminPages } from '../permissions';

export function ProvidersPage({
  identity,
  onUnauthorized,
  onOpenModels,
}: {
  identity: Identity;
  onUnauthorized: () => void;
  onOpenModels: () => void;
}) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [masterKeyConfigured, setMasterKeyConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const isAdmin = canViewAdminPages(identity);

  const loadProviders = useCallback(async (): Promise<void> => {
    if (!isAdmin) {
      setProviders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = await listModelConfigs();
      setProviders(payload.providers);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [isAdmin, onUnauthorized]);

  const loadCredentials = useCallback(async (): Promise<void> => {
    setCredentialError(null);
    if (!isAdmin) {
      setCredentials([]);
      return;
    }
    try {
      const payload = await listProviderCredentials();
      setCredentials(payload.data ?? []);
      setMasterKeyConfigured(payload.masterKeyConfigured !== false);
    } catch (err) {
      setCredentialError(errorMessage(err));
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
    }
  }, [isAdmin, onUnauthorized]);

  useEffect(() => {
    void loadProviders();
    void loadCredentials();
  }, [loadProviders, loadCredentials]);

  return (
    <div className="page">
      <ProviderManager
        isAdmin={isAdmin}
        providers={providers}
        credentials={credentials}
        masterKeyConfigured={masterKeyConfigured}
        loading={loading}
        error={error}
        credentialError={credentialError}
        onUnauthorized={onUnauthorized}
        onOpenModels={onOpenModels}
        onRetry={loadProviders}
        onProvidersChanged={loadProviders}
        onCredentialsChanged={loadCredentials}
      />
    </div>
  );
}
