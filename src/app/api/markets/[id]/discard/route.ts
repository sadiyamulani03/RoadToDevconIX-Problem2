import { createDiscardMarketHandler } from "@/lib/api/handlers";
import { getMarketService } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createDiscardMarketHandler({ getService: getMarketService });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return handler(request, id);
}
