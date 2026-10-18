import { createGetMarketHandler, createUpdateMarketHandler } from "@/lib/api/handlers";
import { getMarketService } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getHandler = createGetMarketHandler({ getService: getMarketService });
const patchHandler = createUpdateMarketHandler({ getService: getMarketService });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return getHandler(_request, id);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return patchHandler(request, id);
}
