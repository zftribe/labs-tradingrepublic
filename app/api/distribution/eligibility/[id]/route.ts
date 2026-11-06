import {
  SIGNATURE_HEADER,
  eligibilityHttpFromRow,
  isPostId,
  readMirrorConfig,
} from "@/lib/distribution/event";
import { readEligibilityRow } from "@/lib/distribution/runtime";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const url = new URL(request.url);
  const { id } = await context.params;
  const secret = readMirrorConfig(process.env).secret;
  if (!secret || url.search.length > 0 || !isPostId(id)) {
    return new Response(null, { status: 503, headers: NO_STORE });
  }
  const read = await readEligibilityRow(id);
  const result = eligibilityHttpFromRow({
    postId: id,
    secret,
    hasQuery: false,
    failed: read === "failed",
    row: read && read !== "failed" ? read : null,
  });
  return new Response(result.body || null, {
    status: result.status,
    headers: {
      ...NO_STORE,
      ...(result.signature
        ? {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: result.signature,
          }
        : {}),
    },
  });
}
