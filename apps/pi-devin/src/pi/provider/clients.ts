import { Effect, type Scope } from "effect";
import { makeDevinClient, type DevinClient, type DevinClientOptions } from "../../core/client.ts";
import type { DevinError } from "../../core/errors.ts";
import { createFingerprintProvider, type FingerprintProvider } from "../../core/protocol/fingerprint.ts";
import type { HTTPTransportOptions } from "../../core/protocol/http.ts";
import type { Credential } from "../../core/types.ts";
import { evictOldest } from "../auth/credential.ts";
import { catalogScope } from "../models.ts";

export interface ClientRegistryOptions {
  fetch?: typeof fetch;
  fingerprint?: (credential: Credential) => FingerprintProvider;
  http?: HTTPTransportOptions;
}

/**
 * Clients of one provider. A credential's device fingerprint is collected once and shared by its clients;
 * every open client is tracked so shutdown can stop in-flight requests.
 */
export class ClientRegistry {
  private readonly options: ClientRegistryOptions;
  private readonly fingerprints = new Map<string, FingerprintProvider>();
  private readonly clients = new Set<DevinClient>();

  constructor(options: ClientRegistryOptions) {
    this.options = options;
  }

  private fingerprintFor(credential: Credential): FingerprintProvider {
    const key = catalogScope(credential);
    let fingerprint = this.fingerprints.get(key);
    if (!fingerprint) {
      evictOldest(this.fingerprints, 16);
      fingerprint = this.options.fingerprint?.(credential) ?? createFingerprintProvider(credential.sessionToken);
      this.fingerprints.set(key, fingerprint);
    }
    return fingerprint;
  }

  /** A client for the scope's lifetime. An injected `fetch` replaces the built-in transport and its TLS options. */
  client(credential: Credential, extra: DevinClientOptions = {}): Effect.Effect<DevinClient, DevinError, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      const fetch = extra.fetch ?? this.options.fetch;
      const client = yield* makeDevinClient(credential, {
        ...extra, fingerprint: this.fingerprintFor(credential), fetch, ...(!fetch && this.options.http ? { http: this.options.http } : {}),
      });
      this.clients.add(client);
      yield* Effect.addFinalizer(() => Effect.sync(() => { this.clients.delete(client); }));
      return client;
    });
  }

  /** Closes every open client; their in-flight requests fail as closed. */
  get closeAll(): Effect.Effect<void> {
    return Effect.forEach([...this.clients], (client) => client.close, { discard: true });
  }

  get clearFingerprints(): Effect.Effect<void> {
    return Effect.sync(() => this.fingerprints.clear());
  }
}
