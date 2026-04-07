import { NextRequest, NextResponse } from "next/server";
import { reconcileAutoScaling } from "../../../../../services/asgManager";

const INTERNAL_SECRET_HEADER = "x-internal-secret";

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.INTERNAL_CRON_SECRET;
  const providedSecret = req.headers.get(INTERNAL_SECRET_HEADER);

  if (!expectedSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: "INTERNAL_CRON_SECRET is not configured",
      },
      { status: 500 }
    );
  }

  if (providedSecret !== expectedSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized",
      },
      { status: 401 }
    );
  }

  try {
    const result = await reconcileAutoScaling();

    return NextResponse.json(
      {
        ok: true,
        message: "Autoscaling reconciliation completed",
        result,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Unknown autoscaling reconciliation error",
      },
      { status: 500 }
    );
  }
}