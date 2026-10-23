import { describe, expect, it, vi } from 'vitest';
import type { MCPServerID } from '../../types';
import type { Database } from '../client';
import { sealBoundSecret } from '../oauth-secret-envelope';
import {
  dcrRegistrationBinding,
  MCPOAuthClientRegistrationRepository,
} from './mcp-oauth-client-registrations';

describe('MCPOAuthClientRegistrationRepository.invalidateIfCurrentMatchesClientId', () => {
  const masterSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const tenantId = 'test-tenant';
  const serverId = 'test-server' as MCPServerID;
  const registrationId = 'reg-12345';
  const bindingFingerprint = 'fingerprint-abc';

  function createSealedMaterial(clientId: string, secret = masterSecret) {
    const binding = dcrRegistrationBinding({
      tenantId,
      mcpServerId: serverId,
      registrationId,
      bindingFingerprint,
    });
    return sealBoundSecret(JSON.stringify({ clientId }), secret, 'dcr-client', binding);
  }

  it('returns true and invalidates when the current registration’s client_id matches', async () => {
    const clientId = 'client-matching-123';
    const sealedMaterial = createSealedMaterial(clientId);

    let callCount = 0;
    const execute = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve([
          {
            registration_id: registrationId,
            binding_fingerprint: bindingFingerprint,
            sealed_material: sealedMaterial,
          },
        ]);
      }
      return Promise.resolve([{ registration_id: registrationId }]);
    });

    const mockDb = { execute } as unknown as Database;
    const repo = new MCPOAuthClientRegistrationRepository(mockDb);

    const result = await repo.invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId,
      masterSecret,
    });

    expect(result).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns false and does nothing when the current registration has a different client_id', async () => {
    const sealedMaterial = createSealedMaterial('client-different-456');

    const execute = vi.fn().mockResolvedValue([
      {
        registration_id: registrationId,
        binding_fingerprint: bindingFingerprint,
        sealed_material: sealedMaterial,
      },
    ]);

    const mockDb = { execute } as unknown as Database;
    const repo = new MCPOAuthClientRegistrationRepository(mockDb);

    const result = await repo.invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'client-expected-123',
      masterSecret,
    });

    expect(result).toBe(false);
    // Only the SELECT query should have run, no UPDATE
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns false when there is no current registration', async () => {
    const execute = vi.fn().mockResolvedValue([]);

    const mockDb = { execute } as unknown as Database;
    const repo = new MCPOAuthClientRegistrationRepository(mockDb);

    const result = await repo.invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'client-123',
      masterSecret,
    });

    expect(result).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns false (does not throw) when decryption fails', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        registration_id: registrationId,
        binding_fingerprint: bindingFingerprint,
        sealed_material: 'corrupted-invalid-sealed-payload',
      },
    ]);

    const mockDb = { execute } as unknown as Database;
    const repo = new MCPOAuthClientRegistrationRepository(mockDb);

    const result = await repo.invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'client-123',
      masterSecret,
    });

    expect(result).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns false when master secret is missing', async () => {
    const execute = vi.fn();
    const mockDb = { execute } as unknown as Database;
    const repo = new MCPOAuthClientRegistrationRepository(mockDb);

    const oldSecret = process.env.AGOR_MASTER_SECRET;
    delete process.env.AGOR_MASTER_SECRET;

    try {
      const result = await repo.invalidateIfCurrentMatchesClientId({
        tenantId,
        serverId,
        clientId: 'client-123',
        masterSecret: undefined,
      });

      expect(result).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (oldSecret !== undefined) {
        process.env.AGOR_MASTER_SECRET = oldSecret;
      }
    }
  });
});
