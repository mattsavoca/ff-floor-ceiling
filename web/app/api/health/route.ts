import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "floor-ceiling-web",
    version: "0.1.0",
    publicDemo: true,
    persistentWorker: false,
    timestamp: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
