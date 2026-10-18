import { createListMarketsHandler } from "@/lib/api/handlers";
import { getMarketService } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createListMarketsHandler({ getService: getMarketService });

export async function GET(): Promise<Response> {
  return handler();
}
