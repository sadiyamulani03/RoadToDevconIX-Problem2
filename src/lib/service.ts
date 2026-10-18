import { systemClock } from "./clock";
import { MarketStore } from "./db";
import { createProviderFromConfig, loadLlmConfig } from "./llm/config";
import { MarketService } from "./market-service";

/**
 * Server-side singleton wiring. Credentials are read exclusively from
 * server-side environment variables; nothing here is imported by client
 * components.
 */

interface Cache {
  store: MarketStore;
  service: MarketService;
}

const globalCache = globalThis as typeof globalThis & {
  __headlineToMarketCache?: Cache;
};

export function getMarketStore(): MarketStore {
  if (!globalCache.__headlineToMarketCache) {
    const filename = process.env.DATABASE_PATH?.trim() || "./.data/markets.db";
    const store = new MarketStore(filename);
    const config = loadLlmConfig();
    const provider = createProviderFromConfig(config);
    globalCache.__headlineToMarketCache = {
      store,
      service: new MarketService({ store, provider, clock: systemClock }),
    };
  }
  return globalCache.__headlineToMarketCache.store;
}

export function getMarketService(): MarketService {
  if (!globalCache.__headlineToMarketCache) {
    getMarketStore();
  }
  return globalCache.__headlineToMarketCache!.service;
}
