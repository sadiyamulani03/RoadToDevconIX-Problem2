import { createConfigHandler } from "@/lib/api/handlers";
import { getMarketService } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createConfigHandler({ getService: getMarketService });

export async function GET(): Promise<Response> {
  return handler();
}
