import { createGenerateDraftHandler } from "@/lib/api/handlers";
import { getMarketService } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createGenerateDraftHandler({ getService: getMarketService });

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
