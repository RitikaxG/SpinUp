import { NextResponse } from "next/server";
import { checkAndScaleUp, reconcileWarmPool, terminatingUnhealthyInstances } from "../../../../../services/asgManager";

export async function POST(req: Request){
    const secret = req.headers.get("x-internal-secret");
    if(secret != process.env.INTERNAL_CRON_SECRET){
        return NextResponse.json({
            error : "Unauthorised"
        },{
            status : 401
        })
    }

    await terminatingUnhealthyInstances();
    await reconcileWarmPool();
    await checkAndScaleUp();

    return NextResponse.json({
        ok : true,
        message : "Warm pool reconciled"
    })
}